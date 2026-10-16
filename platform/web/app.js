import htm from "htm";
import { h, render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

const html = htm.bind(h);

// ---------------------------------------------------------------------------
// API helpers

async function api(path, options = {}) {
	const response = await fetch(`/api${path}`, {
		method: options.method ?? "GET",
		headers: options.body ? { "Content-Type": "application/json" } : {},
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	const type = response.headers.get("Content-Type") ?? "";
	const data = type.includes("json") ? await response.json() : await response.text();
	if (!response.ok) throw Object.assign(new Error(data?.error ?? `Request failed (${response.status})`), { status: response.status });
	return data;
}

/** Reads a server-sent event stream from a POST request. */
async function postStream(path, onEvent) {
	const response = await fetch(`/api${path}`, { method: "POST" });
	if (!response.ok || !response.body) throw new Error(`Request failed (${response.status})`);
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += value;
		let split = buffer.indexOf("\n\n");
		while (split !== -1) {
			const chunk = buffer.slice(0, split);
			buffer = buffer.slice(split + 2);
			const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? "message";
			const data = chunk
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.map((line) => line.slice(6))
				.join("\n");
			if (data) onEvent(event, JSON.parse(data));
			split = buffer.indexOf("\n\n");
		}
	}
}

function useRoute() {
	const [hash, setHash] = useState(location.hash || "#/");
	useEffect(() => {
		const onChange = () => setHash(location.hash || "#/");
		addEventListener("hashchange", onChange);
		return () => removeEventListener("hashchange", onChange);
	}, []);
	return hash.slice(1);
}

// ---------------------------------------------------------------------------
// Chat transcript: pi messages and streaming events reduced to display items

function textOf(content) {
	if (typeof content === "string") return content;
	return (content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function toolLabel(name, args = {}) {
	const path = args.path ?? args.file_path;
	if (name === "write") return `Wrote ${path}`;
	if (name === "edit") return `Edited ${path}`;
	if (name === "read") return `Read ${path}`;
	if (name === "bash") return `Ran ${String(args.command ?? "").split("\n")[0].slice(0, 80)}`;
	if (name === "ls" || name === "find" || name === "grep") return `Searched ${path ?? args.pattern ?? ""}`;
	if (name.startsWith("mcp__agency__")) {
		const tool = name.slice("mcp__agency__".length).replace(/_/g, " ");
		return `Data: ${tool}${args.connection ? ` (${args.connection})` : ""}`;
	}
	return name;
}

function assistantItem(message) {
	const blocks = message.content ?? [];
	return {
		kind: "assistant",
		text: blocks
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join(""),
		thinking: blocks.some((b) => b.type === "thinking"),
		tools: blocks.filter((b) => b.type === "toolCall").map((b) => ({ id: b.id, label: toolLabel(b.name, b.arguments), status: "done" })),
		error: message.stopReason === "error" ? message.errorMessage || "The model returned an error" : null,
	};
}

function itemsFromMessages(messages) {
	const items = [];
	const toolStatus = new Map();
	for (const message of messages) {
		if (message.role === "toolResult" && message.isError) toolStatus.set(message.toolCallId, "failed");
	}
	for (const message of messages) {
		if (message.role === "user") items.push({ kind: "user", text: textOf(message.content) });
		if (message.role === "assistant") {
			const item = assistantItem(message);
			item.tools = item.tools.map((t) => ({ ...t, status: toolStatus.get(t.id) ?? "done" }));
			items.push(item);
		}
	}
	return items;
}

function applyEvent(items, event) {
	const next = items.slice();
	const last = next[next.length - 1];
	switch (event.type) {
		case "message_start":
			if (event.message.role === "user") next.push({ kind: "user", text: textOf(event.message.content) });
			if (event.message.role === "assistant") next.push({ kind: "assistant", text: "", tools: [], thinking: false, error: null, live: true });
			return next;
		case "message_update": {
			if (last?.kind !== "assistant") return items;
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta") next[next.length - 1] = { ...last, text: last.text + update.delta };
			else if (update.type === "thinking_start") next[next.length - 1] = { ...last, thinking: true };
			else if (update.type === "toolcall_start") {
				next[next.length - 1] = { ...last, tools: [...last.tools, { id: update.id, label: update.toolName, status: "running" }] };
			} else if (update.type === "toolcall_end") {
				const tools = last.tools.map((t) =>
					t.id === update.toolCall.id ? { ...t, label: toolLabel(update.toolCall.name, update.toolCall.arguments) } : t,
				);
				next[next.length - 1] = { ...last, tools };
			} else return items;
			return next;
		}
		case "message_end":
			if (event.message.role === "assistant" && last?.kind === "assistant") {
				const final = assistantItem(event.message);
				const status = new Map(last.tools.map((t) => [t.id, t.status]));
				final.tools = final.tools.map((t) => ({ ...t, status: status.get(t.id) ?? "running" }));
				next[next.length - 1] = final;
				return next;
			}
			return items;
		case "tool_execution_end":
			return next.map((item) =>
				item.kind === "assistant" && item.tools.some((t) => t.id === event.toolCallId)
					? { ...item, tools: item.tools.map((t) => (t.id === event.toolCallId ? { ...t, status: event.isError ? "failed" : "done" } : t)) }
					: item,
			);
		default:
			return items;
	}
}

// ---------------------------------------------------------------------------
// Views

// Icons: a small inline set in the style of Lucide, drawn with currentColor.
const ICONS = {
	apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
	database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
	users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
	logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
	arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
	arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
	refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
	external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
	history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
	terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
	globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
	stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
	file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
	folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
	chevron: '<path d="m9 18 6-6-6-6"/>',
	monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
	phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
	code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
	eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
	check: '<path d="M20 6 9 17l-5-5"/>',
	x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
	sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
	lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
	pencil: '<path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
	search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
	alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
	plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
};

function icon(name, className = "") {
	return html`<svg class=${`icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICONS[name] }}></svg>`;
}

function timeAgo(value) {
	const seconds = (new Date(value).getTime() - Date.now()) / 1000;
	const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	const steps = [
		[60, "second"],
		[60, "minute"],
		[24, "hour"],
		[7, "day"],
		[4.35, "week"],
		[12, "month"],
		[Infinity, "year"],
	];
	let amount = seconds;
	for (const [size, unit] of steps) {
		if (Math.abs(amount) < size) return format.format(Math.round(amount), unit);
		amount /= size;
	}
	return "";
}

function hueOf(text) {
	let hash = 0;
	for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 360;
	return hash;
}

// ---------------------------------------------------------------------------
// Toasts: call toast() from anywhere; <Toaster /> renders them.

const toastStore = { items: [], listeners: new Set() };
let toastSeq = 0;

function setToasts(items) {
	toastStore.items = items;
	for (const listener of toastStore.listeners) listener(items);
}

function dismissToast(id) {
	setToasts(toastStore.items.map((t) => (t.id === id ? { ...t, state: "closed" } : t)));
	setTimeout(() => setToasts(toastStore.items.filter((t) => t.id !== id)), 200);
}

function toast(message, type = "success") {
	const id = ++toastSeq;
	setToasts([...toastStore.items, { id, message, type, state: "open" }].slice(-4));
	// The timer waits while the tab is hidden, so a toast is never missed.
	const schedule = (ms) => setTimeout(() => (document.hidden ? schedule(1000) : dismissToast(id)), ms);
	schedule(type === "error" ? 6000 : 3500);
}

function Toaster() {
	const [items, setItems] = useState(toastStore.items);
	useEffect(() => {
		toastStore.listeners.add(setItems);
		return () => toastStore.listeners.delete(setItems);
	}, []);
	return html`<ol class="toaster" aria-live="polite">
		${items.map(
			(t) => html`<li key=${t.id} class=${`toast ${t.type}`} data-state=${t.state} onClick=${() => dismissToast(t.id)}>
				${icon(t.type === "error" ? "alert" : "check")}<span>${t.message}</span>
			</li>`,
		)}
	</ol>`;
}

// ---------------------------------------------------------------------------
// Sheet: a panel that slides over the right side of the builder stage.

function Sheet({ open, title, onClose, children }) {
	const [mounted, setMounted] = useState(open);
	useEffect(() => {
		if (open) setMounted(true);
	}, [open]);
	useEffect(() => {
		if (!open) return;
		const onKey = (e) => e.key === "Escape" && onClose();
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [open]);
	if (!mounted) return null;
	return html`<aside
		class="sheet"
		data-state=${open ? "open" : "closed"}
		aria-hidden=${!open}
		onTransitionEnd=${(e) => !open && e.target === e.currentTarget && setMounted(false)}
	>
		<div class="sheet-head">
			<h3>${title}</h3>
			<button class="icon-btn" title="Close" onClick=${onClose}>${icon("x")}</button>
		</div>
		${children}
	</aside>`;
}

// ---------------------------------------------------------------------------

function Login({ onLogin }) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const submit = async (e) => {
		e.preventDefault();
		setError("");
		setBusy(true);
		try {
			const next = new URLSearchParams(location.search).get("next") ?? undefined;
			const result = await api("/login", { method: "POST", body: { email, password, next } });
			if (result.next && result.next !== "/") location.href = result.next;
			else onLogin(result.user);
		} catch (err) {
			setError(err.message);
			setBusy(false);
		}
	};
	return html`<div class="login">
		<form class="card stack" onSubmit=${submit}>
			<div>
				<div class="brand"><img src="/static/logo.png" alt="" /> <b>Agency</b></div>
				<h1>Welcome back</h1>
				<p class="lead">Sign in to build with your team's data.</p>
			</div>
			<label class="field">
				<span>Email</span>
				<input class="input" type="email" value=${email} onInput=${(e) => setEmail(e.target.value)} autocomplete="username" required autofocus />
			</label>
			<label class="field">
				<span>Password</span>
				<input
					class="input"
					type="password"
					value=${password}
					onInput=${(e) => setPassword(e.target.value)}
					autocomplete="current-password"
					required
				/>
			</label>
			${error && html`<div class="error">${error}</div>`}
			<button class="btn primary block" disabled=${busy}>${busy ? html`<span class="spinner"></span>` : "Sign in"}</button>
		</form>
	</div>`;
}

const IDEAS = [
	"A dashboard of open deals from our CRM, grouped by stage with totals",
	"An internal tool to search customers and see their latest orders",
	"A form where the team logs expenses, with a monthly summary chart",
];

function Home() {
	const [projects, setProjects] = useState(null);
	const [prompt, setPrompt] = useState("");
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const field = useRef(null);
	useEffect(() => {
		api("/projects").then(setProjects, (err) => setError(err.message));
	}, []);
	const create = async () => {
		if (!prompt.trim() || busy) return;
		setBusy(true);
		setError("");
		try {
			const appName = name.trim() || prompt.trim().split(/\s+/).slice(0, 4).join(" ");
			const project = await api("/projects", { method: "POST", body: { name: appName, prompt } });
			location.hash = `#/p/${project.id}`;
		} catch (err) {
			setError(err.message);
			setBusy(false);
		}
	};
	return html`<div class="page">
		<section class="hero">
			<h1>What should we build?</h1>
			<p>Describe an app in plain words. Agency builds it on your organization's data and runs it live.</p>
			<div class="composer">
				<textarea
					ref=${field}
					placeholder="A dashboard of open deals from our CRM..."
					value=${prompt}
					onInput=${(e) => setPrompt(e.target.value)}
					onKeyDown=${(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && create()}
					autofocus
				></textarea>
				<div class="bar">
					<input class="name" placeholder="App name (optional)" value=${name} onInput=${(e) => setName(e.target.value)} />
					<span class="grow"></span>
					<span class="kbd hide-sm">⌘ ↵</span>
					<button class="btn primary" disabled=${busy || !prompt.trim()} onClick=${create}>
						${busy ? html`<span class="spinner"></span> Creating` : html`Build it ${icon("arrowUp")}`}
					</button>
				</div>
			</div>
			<div class="chips">
				${IDEAS.map(
					(idea) => html`<button
						class="chip"
						onClick=${() => {
							setPrompt(idea);
							field.current?.focus();
						}}
					>
						${icon("sparkles")} ${idea}
					</button>`,
				)}
			</div>
			${error && html`<p class="error">${error}</p>`}
		</section>
		<h2 class="section-title">Apps ${projects?.length ? html`<span class="faint">${projects.length}</span>` : null}</h2>
		${projects === null
			? html`<div class="empty"><span class="spinner"></span></div>`
			: projects.length === 0
				? html`<div class="card empty">${icon("apps")} No apps yet. Describe one above to get started.</div>`
				: html`<div class="grid">
						${projects.map(
							(p, i) => html`<a class="project-card" href=${`#/p/${p.id}`} style=${`--i:${i};--hue:${hueOf(p.name)}`}>
								<div class="thumb">
									<span class="initial">${p.name.trim().slice(0, 1).toUpperCase()}</span>
									${p.agentRunning
										? html`<span class="badge accent"><span class="dot pulse"></span>Building</span>`
										: p.published
											? html`<span class="badge live"><span class="dot"></span>Live v${p.published}</span>`
											: html`<span class="badge">Draft</span>`}
								</div>
								<div class="meta">
									<strong>${p.name}</strong>
									<div class="host">${p.slug}.${location.hostname}</div>
								</div>
							</a>`,
						)}
					</div>`}
	</div>`;
}

const TOOL_ICONS = { write: "pencil", edit: "pencil", read: "file", bash: "terminal", ls: "search", find: "search", grep: "search" };

function toolIcon(label) {
	if (label.startsWith("Data:")) return "database";
	const verb = label.split(" ")[0];
	return { Wrote: "pencil", Edited: "pencil", Read: "file", Ran: "terminal", Searched: "search" }[verb] ?? TOOL_ICONS[label] ?? "sparkles";
}

function ChatItem({ item }) {
	if (item.kind === "user") return html`<div class="msg msg-user">${item.text}</div>`;
	return html`<div class="msg">
		${item.thinking && !item.text && item.tools.length === 0 && html`<div class="thinking"><span class="spinner"></span> Thinking</div>`}
		${item.text && html`<div class="msg-assistant">${item.text}</div>`}
		${item.tools.length > 0 &&
		html`<div class="tools">
			${item.tools.map(
				(t) => html`<div class=${`tool ${t.status}`} title=${t.label}>
					${t.status === "running" ? html`<span class="spinner"></span>` : icon(t.status === "failed" ? "alert" : toolIcon(t.label))}
					<span>${t.label}</span>
				</div>`,
			)}
		</div>`}
		${item.error && html`<div class="msg-error">${item.error}</div>`}
	</div>`;
}

function Builder({ id }) {
	const [project, setProject] = useState(null);
	const [items, setItems] = useState([]);
	const [running, setRunning] = useState(false);
	const [input, setInput] = useState("");
	const [error, setError] = useState("");
	const [panel, setPanel] = useState(null);
	const [tab, setTab] = useState("preview");
	const [device, setDevice] = useState("desktop");
	const [previewKey, setPreviewKey] = useState(0);
	const [restored, setRestored] = useState(0);
	const scroller = useRef(null);

	const loadProject = () => api(`/projects/${id}`).then(setProject, (err) => setError(err.message));
	const togglePanel = (name) => setPanel((current) => (current === name ? null : name));

	useEffect(() => {
		loadProject();
		let source;
		let closed = false;
		const connect = () => {
			source = new EventSource(`/api/projects/${id}/events`);
			source.onmessage = (message) => {
				const event = JSON.parse(message.data);
				if (event.type === "agent_start") setRunning(true);
				if (event.type === "agent_settled") {
					setRunning(false);
					setPreviewKey((k) => k + 1);
				}
				if (event.type === "agency_agent_exit") setRunning(false);
				setItems((current) => applyEvent(current, event));
			};
			source.addEventListener("hello", (message) => setRunning(JSON.parse(message.data).running));
			source.onerror = () => {
				source.close();
				if (!closed) setTimeout(connect, 3000);
			};
		};
		// Load history first, then stream new events.
		api(`/projects/${id}/messages`).then(
			(data) => {
				setItems(itemsFromMessages(data.messages));
				setRunning(data.running);
				connect();
			},
			(err) => {
				setError(err.message);
				connect();
			},
		);
		return () => {
			closed = true;
			source?.close();
		};
	}, [id]);

	useEffect(() => {
		scroller.current?.scrollTo(0, scroller.current.scrollHeight);
	}, [items]);

	const send = async () => {
		const message = input.trim();
		if (!message) return;
		setInput("");
		setError("");
		try {
			await api(`/projects/${id}/prompt`, { method: "POST", body: { message } });
		} catch (err) {
			setError(err.message);
			setInput(message);
		}
	};

	if (!project) {
		return html`<div class="page">${error ? html`<p class="error">${error}</p>` : html`<div class="empty"><span class="spinner"></span></div>`}</div>`;
	}

	const host = project.previewUrl.replace(/^https?:\/\//, "");
	return html`<div class="builder">
		<header class="topbar">
			<div class="left">
				<a class="icon-btn" href="#/" title="All apps">${icon("arrowLeft")}</a>
				<h2>${project.name}</h2>
				${running
					? html`<span class="status"><span class="dot pulse"></span>Working</span>`
					: project.published
						? html`<span class="badge live hide-sm"><span class="dot"></span>Live v${project.published}</span>`
						: null}
			</div>
			<div class="center">
				<div class="seg" role="tablist" style=${`--index:${tab === "code" ? 1 : 0};--count:2`}>
					<button role="tab" aria-selected=${tab === "preview"} onClick=${() => setTab("preview")}>${icon("eye")} Preview</button>
					<button role="tab" aria-selected=${tab === "code"} onClick=${() => setTab("code")}>${icon("code")} Code</button>
				</div>
			</div>
			<div class="right">
				<button class="icon-btn" title="Versions" aria-pressed=${panel === "versions"} onClick=${() => togglePanel("versions")}>
					${icon("history")}
				</button>
				<button class="icon-btn" title="Dev server log" aria-pressed=${panel === "logs"} onClick=${() => togglePanel("logs")}>
					${icon("terminal")}
				</button>
				<span class="sep"></span>
				<button class="btn primary sm" onClick=${() => togglePanel("publish")}>${icon("globe")} Publish</button>
			</div>
		</header>
		<div class="workbench">
			<section class="chat">
				<div class="messages" ref=${scroller}>
					${items.length === 0 &&
					html`<div class="chat-empty">
						${icon("sparkles")}
						<div>Describe what to build or change.<br />The agent edits the code and the preview updates.</div>
					</div>`}
					${items.map((item) => html`<${ChatItem} item=${item} />`)}
				</div>
				<div class="chat-input">
					${error && html`<div class="error">${error}</div>`}
					<div class="chat-box">
						<textarea
							placeholder=${running ? "Add an instruction for after this step..." : "Ask for a change..."}
							value=${input}
							onInput=${(e) => setInput(e.target.value)}
							onKeyDown=${(e) => {
								if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
									e.preventDefault();
									send();
								}
							}}
						></textarea>
						<div class="bar">
							<span class="faint grow" style="font-size:11.5px">Shift + Enter for a new line</span>
							${running &&
							html`<button class="btn sm" onClick=${() => api(`/projects/${id}/abort`, { method: "POST" })}>${icon("stop")} Stop</button>`}
							<button class="btn primary send" title="Send" disabled=${!input.trim()} onClick=${send}>${icon("arrowUp")}</button>
						</div>
					</div>
				</div>
			</section>
			<section class="stage">
				<div class="preview" hidden=${tab !== "preview"}>
					<div class="chrome">
						<button class="icon-btn" title="Reload preview" onClick=${() => setPreviewKey((k) => k + 1)}>${icon("refresh")}</button>
						<div class="url">${project.previewUrl.startsWith("https") && icon("lock")}<span>${host}</span></div>
						<button class="icon-btn" title="Desktop width" aria-pressed=${device === "desktop"} onClick=${() => setDevice("desktop")}>
							${icon("monitor")}
						</button>
						<button class="icon-btn" title="Phone width" aria-pressed=${device === "mobile"} onClick=${() => setDevice("mobile")}>
							${icon("phone")}
						</button>
						<a class="icon-btn" href=${project.previewUrl} target="_blank" rel="noopener" title="Open in a new tab">${icon("external")}</a>
					</div>
					<div class=${`viewport ${device}`}>
						<iframe key=${previewKey} src=${project.previewUrl} title="App preview"></iframe>
					</div>
				</div>
				<${CodeView}
					id=${id}
					running=${running}
					active=${tab === "code"}
					restored=${restored}
					onSaved=${() => setPreviewKey((k) => k + 1)}
				/>
				<${Sheet} open=${panel === "versions"} title="Versions" onClose=${() => setPanel(null)}>
					<${VersionsPanel}
						id=${id}
						running=${running}
						onRestored=${() => {
							setPreviewKey((k) => k + 1);
							setRestored((n) => n + 1);
						}}
					/>
				<//>
				<${Sheet} open=${panel === "logs"} title="Dev server log" onClose=${() => setPanel(null)}>
					<${LogsPanel} id=${id} />
				<//>
				<${Sheet} open=${panel === "publish"} title="Publish" onClose=${() => setPanel(null)}>
					<${PublishPanel} project=${project} running=${running} onChange=${loadProject} />
				<//>
			</section>
		</div>
	</div>`;
}

// ---------------------------------------------------------------------------
// Code view: the app's files in its sandbox, with an editor. Saving commits the file
// as a new version and the preview reloads.

function buildTree(paths) {
	const root = { dirs: new Map(), files: [] };
	for (const path of paths) {
		const parts = path.split("/");
		let node = root;
		for (let i = 0; i < parts.length - 1; i++) {
			if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] });
			node = node.dirs.get(parts[i]);
		}
		node.files.push({ name: parts[parts.length - 1], path });
	}
	return root;
}

function TreeNode({ node, depth, expanded, onToggle, selected, onSelect }) {
	const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
	const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
	return html`${dirs.map(
		(dir) => html`<button class="tree-row" style=${`--depth:${depth}`} aria-expanded=${expanded.has(dir.path)} onClick=${() => onToggle(dir.path)}>
				${icon("chevron", "chev")} ${icon("folder")}<span>${dir.name}</span>
			</button>
			${expanded.has(dir.path) &&
			html`<${TreeNode}
				node=${dir}
				depth=${depth + 1}
				expanded=${expanded}
				onToggle=${onToggle}
				selected=${selected}
				onSelect=${onSelect}
			/>`}`,
	)}
	${files.map(
		(file) => html`<button
			class="tree-row"
			style=${`--depth:${depth}`}
			aria-selected=${selected === file.path}
			title=${file.path}
			onClick=${() => onSelect(file.path)}
		>
			<span class="chev"></span>${icon("file")}<span>${file.name}</span>
		</button>`,
	)}`;
}

const DEFAULT_FILES = ["app/page.tsx", "app/page.jsx", "app/page.js", "README.md", "package.json"];

function CodeView({ id, running, active, restored, onSaved }) {
	const [files, setFiles] = useState(null);
	const [listError, setListError] = useState("");
	const [filter, setFilter] = useState("");
	const [expanded, setExpanded] = useState(() => new Set(["app"]));
	const [doc, setDoc] = useState(null);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const host = useRef(null);
	const editor = useRef(null);
	const text = useRef("");
	const saved = useRef("");
	const loadSeq = useRef(0);
	const started = useRef(false);
	const wasRunning = useRef(running);
	// Latest values for callbacks the editor holds on to.
	const live = useRef({});
	live.current = { doc, dirty, running, saving };

	const loadFiles = () =>
		api(`/projects/${id}/files`).then(
			(data) => {
				setFiles(data.files);
				setListError("");
				return data.files;
			},
			(err) => {
				setListError(err.message);
				return [];
			},
		);

	const open = async (path, { force = false } = {}) => {
		const current = live.current;
		if (!force && current.doc?.path === path) return;
		if (!force && current.dirty && !confirm(`Discard unsaved changes to ${current.doc.path}?`)) return;
		const seq = ++loadSeq.current;
		setDoc({ path, status: "loading" });
		setExpanded((set) => {
			const next = new Set(set);
			const parts = path.split("/");
			for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
			return next;
		});
		try {
			const data = await api(`/projects/${id}/file?path=${encodeURIComponent(path)}`);
			if (seq !== loadSeq.current) return;
			if (data.binary || data.tooLarge) {
				setDoc({ path, status: data.binary ? "binary" : "tooLarge" });
				setDirty(false);
				return;
			}
			if (!editor.current) {
				const { createEditor } = await import("./editor.js");
				if (seq !== loadSeq.current) return;
				editor.current = createEditor(host.current, {
					onChange: (value) => {
						text.current = value;
						setDirty(value !== saved.current);
					},
					onSave: () => save(),
				});
			}
			editor.current.setReadOnly(live.current.running);
			text.current = saved.current = data.content;
			editor.current.open(path, data.content);
			setDirty(false);
			setDoc({ path, status: "ready" });
		} catch (err) {
			if (seq === loadSeq.current) setDoc({ path, status: "error", error: err.message });
		}
	};

	async function save() {
		const { doc: current, dirty: changed, running: busy, saving: inFlight } = live.current;
		if (!current || current.status !== "ready" || !changed || inFlight) return;
		if (busy) {
			toast("The agent is working. Save again when it finishes.", "error");
			return;
		}
		const content = text.current;
		setSaving(true);
		try {
			await api(`/projects/${id}/file`, { method: "PUT", body: { path: current.path, content } });
			saved.current = content;
			setDirty(text.current !== content);
			toast(`Saved ${current.path}`);
			onSaved();
		} catch (err) {
			toast(err.message, "error");
		}
		setSaving(false);
	}

	// Load lazily the first time the Code tab opens.
	useEffect(() => {
		if (!active || started.current) return;
		started.current = true;
		loadFiles().then((list) => {
			const first = DEFAULT_FILES.find((path) => list.includes(path)) ?? list[0];
			if (first) open(first);
		});
	}, [active]);

	// Picks up changes made outside the editor (an agent run, a restored version) unless there are unsaved edits.
	const refresh = () => {
		if (!started.current) return;
		loadFiles();
		const current = live.current.doc;
		if (current && !live.current.dirty) open(current.path, { force: true });
	};

	// The editor is read-only while the agent works; when it finishes, pick up its changes.
	useEffect(() => {
		editor.current?.setReadOnly(running);
		if (wasRunning.current && !running) refresh();
		wasRunning.current = running;
	}, [running]);

	useEffect(() => {
		if (restored) refresh();
	}, [restored]);

	useEffect(() => {
		const warn = (e) => {
			if (live.current.dirty) e.preventDefault();
		};
		addEventListener("beforeunload", warn);
		return () => {
			removeEventListener("beforeunload", warn);
			editor.current?.destroy();
		};
	}, []);

	const toggle = (path) =>
		setExpanded((set) => {
			const next = new Set(set);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});

	const tree = useMemo(() => buildTree(files ?? []), [files]);
	const query = filter.trim().toLowerCase();
	const matches = query ? (files ?? []).filter((path) => path.toLowerCase().includes(query)) : null;
	const crumbs = doc?.path.split("/") ?? [];

	return html`<div class="code" hidden=${!active}>
		<aside class="tree">
			<div class="tree-head">
				<span>Files</span>
				<button class="icon-btn" title="Refresh files" onClick=${loadFiles}>${icon("refresh")}</button>
			</div>
			<div class="tree-filter">
				<input class="input" placeholder="Find a file" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
			</div>
			<div class="tree-list">
				${listError && html`<div class="error" style="padding:8px">${listError}</div>`}
				${files === null && !listError && html`<div class="empty"><span class="spinner"></span></div>`}
				${matches
					? matches.map(
							(path) => html`<button class="tree-row" aria-selected=${doc?.path === path} title=${path} onClick=${() => open(path)}>
								${icon("file")}<span>${path}</span>
							</button>`,
						)
					: files && html`<${TreeNode} node=${tree} depth=${0} expanded=${expanded} onToggle=${toggle} selected=${doc?.path} onSelect=${open} />`}
			</div>
		</aside>
		<section class="editor-pane">
			<div class="editor-bar">
				<div class="crumbs">
					${crumbs.map((part, i) =>
						i === crumbs.length - 1 ? html`<b>${part}</b>` : html`<span>${part}</span>${icon("chevron")}`,
					)}
				</div>
				${doc?.status === "ready" &&
				html`<span class=${`save-state ${dirty ? "dirty" : ""}`}>
					${saving ? html`<span class="spinner"></span> Saving` : dirty ? html`<span class="dot"></span> Unsaved` : html`${icon("check")} Saved`}
				</span>`}
				<button class="btn sm primary" disabled=${!dirty || saving || running || doc?.status !== "ready"} onClick=${save} title="Save (⌘S)">
					Save
				</button>
			</div>
			${running && html`<div class="banner"><span class="spinner"></span> The agent is working, so editing is paused until it finishes.</div>`}
			<div class="editor-host" ref=${host}>
				${!doc && files?.length === 0 && html`<div class="empty">${icon("file")} No files yet.</div>`}
				${doc?.status === "loading" && html`<div class="empty"><span class="spinner"></span></div>`}
				${doc?.status === "binary" && html`<div class="empty">${icon("file")} This is a binary file, so it can't be edited here.</div>`}
				${doc?.status === "tooLarge" && html`<div class="empty">${icon("file")} This file is larger than 1 MB, so it can't be edited here.</div>`}
				${doc?.status === "error" && html`<div class="empty error">${icon("alert")} ${doc.error}</div>`}
			</div>
		</section>
	</div>`;
}

function VersionsPanel({ id, running, onRestored }) {
	const [versions, setVersions] = useState(null);
	const [error, setError] = useState("");
	const load = () => api(`/projects/${id}/versions`).then(setVersions, (err) => setError(err.message));
	useEffect(() => {
		load();
	}, [id, running]);
	const restore = async (commit) => {
		try {
			await api(`/projects/${id}/restore`, { method: "POST", body: { commit } });
			toast(`Restored ${commit}`);
			load();
			onRestored();
		} catch (err) {
			setError(err.message);
		}
	};
	return html`<div class="sheet-body flush">
		${error && html`<p class="error" style="padding:0 18px">${error}</p>`}
		${versions === null && html`<div class="empty"><span class="spinner"></span></div>`}
		${(versions ?? []).map(
			(v, i) => html`<div class="list-row">
				<div class="grow">
					<div class="title">${v.subject} ${i === 0 && html`<span class="badge accent">Current</span>`}</div>
					<div class="sub"><span class="mono">${v.commit}</span> · ${timeAgo(v.date)}</div>
				</div>
				${i > 0 && html`<button class="btn sm" disabled=${running} onClick=${() => restore(v.commit)}>Restore</button>`}
			</div>`,
		)}
	</div>`;
}

function LogsPanel({ id }) {
	const [logs, setLogs] = useState("");
	const box = useRef(null);
	useEffect(() => {
		const load = () => api(`/projects/${id}/logs`).then(setLogs, (err) => setLogs(err.message));
		load();
		const timer = setInterval(load, 4000);
		return () => clearInterval(timer);
	}, [id]);
	useEffect(() => {
		box.current?.scrollTo(0, box.current.scrollHeight);
	}, [logs]);
	return html`<div class="sheet-body flush" ref=${box}><pre class="log">${logs || "Loading..."}</pre></div>`;
}

function PublishPanel({ project, running, onChange }) {
	const [deployments, setDeployments] = useState([]);
	const [log, setLog] = useState([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const load = () => api(`/projects/${project.id}/deployments`).then(setDeployments);
	useEffect(() => {
		load();
	}, [project.id]);
	const run = async () => {
		setBusy(true);
		setError("");
		setLog([]);
		try {
			await postStream(`/projects/${project.id}/publish`, (event, data) => {
				if (event === "log") setLog((lines) => [...lines, data]);
				if (event === "done") {
					setLog((lines) => [...lines, `Published v${data.version}`]);
					toast(`Published v${data.version}`);
				}
				if (event === "failed") setError(data);
			});
		} catch (err) {
			setError(err.message);
		}
		setBusy(false);
		load();
		onChange();
	};
	const act = async (path, body) => {
		try {
			await api(`/projects/${project.id}/${path}`, { method: "POST", body });
		} catch (err) {
			setError(err.message);
		}
		load();
		onChange();
	};
	return html`<div class="sheet-body">
		<div class="callout">
			Publishes to <a href=${project.appUrl} target="_blank" rel="noopener">${project.appUrl}</a>. Only signed-in team members can open it.
		</div>
		<div class="row">
			<button class="btn primary grow" disabled=${busy || running} onClick=${run}>
				${busy ? html`<span class="spinner"></span> Publishing` : html`${icon("globe")} Publish current version`}
			</button>
			${project.published && html`<button class="btn danger" onClick=${() => act("unpublish")}>Unpublish</button>`}
		</div>
		${running && html`<p class="faint" style="font-size:12.5px">Publishing is available when the agent finishes.</p>`}
		${log.length > 0 && html`<pre class="log boxed">${log.join("\n")}</pre>`}
		${error && html`<pre class="log boxed error">${error}</pre>`}
		${deployments.length > 0 &&
		html`<h4 class="section-title" style="margin:24px 0 4px">History</h4>
			<div>
				${deployments.map(
					(d) => html`<div class="list-row" style="padding:10px 0">
						<div class="grow">
							<div class="title">v${d.version} ${d.active && html`<span class="badge live"><span class="dot"></span>Live</span>`}</div>
							<div class="sub"><span class="mono">${d.git_commit}</span> · ${timeAgo(d.created_at)}</div>
						</div>
						${!d.active && html`<button class="btn sm" onClick=${() => act("rollback", { version: d.version })}>Roll back</button>`}
					</div>`,
				)}
			</div>`}
	</div>`;
}

const CONNECTION_TYPES = {
	postgres: { label: "Postgres", kind: "postgres", ssl: "verify", hint: "postgres://user:password@host:5432/database" },
	supabase: {
		label: "Supabase",
		kind: "postgres",
		ssl: "require",
		hint: "Supabase > Project Settings > Database > Connection string (session pooler)",
	},
	rds: { label: "AWS RDS / Aurora Postgres", kind: "postgres", ssl: "require", hint: "postgres://user:password@xxx.rds.amazonaws.com:5432/db" },
	mcp_http: {
		label: "MCP server (URL): Monday, Salesforce, Google Drive, ...",
		kind: "mcp_http",
		hint: "The vendor's streamable HTTP MCP endpoint, usually ending in /mcp",
	},
	mcp_stdio: { label: "MCP server (command)", kind: "mcp_stdio", hint: "npx -y some-mcp-server --flag" },
};

function parseHeaders(text) {
	const headers = {};
	for (const line of text.split("\n")) {
		const index = line.indexOf(":");
		if (index > 0) headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
	}
	return headers;
}

function parseEnv(text) {
	const env = {};
	for (const line of text.split("\n")) {
		const index = line.indexOf("=");
		if (index > 0) env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
	}
	return env;
}

function Connections({ user }) {
	const [connections, setConnections] = useState(null);
	const [type, setType] = useState("postgres");
	const [form, setForm] = useState({ name: "", description: "", target: "", extra: "", allowWrite: false });
	const [error, setError] = useState("");
	const [results, setResults] = useState({});
	const load = () => api("/connections").then(setConnections, (err) => setError(err.message));
	useEffect(() => {
		load();
	}, []);
	const spec = CONNECTION_TYPES[type];
	const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
	const add = async (e) => {
		e.preventDefault();
		setError("");
		let config;
		if (spec.kind === "postgres") config = { connectionString: form.target, ssl: spec.ssl };
		else if (spec.kind === "mcp_http") config = { url: form.target, headers: parseHeaders(form.extra) };
		else {
			const [command, ...args] = form.target.trim().split(/\s+/);
			config = { command, args, env: parseEnv(form.extra) };
		}
		try {
			await api("/connections", {
				method: "POST",
				body: { name: form.name, kind: spec.kind, description: form.description, allowWrite: form.allowWrite, config },
			});
			toast(`Added ${form.name}`);
			setForm({ name: "", description: "", target: "", extra: "", allowWrite: false });
			load();
		} catch (err) {
			setError(err.message);
		}
	};
	const test = async (name) => {
		setResults({ ...results, [name]: { pending: true } });
		const result = await api(`/connections/${name}/test`, { method: "POST" });
		setResults((r) => ({ ...r, [name]: result }));
	};
	const remove = async (id) => {
		if (!confirm("Remove this connection? Apps using it will stop getting data.")) return;
		await api(`/connections/${id}`, { method: "DELETE" });
		load();
	};
	return html`<div class="page">
		<header class="page-head">
			<h1>Connections</h1>
			<p>Organization data the agent can build on. Credentials stay in the platform; apps reach data through the gateway with their own token.</p>
		</header>
		<div class="stack">
			<div class="card">
				${connections === null
					? html`<div class="empty"><span class="spinner"></span></div>`
					: connections.length === 0
						? html`<div class="empty">${icon("database")} No connections yet.</div>`
						: connections.map((c) => {
								const result = results[c.name];
								return html`<div class="list-row">
									<div class="grow">
										<div class="title">
											${c.name} <span class="badge">${c.kind}</span>
											${c.allowWrite ? html`<span class="badge">writes allowed</span>` : html`<span class="badge">read-only</span>`}
										</div>
										${c.description && html`<div class="sub">${c.description}</div>`}
										${result &&
										html`<div class="sub" style=${result.pending ? "" : `color:var(${result.ok ? "--success" : "--danger"})`}>
											${result.pending ? "Testing..." : result.message}
										</div>`}
									</div>
									<button class="btn sm" onClick=${() => test(c.name)}>Test</button>
									${user.role === "admin" && html`<button class="btn sm danger" onClick=${() => remove(c.id)}>Remove</button>`}
								</div>`;
							})}
			</div>
			${user.role === "admin" &&
			html`<form class="card" onSubmit=${add}>
				<div class="card-head">
					<h2>Add a connection</h2>
					<p>${spec.hint}</p>
				</div>
				<div class="card-body form-grid">
					<label class="field">
						<span>Type</span>
						<select class="select" value=${type} onChange=${(e) => setType(e.target.value)}>
							${Object.entries(CONNECTION_TYPES).map(([key, value]) => html`<option value=${key}>${value.label}</option>`)}
						</select>
					</label>
					<label class="field">
						<span>Name <span class="hint">used in code</span></span>
						<input class="input" placeholder="crm" value=${form.name} onInput=${set("name")} required pattern="[a-z][a-z0-9_-]*" />
					</label>
					<label class="field wide">
						<span>Description</span>
						<input class="input" placeholder="Sales CRM: deals, accounts, contacts" value=${form.description} onInput=${set("description")} />
					</label>
					<label class="field wide">
						<span>${spec.kind === "postgres" ? "Connection string" : spec.kind === "mcp_http" ? "MCP URL" : "Command"}</span>
						<input class="input mono" placeholder=${spec.hint} value=${form.target} onInput=${set("target")} required />
					</label>
					${spec.kind === "mcp_http" &&
					html`<label class="field wide">
						<span>Headers <span class="hint">one per line</span></span>
						<textarea class="textarea mono" rows="2" placeholder="Authorization: Bearer ..." value=${form.extra} onInput=${set("extra")}></textarea>
					</label>`}
					${spec.kind === "mcp_stdio" &&
					html`<label class="field wide">
						<span>Environment <span class="hint">KEY=value per line</span></span>
						<textarea class="textarea mono" rows="2" placeholder="API_TOKEN=..." value=${form.extra} onInput=${set("extra")}></textarea>
					</label>`}
					<label class="check wide"><input type="checkbox" checked=${form.allowWrite} onChange=${set("allowWrite")} /> Allow apps to write</label>
					${error && html`<div class="error wide">${error}</div>`}
				</div>
				<div class="card-foot"><button class="btn primary">${icon("plus")} Add connection</button></div>
			</form>`}
		</div>
	</div>`;
}

function Team({ user }) {
	const [users, setUsers] = useState([]);
	const [form, setForm] = useState({ email: "", name: "", password: "", role: "member" });
	const [error, setError] = useState("");
	const load = () => api("/users").then(setUsers, (err) => setError(err.message));
	useEffect(() => {
		load();
	}, []);
	const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
	const add = async (e) => {
		e.preventDefault();
		setError("");
		try {
			await api("/users", { method: "POST", body: form });
			toast(`Added ${form.email}`);
			setForm({ email: "", name: "", password: "", role: "member" });
			load();
		} catch (err) {
			setError(err.message);
		}
	};
	if (user.role !== "admin") return html`<div class="page"><div class="empty">${icon("lock")} Only admins manage the team.</div></div>`;
	return html`<div class="page">
		<header class="page-head">
			<h1>Team</h1>
			<p>People who can sign in, build apps and open published apps.</p>
		</header>
		<div class="stack">
			<div class="card">
				${users.map(
					(u) => html`<div class="list-row">
						<span class="avatar">${(u.name || u.email).slice(0, 1)}</span>
						<div class="grow">
							<div class="title">${u.name || u.email}</div>
							${u.name && html`<div class="sub">${u.email}</div>`}
						</div>
						<span class="badge">${u.role}</span>
						${u.id !== user.id &&
						html`<button
							class="btn sm danger"
							onClick=${async () => {
								if (!confirm(`Remove ${u.email}?`)) return;
								await api(`/users/${u.id}`, { method: "DELETE" });
								load();
							}}
						>
							Remove
						</button>`}
					</div>`,
				)}
			</div>
			<form class="card" onSubmit=${add}>
				<div class="card-head"><h2>Add a member</h2></div>
				<div class="card-body form-grid">
					<label class="field"><span>Email</span><input class="input" type="email" value=${form.email} onInput=${set("email")} required /></label>
					<label class="field"><span>Name</span><input class="input" value=${form.name} onInput=${set("name")} /></label>
					<label class="field">
						<span>Temporary password <span class="hint">10+ characters</span></span>
						<input class="input" type="password" minlength="10" value=${form.password} onInput=${set("password")} required />
					</label>
					<label class="field">
						<span>Role</span>
						<select class="select" value=${form.role} onChange=${set("role")}>
							<option value="member">Member</option>
							<option value="admin">Admin</option>
						</select>
					</label>
					${error && html`<div class="error wide">${error}</div>`}
				</div>
				<div class="card-foot"><button class="btn primary">${icon("plus")} Add member</button></div>
			</form>
		</div>
	</div>`;
}

function App() {
	const [user, setUser] = useState(undefined);
	const route = useRoute();
	useEffect(() => {
		api("/me").then(
			(data) => {
				const next = new URLSearchParams(location.search).get("next");
				if (next) location.href = next;
				else setUser(data.user);
			},
			() => setUser(null),
		);
	}, []);
	const view = useMemo(() => {
		if (!user) return null;
		const project = /^\/p\/([0-9a-f-]+)/.exec(route);
		if (project) return html`<${Builder} id=${project[1]} />`;
		if (route.startsWith("/connections")) return html`<${Connections} user=${user} />`;
		if (route.startsWith("/team")) return html`<${Team} user=${user} />`;
		return html`<${Home} />`;
	}, [route, user]);
	if (user === undefined) return null;
	if (user === null) return html`<${Login} onLogin=${setUser} /><${Toaster} />`;
	const link = (href, label, iconName) => {
		const path = href.slice(1);
		const current = path === "/" ? route === "/" : route.startsWith(path);
		return html`<a href=${href} class="nav-link" aria-current=${current ? "page" : undefined}>${icon(iconName)} <span class="label">${label}</span></a>`;
	};
	// The builder gets the whole window; its back arrow returns to the app list.
	if (route.startsWith("/p/")) return html`<main class="main full">${view}</main><${Toaster} />`;
	return html`<div class="app">
			<nav class="nav">
				<a class="brand" href="#/"><img src="/static/logo.png" alt="" /> <b>Agency</b></a>
				${link("#/", "Apps", "apps")} ${link("#/connections", "Connections", "database")}
				${user.role === "admin" && link("#/team", "Team", "users")}
				<span class="spacer"></span>
				<div class="account">
					<span class="avatar">${(user.name || user.email).slice(0, 1)}</span>
					<span class="who" title=${user.email}>${user.email}</span>
					<button
						class="icon-btn"
						title="Sign out"
						onClick=${async () => {
							await api("/logout", { method: "POST" });
							location.reload();
						}}
					>
						${icon("logout")}
					</button>
				</div>
			</nav>
			<main class="main">${view}</main>
		</div>
		<${Toaster} />`;
}

render(html`<${App} />`, document.getElementById("root"));
