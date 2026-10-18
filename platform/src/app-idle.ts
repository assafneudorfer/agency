import { appRuntime } from "./apps.ts";
import { appHost, config } from "./config.ts";
import { query, queryOne } from "./db.ts";
import { sendMail } from "./mail.ts";
import { appContainerName, getProject, type Project, publishedEnv } from "./projects.ts";

/**
 * Takes down published apps nobody opens, to free their server memory or cluster tasks. Every request to
 * a published app passes the platform's sign-in check (auth.ts), which counts as a visit. An app that runs
 * AGENCY_APP_IDLE_DAYS days (7 by default) without one is stopped and its owner gets an email. Only time
 * the platform runs counts, so a server stopped over a holiday doesn't take every app down when it starts.
 *
 * A taken-down app keeps its versions, database and address. Its next visit starts it again (a
 * low-priority Traefik router sends it to the platform, which shows a short "starting" page), and so
 * does Wake in the builder or publishing a version.
 */

const SWEEP_MS = 10 * 60_000;

const visited = new Map<string, number>();
const waking = new Map<string, Promise<void>>();

/** Records a visit to a published app. Writes at most every few minutes per app: every request passes here. */
export function recordAppVisit(projectId: string): void {
	const now = Date.now();
	if (now - (visited.get(projectId) ?? 0) < 5 * 60_000) return;
	visited.set(projectId, now);
	void query("update projects set app_idle_minutes = 0 where id = $1 and app_idle_minutes > 0", [projectId]).catch((error) =>
		console.error(`[app-idle] could not record a visit: ${error instanceof Error ? error.message : error}`),
	);
}

/** After a publish, rollback or wake: the app runs and its quiet time starts over. */
export async function markAwake(projectId: string): Promise<void> {
	visited.set(projectId, Date.now());
	await query("update projects set app_asleep_since = null, app_idle_minutes = 0 where id = $1", [projectId]);
}

/** Starts a taken-down app with its active version. Visitors arriving together share one start. */
export function wakeApp(project: Project): Promise<void> {
	let pending = waking.get(project.id);
	if (!pending) {
		pending = (async () => {
			const active = await queryOne<{ image: string; version: number }>("select image, version from deployments where project_id = $1 and active", [project.id]);
			if (!active) throw new Error("The app isn't published");
			console.log(`[app-idle] ${project.slug}: starting v${active.version} for a visit`);
			await appRuntime.run(project, active.image, await publishedEnv(project), (line) => console.log(`[app-idle] ${project.slug}: ${line}`));
			await markAwake(project.id);
			await waitForApp(project);
		})().finally(() => waking.delete(project.id));
		waking.set(project.id, pending);
	}
	return pending;
}

/** On this server, waits until the app's container answers. Cluster runtimes return from run() once tasks are up. */
async function waitForApp(project: Project): Promise<void> {
	if (config.appRuntime !== "docker") return;
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			await fetch(`http://${appContainerName(project)}:3000/`, { signal: AbortSignal.timeout(5000), redirect: "manual" });
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
}

/** Stops the app, keeping everything needed to start it again, and tells its owner. */
async function takeDown(project: Project): Promise<void> {
	console.log(`[app-idle] ${project.slug}: no visits for ${config.appIdleDays} days, taking it down`);
	await appRuntime.stop(project);
	await query("update projects set app_asleep_since = now() where id = $1", [project.id]);
	const owner = await queryOne<{ email: string; name: string }>("select email, name from users where id = $1", [project.owner_id]);
	if (!owner) return;
	const url = `${config.scheme}://${appHost(project.slug)}`;
	const days = config.appIdleDays === 1 ? "a day" : `${config.appIdleDays} days`;
	try {
		await sendMail({
			to: owner.email,
			subject: `${project.name} was taken offline after ${days} without visits`,
			text: [
				`Hi ${owner.name || owner.email},`,
				"",
				`Nobody has opened ${project.name} (${url}) for ${days}, so Agency took it offline to save resources.`,
				"Its versions, data and address are all kept.",
				"",
				`It starts again by itself the next time someone opens ${url}. The first visit takes up to a minute or two.`,
				`You can also start it from the app's Publish panel in Agency: ${config.publicUrl}/#/p/${project.id}`,
				"",
				"Agency",
			].join("\n"),
		});
	} catch (error) {
		console.error(`[app-idle] ${project.slug}: could not email ${owner.email}: ${error instanceof Error ? error.message : error}`);
	}
}

/** One pass: adds the time since the last pass to every running published app, then takes down those over the limit. */
export async function sweepIdleApps(elapsedMinutes: number): Promise<void> {
	await query(
		`update projects p set app_idle_minutes = app_idle_minutes + $1
		where app_asleep_since is null and exists (select 1 from deployments d where d.project_id = p.id and d.active)`,
		[elapsedMinutes],
	);
	const idle = await query<{ id: string }>("select id from projects where app_asleep_since is null and app_idle_minutes >= $1", [config.appIdleDays * 24 * 60]);
	for (const { id } of idle) {
		const project = await getProject(id);
		// A visit or publish since the query starts the count over.
		if (!project || project.app_asleep_since || project.app_idle_minutes < config.appIdleDays * 24 * 60 || waking.has(id)) continue;
		await takeDown(project).catch((error) => console.error(`[app-idle] ${project.slug}: could not take it down: ${error instanceof Error ? error.message : error}`));
	}
}

/** Runs the sweep every ten minutes while the platform runs. */
export function startAppIdleSweeper(): void {
	if (config.appIdleDays <= 0) return;
	let last = Date.now();
	let sweeping = false;
	setInterval(() => {
		if (sweeping) return;
		sweeping = true;
		const now = Date.now();
		// A long pause (a suspended machine) counts as one interval, not as quiet time.
		const elapsed = Math.round(Math.min(now - last, 2 * SWEEP_MS) / 60_000);
		last = now;
		sweepIdleApps(elapsed)
			.catch((error) => console.error(`[app-idle] ${error instanceof Error ? error.message : error}`))
			.finally(() => {
				sweeping = false;
			});
	}, SWEEP_MS).unref();
}
