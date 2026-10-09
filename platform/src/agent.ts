import type { ChildProcess } from "node:child_process";
import { config } from "./config.ts";
import { execIn, spawnDocker } from "./docker.ts";
import { ensureSandbox, type Project, sandboxName } from "./projects.ts";

export type AgentEvent = { type: string; [key: string]: unknown };
type Listener = (event: AgentEvent) => void;

interface Pending {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/**
 * Drives one pi process in RPC mode inside a project's sandbox.
 *
 * pi runs in the sandbox (not in this server) so its file edits and shell commands stay inside
 * the container. Commands go in as JSONL on stdin; responses and session events come back on stdout.
 */
export class AgentBridge {
	readonly project: Project;
	private child: ChildProcess | undefined;
	private buffer = "";
	private nextId = 0;
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<Listener>();
	running = false;

	constructor(project: Project) {
		this.project = project;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: AgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private async start(): Promise<ChildProcess> {
		if (this.child) return this.child;
		await ensureSandbox(this.project);
		const env: string[] = [];
		for (const name of config.agentEnv) {
			const value = process.env[name];
			if (value) env.push("-e", `${name}=${value}`);
		}
		const piArgs = [
			"pi",
			"--mode",
			"rpc",
			"--session-dir",
			"/workspace/.agency/sessions",
			"--session-id",
			this.project.id,
			"--append-system-prompt",
			"/opt/agency/system-prompt.md",
		];
		if (config.model) piArgs.push("--model", config.model);
		const child = spawnDocker(["exec", "-i", ...env, "-w", "/workspace", sandboxName(this.project), ...piArgs]);
		this.child = child;
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => this.onData(chunk));
		child.stderr!.on("data", (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text) console.error(`[agent ${this.project.slug}] ${text}`);
		});
		child.on("close", (code) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.running = false;
			for (const [id, pending] of this.pending) {
				clearTimeout(pending.timer);
				pending.reject(new Error(`Agent exited (${code})`));
				this.pending.delete(id);
			}
			this.emit({ type: "agency_agent_exit", code });
		});
		return child;
	}

	// RPC framing is LF-only; JSON strings may contain U+2028/U+2029, so no readline here.
	private onData(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim()) this.onRecord(line);
			newline = this.buffer.indexOf("\n");
		}
	}

	private onRecord(line: string): void {
		let record: AgentEvent;
		try {
			record = JSON.parse(line) as AgentEvent;
		} catch {
			console.error(`[agent ${this.project.slug}] unparsable output: ${line.slice(0, 200)}`);
			return;
		}
		if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
			const pending = this.pending.get(record.id)!;
			this.pending.delete(record.id);
			clearTimeout(pending.timer);
			if (record.success) pending.resolve(record.data);
			else pending.reject(new Error(String(record.error ?? "Agent command failed")));
			return;
		}
		if (record.type === "agent_start") this.running = true;
		this.emit(record);
		if (record.type === "agent_settled") {
			this.running = false;
			void this.commit();
		}
	}

	async request<T = unknown>(command: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
		const child = await this.start();
		const id = `req-${++this.nextId}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Agent did not answer ${String(command.type)} in time`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
			child.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	prompt(message: string): Promise<unknown> {
		return this.request({
			type: "prompt",
			message,
			...(this.running ? { streamingBehavior: "followUp" } : {}),
		});
	}

	abort(): Promise<unknown> {
		return this.request({ type: "abort" });
	}

	async messages(): Promise<unknown[]> {
		const data = await this.request<{ messages: unknown[] }>({ type: "get_messages" });
		return data.messages;
	}

	/** Commits the workspace after each settled run, so every change the agent makes is a restorable version. */
	async commit(message = "Agent changes"): Promise<string> {
		const script = `git add -A && (git diff --cached --quiet || git commit -q -m ${JSON.stringify(message)}) ; git rev-parse --short HEAD`;
		const result = await execIn(sandboxName(this.project), script);
		const commit = result.stdout.trim().split("\n").pop() ?? "";
		this.emit({ type: "agency_committed", commit });
		return commit;
	}

	stop(): void {
		this.child?.stdin?.end();
	}
}

const bridges = new Map<string, AgentBridge>();

export function bridgeFor(project: Project): AgentBridge {
	let bridge = bridges.get(project.id);
	if (!bridge) {
		bridge = new AgentBridge(project);
		bridges.set(project.id, bridge);
	}
	return bridge;
}

export function dropBridge(projectId: string): void {
	bridges.get(projectId)?.stop();
	bridges.delete(projectId);
}
