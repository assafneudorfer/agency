// Data tab: browse and edit an app's own database (preview or live) as the app's database role.
import pg from "pg";
import { databaseUrlFor, type DataEnv, type Project } from "./projects.ts";

/** Thrown for problems the user caused (unknown table, bad value, failing SQL); the API answers with 400. */
export class DataError extends Error {}

export interface Column {
	name: string;
	type: string;
	nullable: boolean;
	hasDefault: boolean;
}

export interface Table {
	name: string;
	columns: Column[];
	primaryKey: string[];
	rowCount: number;
}

const PAGE_LIMIT = 200;
const SQL_ROW_LIMIT = 500;

// One small pool per app database, closed when idle so a dozen apps cost nothing between uses.
const pools = new Map<string, pg.Pool>();

function poolFor(project: Project, env: DataEnv): pg.Pool {
	const url = databaseUrlFor(project, env);
	if (!url) throw new DataError("This app has no live database yet. It is created the first time you publish.");
	let pool = pools.get(url);
	if (!pool) {
		pool = new pg.Pool({ connectionString: url, max: 2, idleTimeoutMillis: 30_000, statement_timeout: 15_000 });
		pool.on("error", () => {});
		pools.set(url, pool);
	}
	return pool;
}

export function closeDataPools(project: Project): void {
	for (const env of ["preview", "live"] as const) {
		const url = databaseUrlFor(project, env);
		if (url && pools.has(url)) {
			void pools.get(url)!.end();
			pools.delete(url);
		}
	}
}

