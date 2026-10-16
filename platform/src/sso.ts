// Single sign-on with the organization's identity provider over OpenID Connect (Google Workspace,
// Microsoft Entra ID, Okta, ...). Only people whose verified email is in an allowed domain get in;
// they are added as members on their first sign-in. Password sign-in can stay on for admins only,
// as a way in when the identity provider is down or misconfigured.

import { config } from "./config.ts";
import { randomToken } from "./crypto.ts";
import { pkcePair } from "./oauth.ts";
import { getSetting, putSetting } from "./settings.ts";

export interface SsoConfig {
	enabled: boolean;
	/** Shown on the button: "Sign in with <label>". */
	label: string;
	issuer: string;
	clientId: string;
	clientSecret: string;
	/** Email domains allowed in, e.g. ["acme.com"]. */
	domains: string[];
	/** "admins": password sign-in only for admins (break-glass). "all": everyone may still use a password. */
	passwordLogin: "all" | "admins";
}

export type SsoSettingsView = Omit<SsoConfig, "clientSecret"> & { hasSecret: boolean; redirectUri: string };

export class SsoError extends Error {}

const KEY = "sso";

export function ssoRedirectUri(): string {
	return `${config.publicUrl}/auth/sso/callback`;
}

export async function getSso(): Promise<SsoConfig | undefined> {
	return getSetting<SsoConfig>(KEY);
}

export async function ssoView(): Promise<SsoSettingsView | null> {
	const sso = await getSso();
	if (!sso) return null;
	const { clientSecret, ...rest } = sso;
	return { ...rest, hasSecret: Boolean(clientSecret), redirectUri: ssoRedirectUri() };
}

