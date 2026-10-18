import { allBridges, bridgeIfAny, dropBridge } from "./agent.ts";
import { config } from "./config.ts";
import { docker, execIn } from "./docker.ts";
import { ensureSandbox, getProject, type Project, sandboxName } from "./projects.ts";

/**
 * Puts unused apps to sleep so a small server holds many apps. An app is in use while someone has
 * its builder open, its agent is working, or its preview gets requests. After a quiet spell its pi
 * process ends (the session is kept on disk), and later its sandbox container stops (files, history
 * and data stay in its volume and database). Opening the builder or the preview starts it again.
 * Published apps run in their own container and never sleep.
 */

const lastActive = new Map<string, number>();
const watchers = new Map<string, number>();
// Apps with no recorded activity count from when this server started, so a restart doesn't stop them at once.
const startedAt = Date.now();

/** Records activity on an app, which keeps it awake for another idle period. */
export function touch(projectId: string): void {
	lastActive.set(projectId, Date.now());
}

/** Counts an open builder (its event stream) for as long as it stays connected. */
export function watch(projectId: string): () => void {
	watchers.set(projectId, (watchers.get(projectId) ?? 0) + 1);
	touch(projectId);
	return () => {
		const left = (watchers.get(projectId) ?? 1) - 1;
		if (left > 0) watchers.set(projectId, left);
		else watchers.delete(projectId);
		touch(projectId);
	};
}

function quietFor(projectId: string): number {
	if (watchers.has(projectId) || bridgeIfAny(projectId)?.running) return 0;
	return Date.now() - (lastActive.get(projectId) ?? startedAt);
}

/** Starts the app's sandbox if it sleeps and records the visit. */
export async function wake(project: Project): Promise<void> {
	touch(project.id);
	await ensureSandbox(project);
}

/** Waits until the sandbox's dev server answers, so a woken preview doesn't load into an error. */
export async function waitForDevServer(project: Project, seconds = 60): Promise<boolean> {
	const script = `for i in $(seq 1 ${seconds}); do curl -s -o /dev/null --max-time 20 http://localhost:3000/ && exit 0; sleep 1; done; exit 1`;
	const result = await execIn(sandboxName(project), script, (seconds + 30) * 1000);
	return result.code === 0;
}

async function runningSandboxes(): Promise<string[]> {
	const result = await docker(
		["ps", "--filter", "label=agency.role=sandbox", "--filter", "status=running", "--format", '{{.Label "agency.project"}}'],
		{ allowFailure: true },
	);
	return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** One pass: ends idle pi processes, then stops sandboxes that stayed idle longer. */
export async function sweep(): Promise<void> {
	const piIdle = config.piIdleMinutes * 60_000;
	const sandboxIdle = config.sandboxIdleMinutes * 60_000;
	if (piIdle > 0) {
		for (const bridge of [...allBridges()]) {
			if (bridge.alive && quietFor(bridge.project.id) >= piIdle) {
				console.log(`[idle] ${bridge.project.slug}: ending idle agent`);
				await bridge.end();
			}
		}
	}
	if (sandboxIdle > 0) {
		for (const id of await runningSandboxes()) {
			if (quietFor(id) < sandboxIdle) continue;
			const project = await getProject(id);
			if (!project) continue;
			console.log(`[idle] ${project.slug}: stopping idle sandbox`);
			dropBridge(id);
			await docker(["stop", "-t", "10", sandboxName(project)], { allowFailure: true });
		}
	}
}

/** Runs the sweep every minute. */
export function startIdleSweeper(): void {
	if (config.piIdleMinutes <= 0 && config.sandboxIdleMinutes <= 0) return;
	let sweeping = false;
	setInterval(() => {
		if (sweeping) return;
		sweeping = true;
		sweep()
			.catch((error) => console.error(`[idle] ${error instanceof Error ? error.message : error}`))
			.finally(() => {
				sweeping = false;
			});
	}, 60_000).unref();
}
