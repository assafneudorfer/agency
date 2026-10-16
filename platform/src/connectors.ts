import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";
import { decryptJson, encryptJson } from "./crypto.ts";
import { query, queryOne } from "./db.ts";
import {
	callNativeTool,
	isNativeKind,
	type NativeConfig,
	type NativeConnection,
	nativeAccount,
	nativeOAuthClient,
	nativeTools,
	nativeToolWrites,
	testNative,
} from "./native.ts";
import {
	authorizationUrl,
	beginSignIn,
	clearOAuth,
	exchangeCode,
	loadOAuth,
	pkcePair,
	redirectUrl,
	saveOAuth,
	takeSignIn,
} from "./oauth.ts";

export type ConnectionKind = "postgres" | "mcp_http" | "mcp_stdio" | "google_drive" | "salesforce";
export const CONNECTION_KINDS: ConnectionKind[] = ["postgres", "mcp_http", "mcp_stdio", "google_drive", "salesforce"];

export interface PostgresConfig {
	connectionString: string;
	/** "verify" checks the server certificate, "require" encrypts without verifying (RDS, Supabase pooler), "off" disables TLS. */
	ssl?: "verify" | "require" | "off";
}

export interface McpHttpConfig {
	url: string;
	headers?: Record<string, string>;
	/**
	 * Sign in with OAuth, as the MCP spec describes: the platform discovers the server's authorization server
	 * and registers itself as a client. clientId (and clientSecret) are only needed for servers that don't
	 * allow dynamic registration.
	 */
	oauth?: { clientId?: string; clientSecret?: string; scope?: string };
}

export interface McpStdioConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export type ConnectionConfig = PostgresConfig | McpHttpConfig | McpStdioConfig | NativeConfig;

interface ConnectionRow {
	id: string;
	name: string;
	kind: ConnectionKind;
	description: string;
	config_enc: string;
	allow_write: boolean;
	created_at: string;
	oauth_enc: string | null;
	oauth_account: string;
	all_projects: boolean;
	project_ids?: string[];
}

/** What callers outside the platform may see: never the config, which holds credentials. */
export interface ConnectionInfo {
	id: string;
	name: string;
	kind: ConnectionKind;
	description: string;
	allowWrite: boolean;
	createdAt: string;
	/** "none": no sign-in involved. "needed": an admin still has to click Connect. */
	signIn: "none" | "needed" | "signed_in";
	account: string;
	allProjects: boolean;
	projectIds: string[];
}

function usesOAuth(row: ConnectionRow): boolean {
	if (isNativeKind(row.kind)) return true;
	return row.kind === "mcp_http" && Boolean(decryptJson<McpHttpConfig>(row.config_enc).oauth);
}

function info(row: ConnectionRow): ConnectionInfo {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		description: row.description,
		allowWrite: row.allow_write,
		createdAt: row.created_at,
		signIn: !usesOAuth(row) ? "none" : row.oauth_enc && decryptJson<{ tokens?: unknown }>(row.oauth_enc).tokens ? "signed_in" : "needed",
		account: row.oauth_account,
		allProjects: row.all_projects,
		projectIds: row.project_ids ?? [],
	};
}

const SELECT = `select c.*, coalesce(array(select cp.project_id::text from connection_projects cp where cp.connection_id = c.id), '{}') as project_ids
	from connections c`;

/** All connections, or with a project id only those that app may use. */
export async function listConnections(projectId?: string): Promise<ConnectionInfo[]> {
	const rows = projectId
		? await query<ConnectionRow>(
				`${SELECT} where c.all_projects or exists (select 1 from connection_projects cp where cp.connection_id = c.id and cp.project_id = $1) order by c.name`,
				[projectId],
			)
		: await query<ConnectionRow>(`${SELECT} order by c.name`);
	return rows.map(info);
}

