import { createHash } from "node:crypto";
import { config } from "./config.ts";
import { decryptJson, encryptJson, randomToken } from "./crypto.ts";
import { query, queryOne } from "./db.ts";

/** Where every OAuth provider sends the admin back after they approve access. Register this URL with the provider. */
export function redirectUrl(): string {
	return `${config.publicUrl}/oauth/callback`;
}

export interface StoredTokens {
	access_token: string;
	refresh_token?: string;
	token_type?: string;
	/** Epoch milliseconds. Absent when the provider does not say (Salesforce); a 401 then triggers a refresh. */
	expires_at?: number;
	scope?: string;
	/** Salesforce: the org's API host. */
	instance_url?: string;
}

/** OAuth state kept per connection, encrypted in connections.oauth_enc. */
export interface OAuthData {
	tokens?: StoredTokens;
	/** MCP servers: the client registered dynamically with the server's authorization server. */
	client?: Record<string, unknown>;
	/** MCP servers: discovered authorization server metadata, so discovery is not repeated on every refresh. */
	discovery?: unknown;
}

export async function loadOAuth(connectionId: string): Promise<OAuthData> {
	const row = await queryOne<{ oauth_enc: string | null }>("select oauth_enc from connections where id = $1", [connectionId]);
	return row?.oauth_enc ? decryptJson<OAuthData>(row.oauth_enc) : {};
}

export async function saveOAuth(connectionId: string, patch: Partial<OAuthData>, account?: string): Promise<void> {
	const data = { ...(await loadOAuth(connectionId)), ...patch };
	if (account === undefined) {
		await query("update connections set oauth_enc = $2 where id = $1", [connectionId, encryptJson(data)]);
	} else {
		await query("update connections set oauth_enc = $2, oauth_account = $3 where id = $1", [connectionId, encryptJson(data), account]);
	}
}

export async function clearOAuth(connectionId: string): Promise<void> {
	await query("update connections set oauth_enc = null, oauth_account = '' where id = $1", [connectionId]);
}

// ---------------------------------------------------------------------------
// Sign-ins in progress. Kept in memory: a sign-in started before a platform restart just has to be started again.

export interface PendingSignIn {
	connectionId: string;
	userId: string;
	codeVerifier?: string;
	expires: number;
}

const pending = new Map<string, PendingSignIn>();

export function beginSignIn(connectionId: string, userId: string): { state: string; entry: PendingSignIn } {
	for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
	const state = randomToken(24);
	const entry: PendingSignIn = { connectionId, userId, expires: Date.now() + 10 * 60_000 };
	pending.set(state, entry);
	return { state, entry };
}

export function takeSignIn(state: string): PendingSignIn | undefined {
	const entry = pending.get(state);
	pending.delete(state);
	if (!entry || entry.expires < Date.now()) return undefined;
	return entry;
}

export function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomToken(48);
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Plain OAuth 2.0 (authorization code with PKCE) for the built-in connectors.

export interface OAuthClient {
	authUrl: string;
	tokenUrl: string;
	clientId: string;
	clientSecret?: string;
	scope: string;
	extraParams?: Record<string, string>;
}

export function authorizationUrl(client: OAuthClient, state: string, challenge: string): string {
	const url = new URL(client.authUrl);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", client.clientId);
	url.searchParams.set("redirect_uri", redirectUrl());
	url.searchParams.set("scope", client.scope);
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	for (const [key, value] of Object.entries(client.extraParams ?? {})) url.searchParams.set(key, value);
	return url.toString();
}

async function tokenRequest(client: OAuthClient, params: Record<string, string>): Promise<Record<string, unknown>> {
	const body = new URLSearchParams({ ...params, client_id: client.clientId });
	if (client.clientSecret) body.set("client_secret", client.clientSecret);
	const response = await fetch(client.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body,
	});
	const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok || typeof data.access_token !== "string") {
		const reason = data.error_description ?? data.error ?? `HTTP ${response.status}`;
		throw new Error(`The provider refused the sign-in: ${reason}`);
	}
	return data;
}

function toStored(data: Record<string, unknown>, previous?: StoredTokens): StoredTokens {
	return {
		access_token: String(data.access_token),
		// Refresh responses often leave the refresh token out; the old one stays valid.
		refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : previous?.refresh_token,
		token_type: typeof data.token_type === "string" ? data.token_type : "Bearer",
		expires_at: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
		scope: typeof data.scope === "string" ? data.scope : previous?.scope,
		instance_url: typeof data.instance_url === "string" ? data.instance_url : previous?.instance_url,
	};
}

export async function exchangeCode(
	client: OAuthClient,
	code: string,
	verifier: string,
): Promise<{ tokens: StoredTokens; raw: Record<string, unknown> }> {
	const raw = await tokenRequest(client, {
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUrl(),
		code_verifier: verifier,
	});
	return { tokens: toStored(raw), raw };
}

export async function refreshTokens(client: OAuthClient, tokens: StoredTokens): Promise<StoredTokens> {
	if (!tokens.refresh_token) throw new Error("The sign-in expired. An admin needs to click Connect again.");
	const raw = await tokenRequest(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
	return toStored(raw, tokens);
}
