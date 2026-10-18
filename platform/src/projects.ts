import type { TeamAccess } from "./access.ts";
import { config } from "./config.ts";
import { decryptJson, encryptJson, randomToken } from "./crypto.ts";
import { appRuntime } from "./apps.ts";
import { pool, query, queryOne } from "./db.ts";
import { docker } from "./docker.ts";
import { sandboxes } from "./sandboxes.ts";

export interface Project {
	id: string;
	slug: string;
	name: string;
	owner_id: string;
	token: string;
	db_name: string;
	db_password_enc: string;
	// Database of the published app. Created on the first publish, so the preview never touches live data.
	live_db_name: string | null;
	live_db_password_enc: string | null;
	// What members other than the owner, admins and listed project members can do with the app.
	team_access: TeamAccess;
	// GitHub repository ("owner/name") the app's history is pushed to, if linked.
	github_repo: string | null;
	github_branch: string;
	github_auto_push: boolean;
	github_pushed_commit: string | null;
	github_pushed_at: string | null;
	created_at: string;
}

const RESERVED = new Set(["www", "api", "app", "admin", "traefik", "mail", "platform"]);

export function sandboxName(project: Project): string {
	return `agency-sbx-${project.slug}`;
}

export function appContainerName(project: Project): string {
	return `agency-app-${project.slug}`;
}

export function slugify(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
}

async function uniqueSlug(name: string): Promise<string> {
	let base = slugify(name) || "app";
	if (RESERVED.has(base) || base.endsWith("-preview")) base = `${base}-app`;
	for (let i = 0; ; i++) {
		const slug = i === 0 ? base : `${base}-${i + 1}`;
		const taken = await queryOne("select 1 from projects where slug = $1", [slug]);
		if (!taken) return slug;
	}
}

export type DataEnv = "preview" | "live";

function databaseUrl(name: string, passwordEnc: string): string {
	const password = decryptJson<string>(passwordEnc);
	return `postgres://${name}:${encodeURIComponent(password)}@${config.projectDbHost}:5432/${name}`;
}

/** The preview database, used by the sandbox and the coding agent. */
export function projectDatabaseUrl(project: Project): string {
	return databaseUrl(project.db_name, project.db_password_enc);
}

/** The published app's database, or undefined before the first publish. */
export function liveDatabaseUrl(project: Project): string | undefined {
	if (!project.live_db_name || !project.live_db_password_enc) return undefined;
	return databaseUrl(project.live_db_name, project.live_db_password_enc);
}

export function databaseUrlFor(project: Project, env: DataEnv): string | undefined {
	return env === "live" ? liveDatabaseUrl(project) : projectDatabaseUrl(project);
}

/** Creates a login role and a database it owns. Identifiers come from slugify, so they are safe to inline. */
async function createDatabase(name: string): Promise<string> {
	const password = randomToken(24);
	await pool.query(`create role ${name} login password '${password.replace(/'/g, "''")}'`);
	await pool.query(`create database ${name} owner ${name}`);
	await pool.query(`revoke all on database ${name} from public`);
	return encryptJson(password);
}

async function dropDatabase(name: string): Promise<void> {
	await pool.query(`drop database if exists ${name} with (force)`);
	await pool.query(`drop role if exists ${name}`);
}

/** Copies schema and rows from one app database to another with pg_dump, run in a throwaway Postgres container. */
async function copyDatabase(fromUrl: string, toUrl: string): Promise<void> {
	await docker(
		[
			"run",
			"--rm",
			"--network",
			config.dockerNetwork,
			"-e",
			"FROM_URL",
			"-e",
			"TO_URL",
			config.postgresImage,
			"sh",
			"-c",
			'set -e; pg_dump --no-owner --no-acl "$FROM_URL" > /tmp/dump.sql; psql -q -v ON_ERROR_STOP=1 "$TO_URL" -f /tmp/dump.sql',
		],
		{ env: { FROM_URL: fromUrl, TO_URL: toUrl }, timeoutMs: 10 * 60_000 },
	);
}

/**
 * Makes sure the project has a separate database for the published app and returns its URL.
 * Apps published before preview and live were split kept their real data in the preview database,
 * so for them the live database starts as a copy of it; new apps start with an empty one and the
 * app creates its tables from lib/schema.ts on start.
 */