/** Looks a connection up by name. With a project id, refuses connections not shared with that app. */
async function getRow(name: string, projectId?: string): Promise<ConnectionRow> {
	const row = await queryOne<ConnectionRow>(`${SELECT} where c.name = $1`, [name]);
	if (!row) throw new Error(`Unknown connection "${name}"`);
	if (projectId && !row.all_projects && !row.project_ids?.includes(projectId)) {
		throw new Error(`Connection "${name}" is not shared with this app. An admin can allow it under Connections.`);
	}
	return row;
}

async function getRowById(id: string): Promise<ConnectionRow> {
	const row = await queryOne<ConnectionRow>(`${SELECT} where c.id = $1`, [id]);
	if (!row) throw new Error("Unknown connection");
	return row;
}

function nativeConnection(row: ConnectionRow): NativeConnection {
	if (!isNativeKind(row.kind)) throw new Error(`Connection "${row.name}" is not a built-in connector`);
	return { id: row.id, name: row.name, kind: row.kind, allowWrite: row.allow_write, config: decryptJson<NativeConfig>(row.config_enc) };
}

/** Limits a connection to some apps, or opens it to all of them. */
export async function setConnectionProjects(id: string, allProjects: boolean, projectIds: string[]): Promise<ConnectionInfo> {
	await getRowById(id);
	await query("update connections set all_projects = $2 where id = $1", [id, allProjects]);
	await query("delete from connection_projects where connection_id = $1", [id]);
	if (!allProjects && projectIds.length > 0) {
		await query(
			"insert into connection_projects (connection_id, project_id) select $1, p.id from projects p where p.id::text = any($2) on conflict do nothing",
			[id, projectIds],
		);
	}
	return info(await getRowById(id));
}

export async function createConnection(input: {
	name: string;
	kind: ConnectionKind;
	description: string;
	allowWrite: boolean;
	config: ConnectionConfig;
}): Promise<ConnectionInfo> {
	if (!/^[a-z][a-z0-9_-]{0,39}$/.test(input.name)) {
		throw new Error("Name must start with a letter and use lowercase letters, digits, - or _");
	}
	validateConfig(input.kind, input.config);
	const row = await queryOne<ConnectionRow>(
		"insert into connections (name, kind, description, allow_write, config_enc) values ($1, $2, $3, $4, $5) returning *",
		[input.name, input.kind, input.description, input.allowWrite, encryptJson(input.config)],
	);
	return info(row!);
}

function validateConfig(kind: ConnectionKind, config: ConnectionConfig): void {
	const cfg = (config ?? {}) as unknown as Record<string, unknown>;
	const need = (key: string, label: string) => {
		if (typeof cfg[key] !== "string" || !(cfg[key] as string).trim()) throw new Error(`${label} is required`);
	};
	if (kind === "postgres") need("connectionString", "Connection string");
	if (kind === "mcp_http") need("url", "MCP URL");
	if (kind === "mcp_stdio") need("command", "Command");
	if (kind === "google_drive") {
		need("clientId", "Client ID");
		need("clientSecret", "Client secret");
	}
	if (kind === "salesforce") {
		need("clientId", "Consumer key");
		if (cfg.loginUrl && !/^https:\/\/[^/]+$/.test(String(cfg.loginUrl).replace(/\/+$/, ""))) {
			throw new Error("Login URL must look like https://login.salesforce.com or https://yourcompany.my.salesforce.com");
		}
	}
}

export async function deleteConnection(id: string): Promise<void> {
	const row = await queryOne<ConnectionRow>("delete from connections where id = $1 returning *", [id]);
	if (row) await closeConnection(row.id);
}

// ---------------------------------------------------------------------------
// Postgres (also Supabase and AWS RDS, which expose Postgres connection strings)

const pools = new Map<string, pg.Pool>();

