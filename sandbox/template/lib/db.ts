// The app's own Postgres database (DATABASE_URL), for data the app creates itself.
import { Pool } from "pg";
import { schema } from "./schema";

const globalForDb = globalThis as unknown as { agencyPool?: Pool; agencySchema?: Promise<void> };

const pool = (globalForDb.agencyPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }));

function ensureSchema(): Promise<void> {
	globalForDb.agencySchema ??= (async () => {
		for (const statement of schema) await pool.query(statement);
	})().catch((error) => {
		globalForDb.agencySchema = undefined;
		throw error;
	});
	return globalForDb.agencySchema;
}

/** Runs a parameterized query on the app database after making sure the schema exists. */
export async function sql<Row = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<Row[]> {
	await ensureSchema();
	const result = await pool.query(text, params);
	return result.rows as Row[];
}