function ident(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function literal(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function userError(error: unknown): never {
	// Postgres errors (bad SQL, constraint violations, wrong value types) are the user's to fix.
	if (error instanceof Error && "code" in error && typeof (error as { code: unknown }).code === "string") {
		throw new DataError(error.message);
	}
	throw error;
}

export async function listTables(project: Project, env: DataEnv): Promise<Table[]> {
	const pool = poolFor(project, env);
	const columns = await pool.query<{ table: string; name: string; type: string; nullable: boolean; has_default: boolean }>(
		`select c.table_name as table, c.column_name as name, c.data_type as type,
		        c.is_nullable = 'YES' as nullable, c.column_default is not null or c.is_identity = 'YES' as has_default
		   from information_schema.columns c
		   join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
		  where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
		  order by c.table_name, c.ordinal_position`,
	);
	const keys = await pool.query<{ table: string; name: string }>(
		`select tc.table_name as table, kcu.column_name as name
		   from information_schema.table_constraints tc
		   join information_schema.key_column_usage kcu
		     on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema and kcu.table_name = tc.table_name
		  where tc.table_schema = 'public' and tc.constraint_type = 'PRIMARY KEY'
		  order by kcu.ordinal_position`,
	);
	const tables = new Map<string, Table>();
	for (const column of columns.rows) {
		let table = tables.get(column.table);
		if (!table) {
			table = { name: column.table, columns: [], primaryKey: [], rowCount: 0 };
			tables.set(column.table, table);
		}
		table.columns.push({ name: column.name, type: column.type, nullable: column.nullable, hasDefault: column.has_default });
	}
	for (const key of keys.rows) tables.get(key.table)?.primaryKey.push(key.name);
	// Exact counts: an app's own tables are small, and estimates read 0 until Postgres analyzes a table.
	if (tables.size > 0) {
		const counts = await pool.query<{ table: string; rows: string }>(
			[...tables.keys()].map((name) => `select ${literal(name)} as table, count(*)::text as rows from ${ident(name)}`).join(" union all "),
		);
		for (const count of counts.rows) tables.get(count.table)!.rowCount = Number(count.rows);
	}
	return [...tables.values()];
}

async function getTable(project: Project, env: DataEnv, name: string): Promise<Table> {
	const table = (await listTables(project, env)).find((t) => t.name === name);
	if (!table) throw new DataError(`Table "${name}" not found`);
	return table;
}

/** Rows of a table as text values (null stays null), so every type displays and edits the same way. */
export async function readRows(project: Project, env: DataEnv, name: string, offset: number, limit: number) {
	const table = await getTable(project, env, name);
	const pool = poolFor(project, env);
	const select = table.columns.map((c) => `${ident(c.name)}::text as ${ident(c.name)}`).join(", ");
	const order = table.primaryKey.length > 0 ? `order by ${table.primaryKey.map(ident).join(", ")}` : "";
	const size = Math.min(Math.max(1, limit || 50), PAGE_LIMIT);
	const start = Math.max(0, offset || 0);
	const [rows, total] = await Promise.all([
		pool.query(`select ${select} from ${ident(table.name)} ${order} limit ${size} offset ${start}`),
		pool.query<{ count: string }>(`select count(*)::text as count from ${ident(table.name)}`),
	]);
	return { table, rows: rows.rows as Record<string, string | null>[], total: Number(total.rows[0].count), offset: start, limit: size };
}

function checkColumns(table: Table, values: Record<string, unknown>): string[] {
	const names = Object.keys(values);
	for (const name of names) {
		if (!table.columns.some((c) => c.name === name)) throw new DataError(`Column "${name}" not found`);
	}
	return names;
}

function keyWhere(table: Table, key: Record<string, unknown>, firstParam: number): { sql: string; params: unknown[] } {
	if (table.primaryKey.length === 0) throw new DataError("Rows can only be changed in tables with a primary key");
	const params = table.primaryKey.map((name) => {
		if (!(name in key)) throw new DataError(`Missing key column "${name}"`);
		return key[name];
	});
	const sql = table.primaryKey.map((name, i) => `${ident(name)}::text = $${firstParam + i}`).join(" and ");
	return { sql, params };
}

export async function updateRow(
	project: Project,
	env: DataEnv,
	name: string,
	key: Record<string, unknown>,
	values: Record<string, string | null>,
): Promise<void> {
	const table = await getTable(project, env, name);
	const columns = checkColumns(table, values);
	if (columns.length === 0) return;
	const set = columns.map((column, i) => `${ident(column)} = $${i + 1}`).join(", ");
	const where = keyWhere(table, key, columns.length + 1);
	const result = await poolFor(project, env)
		.query(`update ${ident(table.name)} set ${set} where ${where.sql}`, [...columns.map((c) => values[c]), ...where.params])
		.catch(userError);
	if (result.rowCount !== 1) throw new DataError("The row was not found. Reload and try again.");
}

export async function insertRow(project: Project, env: DataEnv, name: string, values: Record<string, string | null>): Promise<void> {
	const table = await getTable(project, env, name);
	const columns = checkColumns(table, values);
	const sql =
		columns.length === 0
			? `insert into ${ident(table.name)} default values`
			: `insert into ${ident(table.name)} (${columns.map(ident).join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`;
	await poolFor(project, env)
		.query(sql, columns.map((c) => values[c]))
		.catch(userError);
}

export async function deleteRow(project: Project, env: DataEnv, name: string, key: Record<string, unknown>): Promise<void> {
	const table = await getTable(project, env, name);
	const where = keyWhere(table, key, 1);
	await poolFor(project, env)
		.query(`delete from ${ident(table.name)} where ${where.sql}`, where.params)
		.catch(userError);
}

/**
 * Runs SQL typed in the Data tab as the app's own role, which can only reach the app's database.
 * With readOnly it runs one statement (the extended protocol refuses several, so "commit; delete ..."
 * cannot leave the transaction) inside a read-only transaction.
 */
export async function runSql(project: Project, env: DataEnv, sql: string, readOnly: boolean) {
	if (!sql.trim()) throw new DataError("Type a SQL statement");
	const client = await poolFor(project, env).connect();
	try {
		if (readOnly) await client.query("begin read only");
		const result = await client
			.query({ text: sql, rowMode: "array", ...(readOnly ? { queryMode: "extended" as const } : {}) })
			.catch(userError);
		if (readOnly) await client.query("commit");
		// Several statements return one result each; show the last.
		const last = Array.isArray(result) ? result[result.length - 1] : result;
		const rows = (last.rows ?? []) as unknown[][];
		return {
			command: last.command,
			rowCount: last.rowCount,
			columns: (last.fields ?? []).map((f: pg.FieldDef) => f.name),
			rows: rows.slice(0, SQL_ROW_LIMIT).map((row) => row.map((value) => (value === null ? null : display(value)))),
			truncated: rows.length > SQL_ROW_LIMIT,
		};
	} catch (error) {
		if (readOnly) await client.query("rollback").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}

function display(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (Buffer.isBuffer(value)) return `\\x${value.toString("hex").slice(0, 200)}`;
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}