function poolFor(row: ConnectionRow): pg.Pool {
	let pool = pools.get(row.id);
	if (pool) return pool;
	const cfg = decryptJson<PostgresConfig>(row.config_enc);
	const url = new URL(cfg.connectionString);
	// node-postgres lets sslmode in the URL override the ssl option, so the explicit choice wins by removing it.
	url.searchParams.delete("sslmode");
	const ssl = cfg.ssl === "off" ? false : cfg.ssl === "require" ? { rejectUnauthorized: false } : true;
	pool = new pg.Pool({ connectionString: url.toString(), ssl, max: 5, idleTimeoutMillis: 30_000 });
	pool.on("error", (error) => console.error(`[connection ${row.name}] ${error.message}`));
	pools.set(row.id, pool);
	return pool;
}

export interface SqlResult {
	columns: string[];
	rows: Record<string, unknown>[];
	rowCount: number;
	truncated: boolean;
}

export async function runSql(
	name: string,
	sql: string,
	params: unknown[] = [],
	limit = 5000,
	projectId?: string,
): Promise<SqlResult> {
	const row = await getRow(name, projectId);
	if (row.kind !== "postgres") throw new Error(`Connection "${name}" is not a SQL database`);
	const client = await poolFor(row).connect();
	try {
		await client.query(row.allow_write ? "begin" : "begin read only");
		await client.query("set local statement_timeout = 15000");
		const result = await client.query(sql, params);
		await client.query("commit");
		const rows = (result.rows ?? []) as Record<string, unknown>[];
		return {
			columns: (result.fields ?? []).map((field) => field.name),
			rows: rows.slice(0, limit),
			rowCount: result.rowCount ?? rows.length,
			truncated: rows.length > limit,
		};
	} catch (error) {
		await client.query("rollback").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}

async function describePostgres(name: string, projectId?: string): Promise<string> {
	const result = await runSql(
		name,
		`select c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable
		 from information_schema.columns c
		 join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
		 where c.table_schema not in ('pg_catalog', 'information_schema') and c.table_schema not like 'pg_%'
		 order by c.table_schema, c.table_name, c.ordinal_position`,
		[],
		10_000,
		projectId,
	);
	const tables = new Map<string, string[]>();
	for (const r of result.rows) {
		const key = `${r.table_schema}.${r.table_name}`;
		const columns = tables.get(key) ?? [];
		columns.push(`${r.column_name} ${r.data_type}${r.is_nullable === "NO" ? " not null" : ""}`);
		tables.set(key, columns);
	}
	if (tables.size === 0) return "No tables visible to this connection.";
	return [...tables].map(([table, columns]) => `${table}(\n  ${columns.join(",\n  ")}\n)`).join("\n\n");
}

// ---------------------------------------------------------------------------
// MCP connectors (Google Drive, Monday, Salesforce, AWS and anything else with an MCP server)

const clients = new Map<string, Promise<Client>>();

/**
 * The MCP SDK's OAuth hooks, backed by the connection's encrypted oauth_enc. During a sign-in, `signIn`
 * carries the state and PKCE verifier between the redirect and the callback.
 */
function oauthProvider(
	row: ConnectionRow,
	cfg: McpHttpConfig,
	signIn?: { state: string; entry: { codeVerifier?: string }; onRedirect: (url: URL) => void },
): OAuthClientProvider {
	const oauth = cfg.oauth ?? {};
	return {
		get redirectUrl() {
			return redirectUrl();
		},
		get clientMetadata() {
			return {
				client_name: "Agency",
				redirect_uris: [redirectUrl()],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: oauth.clientSecret ? "client_secret_post" : "none",
				...(oauth.scope ? { scope: oauth.scope } : {}),
			};
		},
		state: () => signIn?.state ?? "",
		async clientInformation() {
			if (oauth.clientId) return { client_id: oauth.clientId, ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}) };
			return (await loadOAuth(row.id)).client as never;
		},
		async saveClientInformation(client) {
			await saveOAuth(row.id, { client: client as Record<string, unknown> });
		},
		async tokens() {
			return (await loadOAuth(row.id)).tokens as never;
		},
		async saveTokens(tokens) {
			await saveOAuth(row.id, { tokens: { ...tokens } as never });
		},
		async discoveryState() {
			return (await loadOAuth(row.id)).discovery as never;
		},
		async saveDiscoveryState(state) {
			await saveOAuth(row.id, { discovery: state });
		},
		redirectToAuthorization(url) {
			// Outside a sign-in the platform cannot send anyone to the provider; the call then fails as unauthorized.
			signIn?.onRedirect(url);
		},
		saveCodeVerifier(verifier) {
			if (signIn) signIn.entry.codeVerifier = verifier;
		},
		codeVerifier() {
			if (!signIn?.entry.codeVerifier) throw new Error("No sign-in in progress");
			return signIn.entry.codeVerifier;
		},
		async invalidateCredentials(scope) {
			if (scope === "all" || scope === "tokens") await saveOAuth(row.id, { tokens: undefined });
			if (scope === "all" || scope === "client") await saveOAuth(row.id, { client: undefined });
			if (scope === "all" || scope === "discovery") await saveOAuth(row.id, { discovery: undefined });
		},
	};
}

