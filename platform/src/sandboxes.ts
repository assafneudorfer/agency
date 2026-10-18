import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { config, previewHost } from "./config.ts";
import { containerState, docker, envArgs, imageId, labelArgs, type RunResult, routeLabels } from "./docker.ts";
import { removeRoutes } from "./ecs.ts";
import { type Project, sandboxEnv, sandboxName } from "./projects.ts";
import { fargateSandboxes } from "./sandbox-fargate.ts";

/** A command running in a sandbox, shaped like a child process so callers don't care where it runs. */
export interface SandboxProcess extends EventEmitter {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	kill(signal?: NodeJS.Signals): void;
}

/**
 * Where sandboxes run: a container per app on this server (the default), or an ECS task per app on
 * AWS Fargate that runs only while someone builds. Either way the sandbox runs the Next.js dev server
 * and pi, keeps its workspace across restarts, and is put to sleep when idle (see idle.ts).
 */
export interface SandboxRuntime {
	/** Starts the sandbox if it isn't running and waits until commands can run in it. */
	ensure(project: Project, options?: { upgrade?: boolean }): Promise<void>;
	state(project: Project): Promise<"running" | "stopped" | "missing">;
	/** True when the sandbox runs an older sandbox image than the current one. */
	outdated(project: Project): Promise<boolean>;
	/** Puts the sandbox to sleep; its workspace stays. */
	stop(project: Project): Promise<void>;
	/** Removes the sandbox and its workspace. */
	remove(project: Project): Promise<void>;
	/** Ids of the projects whose sandboxes are running. */
	runningProjects(): Promise<string[]>;
	/** Runs a command in /workspace. `env` is added to the sandbox's environment for this command only. */
	spawn(project: Project, argv: string[], env?: Record<string, string>): SandboxProcess;
	start(): void;
}

const dockerSandboxes: SandboxRuntime = {
	async ensure(project, options = {}) {
		const name = sandboxName(project);
		if (options.upgrade && (await this.outdated(project))) await docker(["rm", "-f", name]);
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
	},

	state(project) {
		return containerState(sandboxName(project));
	},

	async outdated(project) {
		const [current, latest] = await Promise.all([imageId(sandboxName(project), "container"), imageId(config.sandboxImage, "image")]);
		return Boolean(current && latest && current !== latest);
	},

	async stop(project) {
		await docker(["stop", "-t", "10", sandboxName(project)], { allowFailure: true });
	},

	async remove(project) {
		await docker(["rm", "-f", sandboxName(project)], { allowFailure: true });
		await docker(["volume", "rm", "-f", `agency-ws-${project.slug}`], { allowFailure: true });
	},

	async runningProjects() {
		const result = await docker(
			["ps", "--filter", "label=agency.role=sandbox", "--filter", "status=running", "--format", '{{.Label "agency.project"}}'],
			{ allowFailure: true },
		);
		return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
	},

	spawn(project, argv, env = {}) {
		// `-e NAME` takes the value from the docker CLI's environment, so secrets stay off the command line.
		const names = Object.keys(env).flatMap((name) => ["-e", name]);
		return spawn("docker", ["exec", "-i", ...names, "-w", "/workspace", sandboxName(project), ...argv], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...env },
		});
	},

	start() {
		void removeRoutes("sandboxes.yml");
	},
};

export const sandboxes: SandboxRuntime = config.sandboxRuntime === "fargate" ? fargateSandboxes : dockerSandboxes;

/**
 * Runs a command (no shell interpolation of arguments) in the sandbox's /workspace, optionally writing
 * `input` to its stdin. Output stays binary so file contents survive intact.
 */
export function execArgv(
	project: Project,
	argv: string[],
	options: { input?: Buffer | string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
	return new Promise((resolve) => {
		const child = sandboxes.spawn(project, argv);
		const chunks: Buffer[] = [];
		let stderr = "";
		let settled = false;
		const done = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout: Buffer.concat(chunks), stderr });
		};
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30_000);
		child.on("error", (error: Error) => {
			stderr += error.message;
			done(1);
		});
		child.on("close", (code: number | null) => done(code ?? 1));
		child.stdin.on("error", () => {});
		child.stdin.end(options.input);
	});
}

/** Runs a shell script in the sandbox's /workspace. */
export async function execIn(project: Project, script: string, timeoutMs = 120_000): Promise<RunResult> {
	const result = await execArgv(project, ["bash", "-lc", script], { timeoutMs });
	return { code: result.code, stdout: result.stdout.toString(), stderr: result.stderr };
}
