import pg from "pg";
import { config } from "./config.ts";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
	const result = await pool.query<T>(sql, params);
	return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
	const rows = await query<T>(sql, params);
	return rows[0];
}

const schema = `
create table if not exists users (
	id uuid primary key default gen_random_uuid(),
	email text not null unique,
	name text not null default '',
	password_hash text not null,
	role text not null default 'member' check (role in ('admin', 'member')),
	created_at timestamptz not null default now()
);

create table if not exists sessions (
	id text primary key,
	user_id uuid not null references users(id) on delete cascade,
	expires_at timestamptz not null
);

create table if not exists projects (
	id uuid primary key default gen_random_uuid(),
	slug text not null unique,
	name text not null,
	owner_id uuid not null references users(id),
	token text not null unique,
	db_name text not null,
	db_password_enc text not null,
	created_at timestamptz not null default now()
);

create table if not exists connections (
	id uuid primary key default gen_random_uuid(),
	name text not null unique,
	kind text not null check (kind in ('postgres', 'mcp_http', 'mcp_stdio')),
	description text not null default '',
	config_enc text not null,
	allow_write boolean not null default false,
	created_at timestamptz not null default now()
);

create table if not exists deployments (
	id serial primary key,
	project_id uuid not null references projects(id) on delete cascade,
	version integer not null,
	image text not null,
	git_commit text not null default '',
	created_by uuid references users(id),
	created_at timestamptz not null default now(),
	active boolean not null default false,
	unique (project_id, version)
);
`;

export async function migrate(): Promise<void> {
	await pool.query(schema);
}
