import { appHost, config } from "./config.ts";
import { query, queryOne } from "./db.ts";
import { docker, envArgs, execIn, labelArgs, routeLabels, spawnDocker } from "./docker.ts";
import { bridgeFor } from "./agent.ts";
import { appContainerName, appEnv, type Project, sandboxName } from "./projects.ts";

export interface Deployment {
	id: number;
	project_id: string;
	version: number;
	image: string;
	git_commit: string;
	created_at: string;
	active: boolean;
}

// Builds into .next-build so the running dev server's .next directory is left alone.
const RELEASE_SCRIPT = `
set -euo pipefail
export NEXT_DIST_DIR=.next-build
npm run build
rm -rf /tmp/agency-release
cp -a .next-build/standalone /tmp/agency-release
mkdir -p /tmp/agency-release/.next-build
cp -a .next-build/static /tmp/agency-release/.next-build/static
[ -d public ] && cp -a public /tmp/agency-release/public || true
cat > /tmp/agency-release/Dockerfile <<'DOCKERFILE'
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_DIST_DIR=.next-build
COPY --chown=node:node . .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
DOCKERFILE
`;

const publishing = new Set<string>();

export async function listDeployments(project: Project): Promise<Deployment[]> {
	return query<Deployment>("select * from deployments where project_id = $1 order by version desc", [project.id]);
}

/** Pipes the release directory out of the sandbox as a tar stream straight into `docker build -`. */
function buildImage(project: Project, tag: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const tar = spawnDocker(["exec", sandboxName(project), "tar", "-C", "/tmp/agency-release", "-cf", "-", "."]);
		const build = spawnDocker(["build", "-t", tag, "-"]);
		let log = "";
		tar.stdout!.pipe(build.stdin!);
		tar.stderr!.on("data", (chunk) => {
			log += chunk;
		});
		build.stdout!.on("data", (chunk) => {
			log += chunk;
		});
		build.stderr!.on("data", (chunk) => {
			log += chunk;
		});
		tar.on("error", reject);
		build.on("error", reject);
		build.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Image build failed:\n${log.slice(-4000)}`));
		});
	});
}

async function runApp(project: Project, image: string): Promise<void> {
	const name = appContainerName(project);
	await docker(["rm", "-f", name], { allowFailure: true });
	const env = appEnv(project);
	await docker([
		"run",
		"-d",
		"--name",
		name,
		"--network",
		config.dockerNetwork,
		"--restart",
		"unless-stopped",
		"--memory",
		config.appMemory,
		...envArgs({
			DATABASE_URL: env.DATABASE_URL,
			AGENCY_GATEWAY_URL: env.AGENCY_GATEWAY_URL,
			AGENCY_APP_TOKEN: env.AGENCY_APP_TOKEN,
		}),
		...labelArgs({
			"agency.project": project.id,
			"agency.role": "app",
			...routeLabels(`app-${project.slug}`, appHost(project.slug), 3000),
		}),
		image,
	]);
}

export async function publish(project: Project, userId: string, onLog: (line: string) => void): Promise<Deployment> {
	if (publishing.has(project.id)) throw new Error("A publish is already running for this app");
	const bridge = bridgeFor(project);
	if (bridge.running) throw new Error("Wait for the agent to finish before publishing");
	publishing.add(project.id);
	try {
		onLog("Saving the current version");
		const commit = await bridge.commit("Publish");
		onLog("Building for production");
		const build = await execIn(sandboxName(project), RELEASE_SCRIPT, 15 * 60_000);
		if (build.code !== 0) throw new Error(`Build failed:\n${(build.stdout + build.stderr).slice(-4000)}`);
		const last = await queryOne<{ version: number }>(
			"select coalesce(max(version), 0) as version from deployments where project_id = $1",
			[project.id],
		);
		const version = (last?.version ?? 0) + 1;
		const image = `agency-app-${project.slug}:v${version}`;
		onLog(`Packaging image ${image}`);
		await buildImage(project, image);
		onLog(`Starting ${appHost(project.slug)}`);
		await runApp(project, image);
		await query("update deployments set active = false where project_id = $1", [project.id]);
		const deployment = await queryOne<Deployment>(
			"insert into deployments (project_id, version, image, git_commit, created_by, active) values ($1, $2, $3, $4, $5, true) returning *",
			[project.id, version, image, commit, userId],
		);
		return deployment!;
	} finally {
		publishing.delete(project.id);
	}
}

export async function rollback(project: Project, version: number): Promise<Deployment> {
	const target = await queryOne<Deployment>("select * from deployments where project_id = $1 and version = $2", [
		project.id,
		version,
	]);
	if (!target) throw new Error(`Version ${version} not found`);
	await runApp(project, target.image);
	await query("update deployments set active = (version = $2) where project_id = $1", [project.id, version]);
	return { ...target, active: true };
}

export async function unpublish(project: Project): Promise<void> {
	await docker(["rm", "-f", appContainerName(project)], { allowFailure: true });
	await query("update deployments set active = false where project_id = $1", [project.id]);
}
