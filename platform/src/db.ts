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

-- Monthly spend limit per user. Admins existing before budgets were added start unlimited.
do $$
begin
	if not exists (select 1 from information_schema.columns where table_name = 'users' and column_name = 'unlimited') then
		alter table users add column unlimited boolean not null default false;
		alter table users add column monthly_budget_usd numeric(12, 2) not null default 20;
		update users set unlimited = true where role = 'admin';
	end if;
end $$;

-- One row per finished assistant message of the coding agent, attributed to the user who prompted it.
create table if not exists usage_events (
	id bigserial primary key,
	user_id uuid not null references users(id) on delete cascade,
	project_id uuid references projects(id) on delete set null,
	model text not null default '',
	input_tokens integer not null default 0,
	output_tokens integer not null default 0,
	cache_read_tokens integer not null default 0,
	cache_write_tokens integer not null default 0,
	cost_usd numeric(14, 6) not null default 0,
	created_at timestamptz not null default now()
);
create index if not exists usage_events_user_time on usage_events (user_id, created_at);
`;

export async function migrate(): Promise<void> {
	await pool.query(schema);
}
