import { config, previewHost } from "./config.ts";
import { decryptJson, encryptJson, randomToken } from "./crypto.ts";
import { pool, query, queryOne } from "./db.ts";
import { containerState, docker, envArgs, labelArgs, routeLabels } from "./docker.ts";

export interface Project {
	id: string;
	slug: string;
	name: string;
	owner_id: string;
	token: string;
	db_name: string;
	db_password_enc: string;
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

export function projectDatabaseUrl(project: Project): string {
	const password = decryptJson<string>(project.db_password_enc);
	return `postgres://${project.db_name}:${password}@${config.projectDbHost}:5432/${project.db_name}`;
}

/** Environment shared by the sandbox and published containers. Holds no organization secrets. */
export function appEnv(project: Project): Record<string, string> {
	return {
		DATABASE_URL: projectDatabaseUrl(project),
		AGENCY_GATEWAY_URL: `${config.internalUrl}/gateway`,
		AGENCY_APP_TOKEN: project.token,
		AGENCY_PROJECT_TOKEN: project.token,
		AGENCY_MCP_URL: `${config.internalUrl}/mcp`,
	};
}

function sandboxEnv(project: Project): Record<string, string> {
	return { ...appEnv(project), AGENCY_DEV_ORIGINS: `*.${config.baseDomain}` };
}

export async function createProject(name: string, ownerId: string): Promise<Project> {
	const slug = await uniqueSlug(name);
	const dbName = `app_${slug.replace(/-/g, "_")}`;
	const password = randomToken(24);
	// Each app gets its own Postgres role and database. Identifiers come from slugify, so they are safe to inline.
	await pool.query(`create role ${dbName} login password '${password.replace(/'/g, "''")}'`);
	await pool.query(`create database ${dbName} owner ${dbName}`);
	await pool.query(`revoke all on database ${dbName} from public`);
	const project = await queryOne<Project>(
		"insert into projects (slug, name, owner_id, token, db_name, db_password_enc) values ($1, $2, $3, $4, $5, $6) returning *",
		[slug, name, ownerId, randomToken(), dbName, encryptJson(password)],
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

export async function listProjects(): Promise<Project[]> {
	return query<Project>("select * from projects order by created_at desc");
}

/** Creates or starts the project's sandbox: a container running the Next.js dev server with the workspace volume. */
export async function ensureSandbox(project: Project): Promise<void> {
	const name = sandboxName(project);
	const state = await containerState(name);
	if (state === "running") return;
	if (state === "stopped") {
		await docker(["start", name]);
		return;
	}
	await docker([
		"run",
		"-d",
		"--name",
		name,
		"--hostname",
		project.slug,
		"--network",
		config.dockerNetwork,
		"--restart",
		"unless-stopped",
		"--memory",
		config.sandboxMemory,
		"--cpus",
		config.sandboxCpus,
		"--pids-limit",
		"1024",
		"-v",
		`agency-ws-${project.slug}:/workspace`,
		...envArgs(sandboxEnv(project)),
		...labelArgs({
			"agency.project": project.id,
			"agency.role": "sandbox",
			...routeLabels(`sbx-${project.slug}`, previewHost(project.slug), 3000),
		}),
		config.sandboxImage,
	]);
}

export async function deleteProject(project: Project): Promise<void> {
	await docker(["rm", "-f", sandboxName(project), appContainerName(project)], { allowFailure: true });
	await docker(["volume", "rm", "-f", `agency-ws-${project.slug}`], { allowFailure: true });
	const images = await docker(["images", "-q", `agency-app-${project.slug}`], { allowFailure: true });
	const ids = images.stdout.split("\n").filter(Boolean);
	if (ids.length > 0) await docker(["rmi", "-f", ...ids], { allowFailure: true });
	await query("delete from projects where id = $1", [project.id]);
	await pool.query(`drop database if exists ${project.db_name} with (force)`);
	await pool.query(`drop role if exists ${project.db_name}`);
}