function normalizeDomains(value: unknown): string[] {
	const list = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
	return [...new Set(list.map((d) => String(d).trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
}

/** Saves the settings. An empty secret keeps the stored one. Enabling checks the provider's discovery document first. */
export async function saveSso(input: Partial<SsoConfig>): Promise<SsoSettingsView> {
	const current = await getSso();
	const next: SsoConfig = {
		enabled: Boolean(input.enabled),
		label: String(input.label ?? "").trim() || "SSO",
		issuer: String(input.issuer ?? "").trim().replace(/\/+$/, ""),
		clientId: String(input.clientId ?? "").trim(),
		clientSecret: String(input.clientSecret ?? "").trim() || current?.clientSecret || "",
		domains: normalizeDomains(input.domains),
		passwordLogin: input.passwordLogin === "all" ? "all" : "admins",
	};
	if (next.enabled) {
		if (!/^https:\/\//.test(next.issuer) && !/^http:\/\/localhost[:/]/.test(next.issuer)) throw new SsoError("Issuer must be an https URL");
		if (!next.clientId || !next.clientSecret) throw new SsoError("Client ID and secret are required");
		if (next.domains.length === 0) throw new SsoError("Add at least one email domain, so only your organization can sign in");
		await discover(next.issuer, true);
	}
	await putSetting(KEY, next);
	return (await ssoView())!;
}

/** What the sign-in page offers. Public: holds no secrets. */
export async function signInOptions(): Promise<{ sso: { label: string } | null; password: "all" | "admins" }> {
	const sso = await getSso();
	if (!sso?.enabled) return { sso: null, password: "all" };
	return { sso: { label: sso.label }, password: sso.passwordLogin };
}

/** Whether a password sign-in is allowed for this role under the current settings. */
export async function passwordAllowed(role: "admin" | "member"): Promise<boolean> {
	const sso = await getSso();
	return !sso?.enabled || sso.passwordLogin === "all" || role === "admin";
}

// ---------------------------------------------------------------------------

interface Discovery {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
}

const discoveries = new Map<string, { at: number; doc: Discovery }>();

async function discover(issuer: string, fresh = false): Promise<Discovery> {
	const cached = discoveries.get(issuer);
	if (cached && !fresh && Date.now() - cached.at < 3600_000) return cached.doc;
	let doc: Discovery;
	try {
		const response = await fetch(`${issuer}/.well-known/openid-configuration`);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		doc = (await response.json()) as Discovery;
	} catch (error) {
		throw new SsoError(`Couldn't read ${issuer}/.well-known/openid-configuration (${(error as Error).message}). Check the issuer URL.`);
	}
	if (!doc.authorization_endpoint || !doc.token_endpoint) throw new SsoError("The issuer's discovery document has no authorization or token endpoint");
	discoveries.set(issuer, { at: Date.now(), doc });
	return doc;
}

interface Pending {
	nonce: string;
	verifier: string;
	next: string;
	expires: number;
}

const pending = new Map<string, Pending>();

/** The identity provider URL that starts a sign-in. */
export async function ssoStartUrl(next: string): Promise<string> {
	const sso = await getSso();
	if (!sso?.enabled) throw new SsoError("Single sign-on is not set up");
	const doc = await discover(sso.issuer);
	for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
	const state = randomToken(24);
	const nonce = randomToken(24);
	const { verifier, challenge } = pkcePair();
	pending.set(state, { nonce, verifier, next, expires: Date.now() + 10 * 60_000 });
	const url = new URL(doc.authorization_endpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", sso.clientId);
	url.searchParams.set("redirect_uri", ssoRedirectUri());
	url.searchParams.set("scope", "openid email profile");
	url.searchParams.set("state", state);
	url.searchParams.set("nonce", nonce);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("prompt", "select_account");
	// Google Workspace: preselect the organization's accounts (still checked below).
	if (sso.domains.length === 1) url.searchParams.set("hd", sso.domains[0]);
	return url.toString();
}

function decodeJwt(token: string): Record<string, unknown> {
	const part = token.split(".")[1];
	if (!part) throw new SsoError("The identity provider returned no ID token");
	return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/**
 * Completes a sign-in. The ID token comes straight from the token endpoint over TLS with our client
 * secret, so per OpenID Connect Core 3.1.3.7 its claims are checked without verifying the signature.
 */
export async function ssoFinish(state: string, code: string): Promise<{ email: string; name: string; next: string }> {
	const entry = pending.get(state);
	pending.delete(state);
	if (!entry || entry.expires < Date.now()) throw new SsoError("This sign-in expired. Try again.");
	const sso = await getSso();
	if (!sso?.enabled) throw new SsoError("Single sign-on is not set up");
	const doc = await discover(sso.issuer);
	const response = await fetch(doc.token_endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: ssoRedirectUri(),
			client_id: sso.clientId,
			client_secret: sso.clientSecret,
			code_verifier: entry.verifier,
		}),
	});
	const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok || typeof data.id_token !== "string") {
		throw new SsoError(`The identity provider refused the sign-in: ${data.error_description ?? data.error ?? response.status}`);
	}
	const claims = decodeJwt(data.id_token);
	const audience = [claims.aud].flat();
	if (claims.iss !== doc.issuer) throw new SsoError("The ID token comes from a different issuer");
	if (!audience.includes(sso.clientId)) throw new SsoError("The ID token was issued for a different app");
	if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 60_000) throw new SsoError("The ID token has expired");
	if (claims.nonce !== entry.nonce) throw new SsoError("The sign-in does not match this browser. Try again.");
	// Entra ID often sends the address only as preferred_username or upn.
	const candidates = [claims.email, claims.preferred_username, claims.upn].filter((v): v is string => typeof v === "string");
	const email = candidates.find((v) => /^[^@\s]+@[^@\s]+$/.test(v))?.toLowerCase();
	if (!email) throw new SsoError("The identity provider did not share an email address");
	if (claims.email_verified === false || claims.email_verified === "false") throw new SsoError(`${email} is not verified`);
	const domain = email.split("@")[1];
	if (!sso.domains.includes(domain)) throw new SsoError(`${email} is not in your organization (${sso.domains.join(", ")}). Ask an admin for access.`);
	const name = typeof claims.name === "string" ? claims.name : "";
	return { email, name, next: entry.next };
}
