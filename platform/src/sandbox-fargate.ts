import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
	DescribeTaskDefinitionCommand,
	DescribeTasksCommand,
	ListTasksCommand,
	RegisterTaskDefinitionCommand,
	RunTaskCommand,
	StopTaskCommand,
} from "@aws-sdk/client-ecs";
import { config, previewHost } from "./config.ts";
import { docker, imageId } from "./docker.ts";
import { clusterEnv, clusterTasks, ecs, environment, imageExists, pushImage, repositoryUri, writeRoutes } from "./ecs.ts";
import { getProjectBySlug, type Project, sandboxEnv, sandboxName } from "./projects.ts";
import type { SandboxProcess, SandboxRuntime } from "./sandboxes.ts";

/**
 * Sandboxes on AWS Fargate: each app's sandbox is an ECS task that runs only while someone builds.
 *
 * The workspace (code, git history, chat sessions) lives on EFS under workspaces/<slug>, so a task can
 * stop when idle and a new one picks up where it left off. node_modules and the Next.js caches are on
 * the task's own disk, filled from the image on start, because npm and the dev server are slow on a
 * network file system. The platform runs commands through sandboxd (sandbox/opt/sandboxd.mjs), a small
 * server in the task that only this server can reach, authenticated with a per-app token. Traefik sends
 * the app's preview host to the task's private address; with no task the platform's wake page starts one.
 */

const sb = config.sandboxFargate;
const cluster = config.ecs.cluster;
const SANDBOXD_PORT = 7070;

const startedBy = (project: Project) => `sandbox-${project.slug}`;
const family = (project: Project) => `${cluster}-sandbox-${project.slug}`;
const workspaceDir = (project: Project) => join(sb.efsDir, "workspaces", project.slug);
const sandboxdToken = (project: Project) => createHmac("sha256", config.secretKey).update(`sandboxd:${project.id}`).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Live {
	projectId: string;
	address: string;
	image: string;
	/** sandboxd answered since this task started, so commands can run. */
	ready: boolean;
}

/** Running sandbox tasks by slug, refreshed every 15 seconds and whenever one starts or stops. */
let live = new Map<string, Live>();

// ---------------------------------------------------------------------------
// Image and task definition

let currentImage: Promise<string> | undefined;

/** The sandbox image built on this server, uploaded to ECR once per version. */
function sandboxImage(): Promise<string> {
	currentImage ??= (async () => {
		const id = (await imageId(config.sandboxImage, "image")).replace("sha256:", "").slice(0, 16);
		if (!id) throw new Error(`Sandbox image ${config.sandboxImage} not found on this server`);
		const tag = `sandbox-${id}`;
		const remote = `${await repositoryUri(sb.repository)}:${tag}`;
		if (!(await imageExists(sb.repository, tag))) {
			console.log(`[sandbox] uploading ${config.sandboxImage} to ${sb.repository}`);
			await pushImage(config.sandboxImage, remote);
		}
		return remote;
	})().catch((error) => {
		currentImage = undefined;
		throw error;
	});
	return currentImage;
}

const definitions = new Map<string, { image: string; arn: string }>();

async function taskDefinition(project: Project, image: string): Promise<string> {
	const cached = definitions.get(project.slug);
	if (cached?.image === image) return cached.arn;
	const latest = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: family(project) })).catch(() => undefined);
	const existing = latest?.taskDefinition;
	if (existing?.taskDefinitionArn && existing.status === "ACTIVE" && existing.containerDefinitions?.[0]?.image === image) {
		definitions.set(project.slug, { image, arn: existing.taskDefinitionArn });
		return existing.taskDefinitionArn;
	}
	const registered = await ecs.send(
		new RegisterTaskDefinitionCommand({
			family: family(project),
			networkMode: "awsvpc",
			requiresCompatibilities: ["FARGATE"],
			cpu: sb.cpu,
			memory: sb.memoryMb,
			executionRoleArn: config.ecs.executionRoleArn,
			volumes: [
				{
					name: "workspace",
					efsVolumeConfiguration: { fileSystemId: sb.efsId, rootDirectory: `/workspaces/${project.slug}`, transitEncryption: "ENABLED" },
				},
				// On the task's own disk: rebuilt on every start, fast for npm and the dev server.
				{ name: "node-modules" },
				{ name: "next" },
				{ name: "next-build" },
			],
			containerDefinitions: [
				{
					name: "sandbox",
					image,
					essential: true,
					portMappings: [{ containerPort: 3000 }, { containerPort: SANDBOXD_PORT }],
					mountPoints: [
						{ sourceVolume: "workspace", containerPath: "/workspace" },
						{ sourceVolume: "node-modules", containerPath: "/workspace/node_modules" },
						{ sourceVolume: "next", containerPath: "/workspace/.next" },
						{ sourceVolume: "next-build", containerPath: "/workspace/.next-build" },
					],
					stopTimeout: 30,
					logConfiguration: {
						logDriver: "awslogs",
						options: { "awslogs-group": config.ecs.logGroup, "awslogs-region": config.awsRegion, "awslogs-stream-prefix": `sandbox-${project.slug}` },
					},
				},
			],
			tags: [{ key: "agency.project", value: project.id }],
		}),
	);
	const arn = registered.taskDefinition!.taskDefinitionArn!;
	definitions.set(project.slug, { image, arn });
	return arn;
}

