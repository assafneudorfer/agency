import type { ImageContent } from "./attachments.ts";
import { bedrockAgentEnv } from "./bedrock.ts";
import { config } from "./config.ts";
import { autoPush } from "./github.ts";
import { resolveModel } from "./models.ts";
import { ensureSandbox, type Project } from "./projects.ts";
import { execIn, type SandboxProcess, sandboxes } from "./sandboxes.ts";
import { installSkills, skillsFingerprint } from "./skills.ts";
import { recordUsage } from "./usage.ts";

export type AgentEvent = { type: string; [key: string]: unknown };

/**
 * How the agent answers a chat message. Auto builds (edits files, runs commands). Chat and Plan get
 * read-only tools (plus the organization data tools) and an extra instruction; Plan ends with a plan
 * for the member to approve before anything is built.
 */
export const CHAT_MODES = ["auto", "plan", "chat"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

const READ_ONLY_TOOLS = "read,grep,find,ls";

const MODE_PROMPTS: Record<ChatMode, string> = {
	auto: "",
	chat: `## Mode: Chat

The person switched the chat to Chat mode: they want to talk about the app, not change it. Answer questions and discuss ideas about the app, its code and its data. You can read files and look at the organization's data, but in this mode you cannot edit files or run commands. If they ask for a change, say briefly how you would do it and that they can switch to Plan or Auto to have it built.`,
	plan: `## Mode: Plan

The person switched the chat to Plan mode: they want to agree on a plan before anything is built. Do not change anything yet; in this mode you can only read files and look at the organization's data. Look at what you need, then reply with a short plan in plain language: what the app will do and look like, the main steps, which data sources it uses, and any questions you need answered. End by asking them to approve the plan or say what to change. When they approve, they switch to Auto and you build it.`,
};
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
	private child: SandboxProcess | undefined;
	private buffer = "";
	private nextId = 0;
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<Listener>();
	running = false;
	// The user whose prompt the agent is working on; the cost of each assistant message is charged to them.
	private promptedBy: string | undefined;
	// Whose skills pi loads: the member prompting it, or the owner until someone does.
	private skillsOf: string;
	// Fingerprint of the skills the running pi was started with.
	private loadedSkills = "";
	// Mode and model for the next start, and what the running pi has.
	private mode: ChatMode = "auto";
	private model: string | undefined;
	private loadedMode: ChatMode = "auto";
	private loadedModel = "";

	constructor(project: Project) {
		this.project = project;
		this.skillsOf = project.owner_id;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: AgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private starting: Promise<SandboxProcess> | undefined;

	private start(): Promise<SandboxProcess> {
		if (this.child) return Promise.resolve(this.child);
		this.starting ??= this.launch().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async launch(): Promise<SandboxProcess> {
		await ensureSandbox(this.project);
		// A skill that fails to copy shouldn't stop anyone building; pi then starts without skills.
		const skills = await installSkills(this.project, this.skillsOf).catch((error) => {
			console.error(`[agent ${this.project.slug}] ${error instanceof Error ? error.message : error}`);
			return { dirs: [] as string[], fingerprint: "" };
		});
		this.loadedSkills = skills.fingerprint;
		const env: Record<string, string> = { ...bedrockAgentEnv(this.project.id) };
		for (const name of config.agentEnv) {
			const value = process.env[name];
			if (value) env[name] = value;
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
		for (const dir of skills.dirs) piArgs.push("--skill", dir);
		this.loadedMode = this.mode;
		if (this.mode !== "auto") piArgs.push("--append-system-prompt", MODE_PROMPTS[this.mode], "--tools", READ_ONLY_TOOLS);
		this.loadedModel = this.model ?? (await resolveModel());
		piArgs.push("--model", this.loadedModel);
		const child = sandboxes.spawn(this.project, piArgs, env);
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onData(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
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
		if (record.type === "message_end") this.chargeUsage(record.message);
		this.emit(record);
		if (record.type === "agent_settled") {
			this.running = false;
			void this.commit();
		}
	}

	private chargeUsage(message: unknown): void {
		const msg = message as { role?: string } | undefined;
		if (msg?.role !== "assistant" || !this.promptedBy) return;
		recordUsage(this.promptedBy, this.project.id, msg).catch((error) =>
			console.error(`[agent ${this.project.slug}] could not record usage: ${error instanceof Error ? error.message : error}`),
		);
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
			child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	async prompt(
		message: string,
		userId: string,
		images: ImageContent[] = [],
		options: { mode?: ChatMode; model?: string } = {},
	): Promise<unknown> {
		this.promptedBy = userId;
		// pi reads skills, tools and the system prompt when it starts, so an idle pi restarts (keeping
		// its session) when the member prompting it has different skills or picked another mode. The
		// model switches without a restart. A follow-up while it works keeps the running settings.
		if (!this.running) {
			this.skillsOf = userId;
			this.mode = options.mode ?? "auto";
			this.model = await resolveModel(options.model);
			if (this.child && (this.mode !== this.loadedMode || (await skillsFingerprint(userId)) !== this.loadedSkills)) await this.restart();
			if (this.child && this.model !== this.loadedModel) await this.setModel(this.model);
		}
		return this.request({
			type: "prompt",
			message,
			...(images.length ? { images } : {}),
			...(this.running ? { streamingBehavior: "followUp" } : {}),
		});
	}

	private async setModel(model: string): Promise<void> {
		const split = model.indexOf("/");
		await this.request({ type: "set_model", provider: model.slice(0, split), modelId: model.slice(split + 1) });
		this.loadedModel = model;
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
		const result = await execIn(this.project, script);
		const commit = result.stdout.trim().split("\n").pop() ?? "";
		this.emit({ type: "agency_committed", commit });
		autoPush(this.project.id);
		return commit;
	}

	stop(): void {
		this.child?.stdin?.end();
	}

	/** True while a pi process runs for this app. */
	get alive(): boolean {
		return Boolean(this.child);
	}

	/** Ends an idle pi process; the next request starts it again on the same session. */
	async end(): Promise<void> {
		if (!this.running) await this.restart();
	}

	/** Ends the idle pi process; the next request starts a fresh one on the same session. */
	private async restart(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = undefined;
		this.buffer = "";
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		child.stdin?.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		await closed;
		clearTimeout(timer);
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

export function bridgeIfAny(projectId: string): AgentBridge | undefined {
	return bridges.get(projectId);
}

export function allBridges(): Iterable<AgentBridge> {
	return bridges.values();
}

export function dropBridge(projectId: string): void {
	bridges.get(projectId)?.stop();
	bridges.delete(projectId);
}