async function connectMcp(row: ConnectionRow): Promise<Client> {
	const client = new Client({ name: "agency", version: "0.1.0" });
	if (row.kind === "mcp_http") {
		const cfg = decryptJson<McpHttpConfig>(row.config_enc);
		const authProvider = cfg.oauth ? oauthProvider(row, cfg) : undefined;
		try {
			await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers }, authProvider }));
		} catch (error) {
			if (cfg.oauth && /unauthorized|401/i.test(String(error))) {
				throw new Error(`Connection "${row.name}" needs to be signed in. An admin clicks Connect on the Connections page.`);
			}
			throw error;
		}
	} else {
		const cfg = decryptJson<McpStdioConfig>(row.config_enc);
		const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" };
		await client.connect(
			new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: { ...env, ...cfg.env } }),
		);
	}
	return client;
}

async function mcpClient(row: ConnectionRow): Promise<Client> {
	if (row.kind !== "mcp_http" && row.kind !== "mcp_stdio") throw new Error(`Connection "${row.name}" is not an MCP server`);
	let client = clients.get(row.id);
	if (!client) {
		client = connectMcp(row);
		clients.set(row.id, client);
		client.catch(() => clients.delete(row.id));
	}
	return client;
}

async function withMcp<T>(row: ConnectionRow, fn: (client: Client) => Promise<T>): Promise<T> {
	try {
		return await fn(await mcpClient(row));
	} catch (error) {
		// One reconnect covers servers that restarted or dropped an idle session.
		await closeConnection(row.id);
		return fn(await mcpClient(row));
	}
}

async function toolsOf(row: ConnectionRow) {
	if (isNativeKind(row.kind)) return nativeTools(row.kind);
	return withMcp(row, async (client) => (await client.listTools()).tools);
}

export async function listTools(name: string, projectId?: string) {
	return toolsOf(await getRow(name, projectId));
}

const WRITE_TOOL = /^(create|update|delete|remove|insert|send|post|write|set|add|append|upsert|patch|archive|move|upload)/i;

export async function callTool(name: string, tool: string, args: Record<string, unknown>, projectId?: string) {
	const row = await getRow(name, projectId);
	const writes = isNativeKind(row.kind) ? nativeToolWrites(row.kind, tool) : WRITE_TOOL.test(tool);
	if (!row.allow_write && writes) {
		throw new Error(`Connection "${name}" is read-only; tool "${tool}" changes data. An admin can allow writes.`);
	}
	if (isNativeKind(row.kind)) return callNativeTool(nativeConnection(row), tool, args);
	return withMcp(row, (client) => client.callTool({ name: tool, arguments: args }));
}