// ---------------------------------------------------------------------------
// Tasks

/** Apps built while sandboxes ran on this server keep their files: their docker volume is copied over once. */
async function prepareWorkspace(project: Project): Promise<void> {
	const dir = workspaceDir(project);
	if (existsSync(dir)) return;
	const partial = `${dir}.partial`;
	await rm(partial, { recursive: true, force: true });
	await mkdir(partial, { recursive: true });
	const volume = `agency-ws-${project.slug}`;
	if ((await docker(["volume", "inspect", volume], { allowFailure: true })).code === 0) {
		console.log(`[sandbox] ${project.slug}: moving the workspace to EFS`);
		await docker(["rm", "-f", sandboxName(project)], { allowFailure: true });
		await docker(
			[
				"run",
				"--rm",
				"--entrypoint",
				"sh",
				"-v",
				`${volume}:/from:ro`,
				"-v",
				`${partial}:/to`,
				config.sandboxImage,
				"-c",
				"cd /from && tar --exclude=./node_modules --exclude=./.next --exclude=./.next-build -cf - . | tar -C /to -xf -",
			],
			{ timeoutMs: 15 * 60_000 },
		);
	}
	await rename(partial, dir);
}

async function findTask(project: Project): Promise<{ arn: string; status: string; image: string } | undefined> {
	const list = await ecs.send(new ListTasksCommand({ cluster, startedBy: startedBy(project), desiredStatus: "RUNNING" }));
	if (!list.taskArns?.length) return undefined;
	const described = await ecs.send(new DescribeTasksCommand({ cluster, tasks: list.taskArns }));
	const task = described.tasks?.find((t) => t.desiredStatus === "RUNNING");
	return task?.taskArn ? { arn: task.taskArn, status: task.lastStatus ?? "", image: task.containers?.[0]?.image ?? "" } : undefined;
}

async function runTask(project: Project, image: string): Promise<string> {
	const definition = await taskDefinition(project, image);
	const env = clusterEnv({ ...sandboxEnv(project), AGENCY_SANDBOXD_TOKEN: sandboxdToken(project) });
	let failure = "";
	// Spot first; when AWS has no Spot capacity at the moment, regular Fargate.
	for (const provider of sb.spot ? ["FARGATE_SPOT", "FARGATE"] : ["FARGATE"]) {
		const result = await ecs.send(
			new RunTaskCommand({
				cluster,
				taskDefinition: definition,
				count: 1,
				startedBy: startedBy(project),
				capacityProviderStrategy: [{ capacityProvider: provider, weight: 1 }],
				networkConfiguration: { awsvpcConfiguration: { subnets: config.ecs.subnets, securityGroups: [sb.securityGroup], assignPublicIp: "ENABLED" } },
				overrides: { containerOverrides: [{ name: "sandbox", environment: environment(env) }] },
				tags: [{ key: "agency.project", value: project.id }],
			}),
		);
		const arn = result.tasks?.[0]?.taskArn;
		if (arn) return arn;
		failure = (result.failures ?? []).map((f) => f.reason ?? f.detail).join(", ");
	}
	throw new Error(`Could not start the sandbox: ${failure || "no reason given"}`);
}