export async function ensureLiveDatabase(project: Project, onLog: (line: string) => void = () => {}): Promise<string> {
	const existing = liveDatabaseUrl(project);
	if (existing) return existing;
	// slugify never produces "--", so "__" cannot collide with another app's database name.
	const name = `${project.db_name}__live`;
	const publishedBefore = await queryOne("select 1 from deployments where project_id = $1 limit 1", [project.id]);
	onLog(publishedBefore ? "Creating the live database from the current data" : "Creating the live database");
	await dropDatabase(name);
	const passwordEnc = await createDatabase(name);
	const url = databaseUrl(name, passwordEnc);
	try {
		if (publishedBefore) await copyDatabase(projectDatabaseUrl(project), url);
	} catch (error) {
		await dropDatabase(name);
		throw error;
	}
	await query("update projects set live_db_name = $2, live_db_password_enc = $3 where id = $1", [project.id, name, passwordEnc]);
	project.live_db_name = name;
	project.live_db_password_enc = passwordEnc;
	return url;
}

/** Environment shared by the sandbox and published containers. Holds no organization secrets. */
/** Environment of the published app: its live database, the data gateway and its token. */
export async function publishedEnv(project: Project): Promise<Record<string, string>> {
	const env = appEnv(project);
	return {
		DATABASE_URL: await ensureLiveDatabase(project),
		AGENCY_GATEWAY_URL: env.AGENCY_GATEWAY_URL,
		AGENCY_APP_TOKEN: env.AGENCY_APP_TOKEN,
	};
}

export function appEnv(project: Project): Record<string, string> {
	return {
		DATABASE_URL: projectDatabaseUrl(project),
		AGENCY_GATEWAY_URL: `${config.internalUrl}/gateway`,
		AGENCY_APP_TOKEN: project.token,
		AGENCY_PROJECT_TOKEN: project.token,
		AGENCY_MCP_URL: `${config.internalUrl}/mcp`,
	};
}

export function sandboxEnv(project: Project): Record<string, string> {
	return { ...appEnv(project), AGENCY_DEV_ORIGINS: `*.${config.baseDomain}` };
}

export async function createProject(name: string, ownerId: string): Promise<Project> {
	const slug = await uniqueSlug(name);
	const dbName = `app_${slug.replace(/-/g, "_")}`;
	// Each app gets its own Postgres role and database for the preview; the live one comes with the first publish.
	const passwordEnc = await createDatabase(dbName);
	const project = await queryOne<Project>(
		"insert into projects (slug, name, owner_id, token, db_name, db_password_enc) values ($1, $2, $3, $4, $5, $6) returning *",
		[slug, name, ownerId, randomToken(), dbName, passwordEnc],
	);
	await ensureSandbox(project!);
	return project!;
}

export async function getProject(id: string): Promise<Project | undefined> {
	return queryOne<Project>("select * from projects where id = $1", [id]);
}

export async function projectByToken(token: string): Promise<Project | undefined> {
	if (!token) return undefined;
	return queryOne<Project>("select * from projects where token = $1", [token]);
}

export async function getProjectBySlug(slug: string): Promise<Project | undefined> {
	return queryOne<Project>("select * from projects where slug = $1", [slug]);
}

export async function listProjects(): Promise<Project[]> {
	return query<Project>("select * from projects order by created_at desc");
}

/**
 * Creates or starts the project's sandbox: the Next.js dev server and pi, with the workspace kept across
 * restarts. With `upgrade`, a sandbox made from an older image is recreated from the current one (the
 * workspace stays), so existing apps pick up a new system prompt and template helpers. Only upgrade while
 * the agent is idle.
 */
export function ensureSandbox(project: Project, options: { upgrade?: boolean } = {}): Promise<void> {
	return sandboxes.ensure(project, options);
}

export function sandboxOutdated(project: Project): Promise<boolean> {
	return sandboxes.outdated(project);
}

export async function deleteProject(project: Project): Promise<void> {
	await appRuntime.remove(project);
	await sandboxes.remove(project);
	await query("delete from projects where id = $1", [project.id]);
	await dropDatabase(project.db_name);
	if (project.live_db_name) await dropDatabase(project.live_db_name);
}