async function closeConnection(id: string): Promise<void> {
	const pool = pools.get(id);
	pools.delete(id);
	await pool?.end().catch(() => {});
	const client = clients.get(id);
	clients.delete(id);
	await client?.then((c) => c.close()).catch(() => {});
}

/** A text description of what a connection holds, for the coding agent. */
export async function describeConnection(name: string, projectId?: string): Promise<string> {
	const row = await getRow(name, projectId);
	const header = `Connection "${row.name}" (${row.kind}${row.allow_write ? ", writes allowed" : ", read-only"})${row.description ? `: ${row.description}` : ""}`;
	if (row.kind === "postgres") return `${header}\n\n${await describePostgres(name, projectId)}`;
	const tools = await toolsOf(row);
	const lines = tools.map(
		(tool) => `- ${tool.name}: ${tool.description ?? ""}\n  input schema: ${JSON.stringify(tool.inputSchema)}`,
	);
	return `${header}\n\nTools:\n${lines.join("\n")}`;
}

export async function testConnection(name: string): Promise<string> {
	const row = await getRow(name);
	if (row.kind === "postgres") {
		const result = await runSql(name, "select current_database() as db, current_user as role");
		return `Connected to ${result.rows[0]?.db} as ${result.rows[0]?.role}`;
	}
	if (isNativeKind(row.kind)) return testNative(nativeConnection(row));
	const tools = await toolsOf(row);
	return `Connected. ${tools.length} tools available.`;
}

// ---------------------------------------------------------------------------
// OAuth sign-in: an admin clicks Connect, approves access at the provider, and lands back on /oauth/callback.

/** Returns the provider URL to send the admin to, or null when the connection is already signed in. */
export async function startSignIn(id: string, userId: string): Promise<string | null> {
	const row = await getRowById(id);
	if (!usesOAuth(row)) throw new Error(`Connection "${row.name}" does not use a sign-in`);
	const { state, entry } = beginSignIn(row.id, userId);
	if (isNativeKind(row.kind)) {
		const { verifier, challenge } = pkcePair();
		entry.codeVerifier = verifier;
		return authorizationUrl(nativeOAuthClient(nativeConnection(row)), state, challenge);
	}
	const cfg = decryptJson<McpHttpConfig>(row.config_enc);
	// A new sign-in replaces the old tokens, so the admin can switch accounts.
	await saveOAuth(row.id, { tokens: undefined });
	let target: URL | undefined;
	const result = await auth(oauthProvider(row, cfg, { state, entry, onRedirect: (url) => (target = url) }), {
		serverUrl: cfg.url,
		scope: cfg.oauth?.scope,
	});
	if (result === "AUTHORIZED") return null;
	if (!target) throw new Error("The MCP server did not offer a sign-in page");
	return target.toString();
}

/** Completes a sign-in from the provider's redirect. Returns the connection's name. */
export async function finishSignIn(state: string, code: string, userId: string): Promise<string> {
	const entry = takeSignIn(state);
	if (!entry || entry.userId !== userId) throw new Error("This sign-in link expired. Click Connect again.");
	const row = await getRowById(entry.connectionId);
	if (isNativeKind(row.kind)) {
		const conn = nativeConnection(row);
		const { tokens, raw } = await exchangeCode(nativeOAuthClient(conn), code, entry.codeVerifier ?? "");
		await saveOAuth(row.id, { tokens });
		await saveOAuth(row.id, {}, await nativeAccount(conn, tokens, raw));
	} else {
		const cfg = decryptJson<McpHttpConfig>(row.config_enc);
		await auth(oauthProvider(row, cfg, { state, entry, onRedirect: () => {} }), {
			serverUrl: cfg.url,
			authorizationCode: code,
			scope: cfg.oauth?.scope,
		});
		await saveOAuth(row.id, {}, "");
	}
	await closeConnection(row.id);
	return row.name;
}

export async function signOut(id: string): Promise<void> {
	await clearOAuth(id);
	await closeConnection(id);
}