/** Waits until the task runs and sandboxd answers; returns the task's private address. */
async function waitReady(project: Project, arn: string): Promise<string> {
	const deadline = Date.now() + 5 * 60_000;
	let address = "";
	while (!address) {
		if (Date.now() > deadline) throw new Error("The sandbox took more than 5 minutes to start");
		const task = (await ecs.send(new DescribeTasksCommand({ cluster, tasks: [arn] }))).tasks?.[0];
		if (!task || task.lastStatus === "STOPPED" || task.desiredStatus === "STOPPED") {
			throw new Error(`The sandbox stopped while starting: ${task?.stoppedReason ?? task?.containers?.[0]?.reason ?? "unknown reason"}`);
		}
		if (task.lastStatus === "RUNNING") {
			address = task.attachments?.flatMap((a) => a.details ?? []).find((d) => d.name === "privateIPv4Address")?.value ?? "";
		}
		if (!address) await sleep(2000);
	}
	while (!(await healthy(address))) {
		if (Date.now() > deadline) throw new Error("The sandbox started but does not answer");
		await sleep(1000);
	}
	return address;
}

function healthy(address: string): Promise<boolean> {
	return new Promise((resolve) => {
		const req = request({ host: address, port: SANDBOXD_PORT, path: "/health", timeout: 3000 }, (res) => {
			res.resume();
			resolve(res.statusCode === 200);
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(false));
		req.end();
	});
}

const starting = new Map<string, Promise<void>>();

async function ensure(project: Project, upgrade: boolean): Promise<void> {
	const image = await sandboxImage();
	let task = await findTask(project);
	if (task && upgrade && task.image !== image) {
		await ecs.send(new StopTaskCommand({ cluster, task: task.arn, reason: "Newer sandbox image" }));
		task = undefined;
	}
	if (!task) await prepareWorkspace(project);
	const arn = task?.arn ?? (await runTask(project, image));
	const address = await waitReady(project, arn);
	live.set(project.slug, { projectId: project.id, address, image: task?.image ?? image, ready: true });
	await writeSandboxRoutes();
}

// ---------------------------------------------------------------------------
// Routes

async function writeSandboxRoutes(): Promise<void> {
	await writeRoutes(
		"sandboxes.yml",
		[...live].map(([slug, sandbox]) => ({ name: `sbx-${slug}`, host: previewHost(slug), urls: [`http://${sandbox.address}:3000`] })),
	);
}

let lastRoutes = "";

async function refresh(): Promise<void> {
	const next = new Map<string, Live>();
	for (const task of await clusterTasks()) {
		if (!task.startedBy?.startsWith("sandbox-") || task.lastStatus !== "RUNNING" || !task.address) continue;
		const slug = task.startedBy.slice("sandbox-".length);
		const projectId = task.tags?.find((t) => t.key === "agency.project")?.value ?? "";
		const known = live.get(slug);
		next.set(slug, { projectId, address: task.address, image: task.containers?.[0]?.image ?? "", ready: known?.address === task.address && known.ready });
	}
	live = next;
	const routes = JSON.stringify([...live].map(([slug, s]) => [slug, s.address]));
	if (routes === lastRoutes) return;
	lastRoutes = routes;
	await writeSandboxRoutes();
}

// ---------------------------------------------------------------------------
// Commands, through sandboxd

/**
 * One command in the sandbox over a single HTTP request: the request body is a length-prefixed JSON
 * spec followed by the command's stdin; the response is frames of [type, length, data] where type 1 is
 * stdout, 2 stderr, and 3 the exit code. Ending the request closes stdin; dropping it kills the command.
 */
class RemoteProcess extends EventEmitter implements SandboxProcess {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	private destroy: (() => void) | undefined;
	private killed = false;
	private finished = false;

	constructor(target: Promise<{ address: string; token: string }>, spec: { argv: string[]; env: Record<string, string> }) {
		super();
		target.then(
			({ address, token }) => {
				if (this.killed) return this.finish(null);
				const req = request({
					host: address,
					port: SANDBOXD_PORT,
					method: "POST",
					path: "/exec",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
				});
				this.destroy = () => req.destroy();
				const head = Buffer.from(JSON.stringify({ ...spec, cwd: "/workspace" }));
				const length = Buffer.alloc(4);
				length.writeUInt32BE(head.length);
				req.write(Buffer.concat([length, head]));
				this.stdin.pipe(req);
				req.on("response", (res) => {
					if (res.statusCode !== 200) {
						res.resume();
						return this.fail(new Error(`sandboxd answered ${res.statusCode}`));
					}
					let buffer = Buffer.alloc(0);
					let code: number | null = null;
					res.on("data", (chunk: Buffer) => {
						buffer = Buffer.concat([buffer, chunk]);
						while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
							const size = buffer.readUInt32BE(1);
							const data = buffer.subarray(5, 5 + size);
							if (buffer[0] === 1) this.stdout.write(data);
							else if (buffer[0] === 2) this.stderr.write(data);
							else if (buffer[0] === 3) code = data.readInt32BE(0);
							buffer = buffer.subarray(5 + size);
						}
					});
					res.on("end", () => this.finish(code));
					res.on("error", () => this.finish(code));
					res.on("close", () => this.finish(code));
				});
				req.on("error", (error) => this.fail(error));
			},
			(error) => this.fail(error),
		);
	}

	kill(): void {
		this.killed = true;
		this.destroy?.();
	}

	private fail(error: Error): void {
		if (this.finished) return;
		this.stderr.write(`${error.message}\n`);
		if (this.listenerCount("error") > 0) this.emit("error", error);
		this.finish(null);
	}

	private finish(code: number | null): void {
		if (this.finished) return;
		this.finished = true;
		this.stdout.end();
		this.stderr.end();
		this.stdin.unpipe();
		// Let readers drain the streams before close, as a child process does.
		setImmediate(() => this.emit("close", code));
	}
}

