import { type ChildProcess, spawn } from "node:child_process";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs the docker CLI and collects its output. Rejects on a non-zero exit unless allowFailure is set. */
export function docker(args: string[], options: { allowFailure?: boolean; timeoutMs?: number } = {}): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
		child.on("error", reject);
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			const result = { code: code ?? 1, stdout, stderr };
			if (result.code !== 0 && !options.allowFailure) {
				reject(new Error(`docker ${args[0]} failed (${result.code}): ${stderr.trim() || stdout.trim()}`));
			} else {
				resolve(result);
			}
		});
	});
}

export function spawnDocker(args: string[]): ChildProcess {
	return spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
}

/** Runs a shell command inside a container as root in /workspace. */
export function execIn(container: string, script: string, timeoutMs = 120_000): Promise<RunResult> {
	return docker(["exec", "-w", "/workspace", container, "bash", "-lc", script], { allowFailure: true, timeoutMs });
}

export async function containerState(name: string): Promise<"running" | "stopped" | "missing"> {
	const result = await docker(["inspect", "-f", "{{.State.Running}}", name], { allowFailure: true });
	if (result.code !== 0) return "missing";
	return result.stdout.trim() === "true" ? "running" : "stopped";
}

export function labelArgs(labels: Record<string, string>): string[] {
	return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

export function envArgs(env: Record<string, string>): string[] {
	return Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

/** Traefik labels that route a host name to a container port behind the agency-auth middleware. */
export function routeLabels(router: string, host: string, port: number): Record<string, string> {
	return {
		"traefik.enable": "true",
		[`traefik.http.routers.${router}.rule`]: `Host(\`${host}\`)`,
		[`traefik.http.routers.${router}.entrypoints`]: "app",
		[`traefik.http.routers.${router}.middlewares`]: "agency-auth@docker",
		[`traefik.http.routers.${router}.service`]: router,
		[`traefik.http.services.${router}.loadbalancer.server.port`]: String(port),
	};
}
