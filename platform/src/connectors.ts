import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";
import { decryptJson, encryptJson } from "./crypto.ts";
import { query, queryOne } from "./db.ts";

export type ConnectionKind = "postgres" | "mcp_http" | "mcp_stdio";

export interface PostgresConfig {
	connectionString: string;
	/** "verify" checks the server certificate, "require" encrypts without verifying (RDS, Supabase pooler), "off" disables TLS. */
	ssl?: "verify" | "require" | "off";
}

export interface McpHttpConfig {
	url: string;
	headers?: Record<string, string>;
}

export interface McpStdioConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export type ConnectionConfig = PostgresConfig | McpHttpConfig | McpStdioConfig;

interface ConnectionRow {
	id: string;
	name: string;
	kind: ConnectionKind;
	description: string;
	config_enc: string;
	allow_write: boolean;
	created_at: string;
}

/** What callers outside the platform may see: never the config, which holds credentials. */
export interface ConnectionInfo {
	id: string;
	name: string;
	kind: ConnectionKind;
	description: string;
	allowWrite: boolean;
	createdAt: string;
}

function info(row: ConnectionRow): ConnectionInfo {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		description: row.description,
		allowWrite: row.allow_write,
		createdAt: row.created_at,
	};
}

export async function listConnections(): Promise<ConnectionInfo[]> {
	const rows = await query<ConnectionRow>("select * from connections order by name");
	return rows.map(info);
}

async function getRow(name: string): Promise<ConnectionRow> {
	const row = await queryOne<ConnectionRow>("select * from connections where name = $1", [name]);
	if (!row) throw new Error(`Unknown connection "${name}"`);
	return row;
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
	const row = await queryOne<ConnectionRow>(
		"insert into connections (name, kind, description, allow_write, config_enc) values ($1, $2, $3, $4, $5) returning *",
		[input.name, input.kind, input.description, input.allowWrite, encryptJson(input.config)],
	);
	return info(row!);
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

export async function runSql(name: string, sql: string, params: unknown[] = [], limit = 5000): Promise<SqlResult> {
	const row = await getRow(name);
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

async function describePostgres(name: string): Promise<string> {
	const result = await runSql(
		name,
		`select c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable
		 from information_schema.columns c
		 join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
		 where c.table_schema not in ('pg_catalog', 'information_schema') and c.table_schema not like 'pg_%'
		 order by c.table_schema, c.table_name, c.ordinal_position`,
		[],
		10_000,
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

async function connectMcp(row: ConnectionRow): Promise<Client> {
	const client = new Client({ name: "agency", version: "0.1.0" });
	if (row.kind === "mcp_http") {
		const cfg = decryptJson<McpHttpConfig>(row.config_enc);
		await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
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
	if (row.kind === "postgres") throw new Error(`Connection "${row.name}" is not an MCP server`);
	let client = clients.get(row.id);
	if (!client) {
		client = connectMcp(row);
		clients.set(row.id, client);
		client.catch(() => clients.delete(row.id));
	}
	return client;
}

async function withMcp<T>(name: string, fn: (client: Client) => Promise<T>): Promise<T> {
	const row = await getRow(name);
	try {
		return await fn(await mcpClient(row));
	} catch (error) {
		// One reconnect covers servers that restarted or dropped an idle session.
		await closeConnection(row.id);
		return fn(await mcpClient(row));
	}
}

export async function listTools(name: string) {
	return withMcp(name, async (client) => (await client.listTools()).tools);
}

export async function callTool(name: string, tool: string, args: Record<string, unknown>) {
	const row = await getRow(name);
	if (!row.allow_write && /^(create|update|delete|remove|insert|send|post|write|set|add)/i.test(tool)) {
		throw new Error(`Connection "${name}" is read-only; tool "${tool}" looks like a write. An admin can allow writes.`);
	}
	return withMcp(name, (client) => client.callTool({ name: tool, arguments: args }));
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
export async function describeConnection(name: string): Promise<string> {
	const row = await getRow(name);
	const header = `Connection "${row.name}" (${row.kind}${row.allow_write ? ", writes allowed" : ", read-only"})${row.description ? `: ${row.description}` : ""}`;
	if (row.kind === "postgres") return `${header}\n\n${await describePostgres(name)}`;
	const tools = await listTools(name);
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
	const tools = await listTools(name);
	return `Connected. ${tools.length} tools available.`;
}