export function remoteProcess(target: Promise<{ address: string; token: string }>, argv: string[], env: Record<string, string>): SandboxProcess {
	return new RemoteProcess(target, { argv, env });
}

// ---------------------------------------------------------------------------

export const fargateSandboxes: SandboxRuntime = {
	ensure(project, options = {}) {
		const known = live.get(project.slug);
		if (known?.ready && !options.upgrade) return Promise.resolve();
		let pending = starting.get(project.id);
		if (!pending) {
			pending = ensure(project, Boolean(options.upgrade)).finally(() => starting.delete(project.id));
			starting.set(project.id, pending);
		}
		return pending;
	},

	async state(project) {
		if (live.has(project.slug)) return "running";
		return existsSync(workspaceDir(project)) || (await docker(["volume", "inspect", `agency-ws-${project.slug}`], { allowFailure: true })).code === 0
			? "stopped"
			: "missing";
	},

	async outdated(project) {
		const running = live.get(project.slug);
		if (!running?.image) return false;
		return running.image !== (await sandboxImage());
	},

	async stop(project) {
		const task = await findTask(project);
		if (task) await ecs.send(new StopTaskCommand({ cluster, task: task.arn, reason: "Idle" }));
		live.delete(project.slug);
		await writeSandboxRoutes();
	},

	async remove(project) {
		await this.stop(project);
		await rm(workspaceDir(project), { recursive: true, force: true });
		await docker(["rm", "-f", sandboxName(project)], { allowFailure: true });
		await docker(["volume", "rm", "-f", `agency-ws-${project.slug}`], { allowFailure: true });
	},

	async runningProjects() {
		const ids: string[] = [];
		for (const [slug, sandbox] of live) {
			const id = sandbox.projectId || (await getProjectBySlug(slug))?.id;
			if (id) ids.push(id);
		}
		return ids;
	},

	spawn(project, argv, env = {}) {
		const target = (async () => {
			await this.ensure(project);
			const sandbox = live.get(project.slug);
			if (!sandbox) throw new Error("The sandbox is not running");
			return { address: sandbox.address, token: sandboxdToken(project) };
		})();
		return remoteProcess(target, argv, clusterEnv(env));
	},

	start() {
		// Sandboxes that ran on this server before the switch: nothing would put them to sleep any more.
		// Their volumes stay until each app's workspace moves to EFS on first use.
		void docker(["ps", "-aq", "--filter", "label=agency.role=sandbox"], { allowFailure: true }).then(async (result) => {
			const ids = result.stdout.split("\n").filter(Boolean);
			if (ids.length > 0) await docker(["rm", "-f", ...ids], { allowFailure: true });
		});
		// Upload the sandbox image in the background so the first sandbox starts sooner.
		sandboxImage().catch((error) => console.error(`[sandbox] could not upload the sandbox image: ${error instanceof Error ? error.message : error}`));
		const tick = () =>
			refresh()
				.catch((error) => console.error(`[sandbox] could not refresh sandboxes: ${error instanceof Error ? error.message : error}`))
				.finally(() => setTimeout(tick, 15_000).unref());
		tick();
	},
};
