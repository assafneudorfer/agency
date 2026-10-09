import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "./config.ts";
import { hashPassword, randomToken, verifyPassword } from "./crypto.ts";
import { query, queryOne } from "./db.ts";

export interface User {
	id: string;
	email: string;
	name: string;
	role: "admin" | "member";
}

export type AppEnv = { Variables: { user: User } };

const COOKIE = "agency_session";
const SESSION_DAYS = 14;

export async function ensureAdmin(): Promise<void> {
	const existing = await queryOne<{ count: string }>("select count(*)::text as count from users");
	if (existing && existing.count !== "0") return;
	if (!config.adminEmail || !config.adminPassword) {
		console.warn("No users exist. Set AGENCY_ADMIN_EMAIL and AGENCY_ADMIN_PASSWORD to create the first admin.");
		return;
	}
	await createUser(config.adminEmail, "Admin", config.adminPassword, "admin");
	console.log(`Created admin user ${config.adminEmail}`);
}

export async function createUser(email: string, name: string, password: string, role: User["role"]): Promise<User> {
	const user = await queryOne<User>(
		"insert into users (email, name, password_hash, role) values (lower($1), $2, $3, $4) returning id, email, name, role",
		[email, name, hashPassword(password), role],
	);
	return user!;
}

export async function login(c: Context, email: string, password: string): Promise<User | undefined> {
	const row = await queryOne<User & { password_hash: string }>(
		"select id, email, name, role, password_hash from users where email = lower($1)",
		[email],
	);
	if (!row || !verifyPassword(password, row.password_hash)) return undefined;
	const id = randomToken();
	await query("insert into sessions (id, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))", [
		id,
		row.id,
		SESSION_DAYS,
	]);
	// Scoped to the base domain so previews and published apps on subdomains see the same session.
	setCookie(c, COOKIE, id, {
		httpOnly: true,
		secure: config.secureCookies,
		sameSite: "Lax",
		domain: config.baseDomain,
		path: "/",
		maxAge: SESSION_DAYS * 24 * 3600,
	});
	return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export async function logout(c: Context): Promise<void> {
	const id = getCookie(c, COOKIE);
	if (id) await query("delete from sessions where id = $1", [id]);
	deleteCookie(c, COOKIE, { domain: config.baseDomain, path: "/" });
}

export async function currentUser(c: Context): Promise<User | undefined> {
	const id = getCookie(c, COOKIE);
	if (!id) return undefined;
	return queryOne<User>(
		"select u.id, u.email, u.name, u.role from sessions s join users u on u.id = s.user_id where s.id = $1 and s.expires_at > now()",
		[id],
	);
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
	const user = await currentUser(c);
	if (!user) return c.json({ error: "Not signed in" }, 401);
	c.set("user", user);
	await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (c.get("user").role !== "admin") return c.json({ error: "Admins only" }, 403);
	await next();
};

/** Only allow redirects back to hosts under the base domain. */
export function safeNext(next: string | undefined): string {
	if (!next) return "/";
	try {
		const url = new URL(next);
		if (url.hostname === config.baseDomain || url.hostname.endsWith(`.${config.baseDomain}`)) return url.toString();
	} catch {
		if (next.startsWith("/") && !next.startsWith("//")) return next;
	}
	return "/";
}

/**
 * Traefik forwardAuth endpoint. Previews and published apps carry the agency-auth middleware,
 * so only signed-in team members can open them.
 */
export async function verifyForwardAuth(c: Context): Promise<Response> {
	const user = await currentUser(c);
	if (user) {
		c.header("X-Agency-User", user.email);
		return c.body(null, 200);
	}
	const proto = c.req.header("X-Forwarded-Proto") ?? config.scheme;
	const host = c.req.header("X-Forwarded-Host") ?? "";
	const uri = c.req.header("X-Forwarded-Uri") ?? "/";
	const next = encodeURIComponent(`${proto}://${host}${uri}`);
	return c.redirect(`${config.publicUrl}/?next=${next}`, 302);
}
