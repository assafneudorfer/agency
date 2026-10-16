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
	trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
	table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/>',
	play: '<path d="m6 3 14 9-14 9z"/>',
	gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
	share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4"/><path d="m15.4 6.5-6.8 4"/>',
	link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
	github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
	key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
	settings: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
	infinity: '<path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4z"/>',
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

function money(value) {
	const digits = value > 0 && value < 1 ? 3 : 2;
	return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

function shortDate(value) {
	return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A thin bar of spend against budget. Turns amber past 80% and red when the budget is used up. */
function Meter({ spent, budget, unlimited }) {
	const ratio = unlimited ? 0 : budget > 0 ? Math.min(1, spent / budget) : 1;
	const level = unlimited ? "" : ratio >= 1 ? "over" : ratio >= 0.8 ? "near" : "";
	return html`<div class=${`meter ${level}`} role="meter" aria-valuemin="0" aria-valuemax=${budget} aria-valuenow=${spent}>
		<span style=${`transform:scaleX(${ratio})`}></span>
	</div>`;
}

function spendLabel(usage) {
	return usage.unlimited ? `${money(usage.spentUsd)} · unlimited` : `${money(usage.spentUsd)} of ${money(usage.budgetUsd)}`;
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
	const [error, setError] = useState(() => new URLSearchParams(location.search).get("sso_error") ?? "");
	const [busy, setBusy] = useState(false);
	const [options, setOptions] = useState(null);
	const [showPassword, setShowPassword] = useState(false);
	useEffect(() => {
		api("/sign-in-options").then(setOptions, () => setOptions({ sso: null, password: "all" }));
	}, []);
	const next = new URLSearchParams(location.search).get("next");
	const ssoHref = `/auth/sso/start${next ? `?next=${encodeURIComponent(next)}` : ""}`;
	const passwordOpen = !options?.sso || options.password === "all" || showPassword;
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
			${options?.sso &&
			html`<a class="btn primary block" href=${ssoHref}>${icon("key")} Sign in with ${options.sso.label}</a>`}
			${options?.sso && passwordOpen && html`<div class="divider"><span>or</span></div>`}
			${!passwordOpen &&
			html`${error && html`<div class="error">${error}</div>`}
				<button type="button" class="link-btn center" onClick=${() => setShowPassword(true)}>Admin sign-in with a password</button>`}
			${passwordOpen &&
			html`<label class="field">
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
			<button class=${`btn block ${options?.sso ? "" : "primary"}`} disabled=${busy}>${busy ? html`<span class="spinner"></span>` : "Sign in"}</button>`}
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
									<strong>${p.name} ${p.role === "viewer" && html`<span class="badge">View only</span>`}</strong>
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
	const canEdit = project.role === "editor" || project.role === "owner";
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
				<div class="seg" role="tablist" style=${`--index:${["preview", "code", "data"].indexOf(tab)};--count:3`}>
					<button role="tab" aria-selected=${tab === "preview"} onClick=${() => setTab("preview")}>${icon("eye")} Preview</button>
					<button role="tab" aria-selected=${tab === "code"} onClick=${() => setTab("code")}>${icon("code")} Code</button>
					<button role="tab" aria-selected=${tab === "data"} onClick=${() => setTab("data")}>${icon("database")} Data</button>
				</div>
			</div>
			<div class="right">
				<button class="icon-btn" title="Versions" aria-pressed=${panel === "versions"} onClick=${() => togglePanel("versions")}>
					${icon("history")}
				</button>
				<button class="icon-btn" title="Dev server log" aria-pressed=${panel === "logs"} onClick=${() => togglePanel("logs")}>
					${icon("terminal")}
				</button>
				<button class="icon-btn" title="GitHub" aria-pressed=${panel === "github"} onClick=${() => togglePanel("github")}>${icon("github")}</button>
				<button class="icon-btn" title="Share" aria-pressed=${panel === "share"} onClick=${() => togglePanel("share")}>${icon("share")}</button>
				<span class="sep"></span>
				${canEdit
					? html`<button class="btn primary sm" onClick=${() => togglePanel("publish")}>${icon("globe")} Publish</button>`
					: html`<span class="badge">${icon("eye")} View only</span>`}
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
				${canEdit
					? html`<div class="chat-input">
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
				</div>`
					: html`<div class="chat-input">
							<div class="callout">${icon("eye")} You can view this app. Ask its owner for edit access to change it.</div>
						</div>`}
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
					canEdit=${canEdit}
					active=${tab === "code"}
					restored=${restored}
					onSaved=${() => setPreviewKey((k) => k + 1)}
				/>
				<${DataView} project=${project} running=${running} active=${tab === "data"} onChanged=${() => setPreviewKey((k) => k + 1)} />
				<${Sheet} open=${panel === "versions"} title="Versions" onClose=${() => setPanel(null)}>
					<${VersionsPanel}
						id=${id}
						running=${running}
						canEdit=${canEdit}
						onRestored=${() => {
							setPreviewKey((k) => k + 1);
							setRestored((n) => n + 1);
						}}
					/>
				<//>
				<${Sheet} open=${panel === "logs"} title="Dev server log" onClose=${() => setPanel(null)}>
					<${LogsPanel} id=${id} />
				<//>
				<${Sheet} open=${panel === "github"} title="GitHub" onClose=${() => setPanel(null)}>
					<${GitHubPanel} project=${project} running=${running} open=${panel === "github"} />
				<//>
				<${Sheet} open=${panel === "share"} title="Share" onClose=${() => setPanel(null)}>
					<${SharePanel} project=${project} onChange=${loadProject} />
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

function CodeView({ id, running, canEdit, active, restored, onSaved }) {
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
	live.current = { doc, dirty, running, saving, locked: running || !canEdit };

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
			editor.current.setReadOnly(live.current.locked);
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
		if (!current || current.status !== "ready" || !changed || inFlight || !canEdit) return;
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
		editor.current?.setReadOnly(running || !canEdit);
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
				${!canEdit && html`<span class="badge">${icon("eye")} View only</span>`}
				${canEdit && doc?.status === "ready" &&
				html`<span class=${`save-state ${dirty ? "dirty" : ""}`}>
					${saving ? html`<span class="spinner"></span> Saving` : dirty ? html`<span class="dot"></span> Unsaved` : html`${icon("check")} Saved`}
				</span>`}
				${canEdit &&
				html`<button class="btn sm primary" disabled=${!dirty || saving || running || doc?.status !== "ready"} onClick=${save} title="Save (⌘S)">
					Save
				</button>`}
			</div>
			${running && canEdit && html`<div class="banner"><span class="spinner"></span> The agent is working, so editing is paused until it finishes.</div>`}
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

// ---------------------------------------------------------------------------
// Data view: the app's own database. Preview and live are separate databases; the live one
// exists after the first publish. Cells edit in place on tables with a primary key.

const PAGE_SIZE = 50;

function keyOf(table, row) {
	return Object.fromEntries(table.primaryKey.map((name) => [name, row[name]]));
}

function Cell({ value }) {
	if (value === null) return html`<span class="null">NULL</span>`;
	return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}

function DataView({ project, running, active, onChanged }) {
	const id = project.id;
	const [env, setEnv] = useState("preview");
	const [info, setInfo] = useState(null);
	const [selected, setSelected] = useState(null);
	const [page, setPage] = useState(null);
	const [offset, setOffset] = useState(0);
	const [editing, setEditing] = useState(null);
	const [adding, setAdding] = useState(null);
	const [sqlOpen, setSqlOpen] = useState(false);
	const [sql, setSql] = useState("");
	const [result, setResult] = useState(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const started = useRef(false);
	const wasRunning = useRef(running);

	const loadTables = async (nextEnv = env) => {
		setError("");
		try {
			const data = await api(`/projects/${id}/data/tables?env=${nextEnv}`);
			setInfo(data);
			const names = data.tables.map((t) => t.name);
			const first = data.tables.find((t) => t.primaryKey.length > 0) ?? data.tables[0];
			setSelected((current) => (names.includes(current) ? current : (first?.name ?? null)));
		} catch (err) {
			setInfo({ tables: [], canWrite: false, missing: false });
			setError(err.message);
		}
	};

	const loadRows = async () => {
		if (!selected) {
			setPage(null);
			return;
		}
		try {
			const params = new URLSearchParams({ env, table: selected, offset: String(offset), limit: String(PAGE_SIZE) });
			setPage(await api(`/projects/${id}/data/rows?${params}`));
		} catch (err) {
			setError(err.message);
		}
	};

	useEffect(() => {
		if (!active || started.current) return;
		started.current = true;
		loadTables();
	}, [active]);

	// The agent may have added tables or rows.
	useEffect(() => {
		if (wasRunning.current && !running && started.current) loadTables();
		wasRunning.current = running;
	}, [running]);

	useEffect(() => {
		setEditing(null);
		setAdding(null);
		loadRows();
	}, [selected, offset, env, info]);

	const switchEnv = (next) => {
		if (next === env) return;
		setEnv(next);
		setOffset(0);
		setPage(null);
		setResult(null);
		loadTables(next);
	};

	const changed = () => {
		loadRows();
		if (env === "preview") onChanged();
	};

	const send = async (method, body) => {
		setBusy(true);
		try {
			await api(`/projects/${id}/data/rows?env=${env}`, { method, body: { table: selected, ...body } });
			return true;
		} catch (err) {
			toast(err.message, "error");
			return false;
		} finally {
			setBusy(false);
		}
	};

	const saveCell = async () => {
		if (!editing) return;
		const { row, column, value } = editing;
		const original = row[column.name];
		const next = value === "" && column.nullable ? null : value;
		setEditing(null);
		if (next === original) return;
		if (await send("PATCH", { key: keyOf(page.table, row), values: { [column.name]: next } })) changed();
	};

	const saveNew = async () => {
		// Empty fields are left out so the column default (an id, a timestamp) applies.
		const values = Object.fromEntries(Object.entries(adding).filter(([, value]) => value !== ""));
		if (await send("POST", { values })) {
			setAdding(null);
			toast("Row added");
			changed();
			loadTables();
		}
	};

	const remove = async (row) => {
		if (!confirm(env === "live" ? "Delete this row from the live app?" : "Delete this row?")) return;
		if (await send("DELETE", { key: keyOf(page.table, row) })) changed();
	};

	const runQuery = async () => {
		setBusy(true);
		setResult(null);
		try {
			setResult(await api(`/projects/${id}/data/sql?env=${env}`, { method: "POST", body: { sql } }));
			loadTables();
		} catch (err) {
			setResult({ error: err.message });
		}
		setBusy(false);
	};

	const tables = info?.tables ?? [];
	const table = page?.table;
	const editable = Boolean(info?.canWrite && table?.primaryKey.length);
	const total = page?.total ?? 0;

	return html`<div class="code data" hidden=${!active}>
		<aside class="tree">
			<div class="tree-head">
				<span>Tables</span>
				<button class="icon-btn" title="Refresh" onClick=${() => loadTables()}>${icon("refresh")}</button>
			</div>
			<div class="tree-filter">
				<div class="seg env-seg" role="tablist" style=${`--index:${env === "live" ? 1 : 0};--count:2`}>
					<button role="tab" aria-selected=${env === "preview"} onClick=${() => switchEnv("preview")}>Preview</button>
					<button role="tab" aria-selected=${env === "live"} onClick=${() => switchEnv("live")}>Live</button>
				</div>
			</div>
			<div class="tree-list">
				${info === null && html`<div class="empty"><span class="spinner"></span></div>`}
				${info?.missing && html`<div class="empty small">${icon("globe")} The live database is created the first time you publish.</div>`}
				${info && !info.missing && tables.length === 0 && !error &&
				html`<div class="empty small">${icon("table")} No tables yet. Ask the agent for a feature that saves data.</div>`}
				${tables.map(
					(t) => html`<button
						class="tree-row"
						aria-selected=${selected === t.name}
						title=${t.name}
						onClick=${() => {
							setSelected(t.name);
							setOffset(0);
						}}
					>
						${icon("table")}<span class="grow">${t.name}</span><span class="count">${t.rowCount}</span>
					</button>`,
				)}
			</div>
		</aside>
		<section class="editor-pane">
			<div class="editor-bar">
				<div class="crumbs">
					${table ? html`<b>${table.name}</b><span class="faint">· ${total} ${total === 1 ? "row" : "rows"}</span>` : html`<span>${env === "live" ? "Live data" : "Preview data"}</span>`}
				</div>
				${table && info?.canWrite &&
				html`<button class="btn sm" disabled=${busy || adding} onClick=${() => setAdding({})}>${icon("plus")} Add row</button>`}
				<button class="btn sm" aria-pressed=${sqlOpen} onClick=${() => setSqlOpen((open) => !open)}>${icon("terminal")} SQL</button>
			</div>
			${env === "live" && info && !info.missing &&
			html`<div class=${`banner ${info.canWrite ? "warn" : ""}`}>
				${icon("globe")}
				${info.canWrite ? "This is the published app's real data. Changes apply right away." : "Live data is read-only for you. The app's owner or an admin can change it."}
			</div>`}
			${env === "preview" && html`<div class="banner subtle">${icon("eye")} Test data for the preview. The published app has its own database.</div>`}
			${error && html`<div class="error" style="padding:8px 14px">${error}</div>`}
			<div class="grid-wrap">
				${table &&
				html`<table class="data-grid">
					<thead>
						<tr>
							${table.columns.map(
								(c) => html`<th title=${c.type}>
									${c.name}${table.primaryKey.includes(c.name) && html`<span class="pk">key</span>`}
									<span class="type">${c.type}</span>
								</th>`,
							)}
							${editable && html`<th class="actions"></th>`}
						</tr>
					</thead>
					<tbody>
						${adding &&
						html`<tr class="adding">
							${table.columns.map(
								(c) => html`<td>
									<input
										class="cell-input"
										placeholder=${c.hasDefault ? "default" : c.nullable ? "NULL" : ""}
										value=${adding[c.name] ?? ""}
										onInput=${(e) => setAdding({ ...adding, [c.name]: e.target.value })}
										onKeyDown=${(e) => {
											if (e.key === "Enter") saveNew();
											if (e.key === "Escape") setAdding(null);
										}}
									/>
								</td>`,
							)}
							<td class="actions">
								<div class="row" style="gap:4px;flex-wrap:nowrap">
									<button class="btn sm primary" disabled=${busy} onClick=${saveNew}>Save</button>
									<button class="icon-btn" title="Cancel" onClick=${() => setAdding(null)}>${icon("x")}</button>
								</div>
							</td>
						</tr>`}
						${(page?.rows ?? []).map(
							(row) => html`<tr>
								${table.columns.map((c) =>
									editing?.row === row && editing.column.name === c.name
										? html`<td class="editing">
												<input
													class="cell-input"
													ref=${(el) => el && document.activeElement !== el && el.focus()}
													placeholder=${c.nullable ? "NULL" : ""}
													value=${editing.value}
													onInput=${(e) => setEditing({ ...editing, value: e.target.value })}
													onBlur=${saveCell}
													onKeyDown=${(e) => {
														if (e.key === "Enter") e.target.blur();
														if (e.key === "Escape") setEditing(null);
													}}
												/>
											</td>`
										: html`<td
												class=${editable ? "editable" : ""}
												title=${row[c.name] ?? "NULL"}
												onClick=${() => editable && !busy && setEditing({ row, column: c, value: row[c.name] ?? "" })}
											>
												<${Cell} value=${row[c.name]} />
											</td>`,
								)}
								${editable &&
								html`<td class="actions">
									<button class="icon-btn" title="Delete row" onClick=${() => remove(row)}>${icon("trash")}</button>
								</td>`}
							</tr>`,
						)}
					</tbody>
				</table>`}
				${table && page && page.rows.length === 0 && !adding && html`<div class="empty small">This table is empty.</div>`}
				${table && info?.canWrite && !table.primaryKey.length &&
				html`<p class="faint" style="padding:8px 14px;font-size:12px">This table has no primary key, so rows can only be changed with SQL.</p>`}
			</div>
			${total > PAGE_SIZE &&
			html`<div class="pager">
				<span class="faint">${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}</span>
				<button class="btn sm" disabled=${offset === 0} onClick=${() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
				<button class="btn sm" disabled=${offset + PAGE_SIZE >= total} onClick=${() => setOffset(offset + PAGE_SIZE)}>Next</button>
			</div>`}
			${sqlOpen &&
			html`<div class="sql-panel">
				<div class="sql-box">
					<textarea
						class="input mono"
						spellcheck="false"
						placeholder=${info?.canWrite ? "select * from ...   (⌘ Enter to run)" : "select * from ...   (read-only, ⌘ Enter to run)"}
						value=${sql}
						onInput=${(e) => setSql(e.target.value)}
						onKeyDown=${(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								runQuery();
							}
						}}
					></textarea>
					<button class="btn sm primary" disabled=${busy || !sql.trim()} onClick=${runQuery}>${icon("play")} Run</button>
				</div>
				${result?.error && html`<pre class="log boxed error">${result.error}</pre>`}
				${result && !result.error &&
				html`<div class="sql-result">
					${result.columns.length > 0
						? html`<table class="data-grid">
								<thead>
									<tr>
										${result.columns.map((name) => html`<th>${name}</th>`)}
									</tr>
								</thead>
								<tbody>
									${result.rows.map(
										(row) => html`<tr>
											${row.map((value) => html`<td><${Cell} value=${value} /></td>`)}
										</tr>`,
									)}
								</tbody>
							</table>`
						: html`<p class="faint" style="padding:8px 2px;font-size:12.5px">${result.command} · ${result.rowCount ?? 0} rows affected</p>`}
					${result.truncated && html`<p class="faint" style="font-size:12px">Showing the first 500 rows.</p>`}
				</div>`}
			</div>`}
		</section>
	</div>`;
}

function VersionsPanel({ id, running, canEdit, onRestored }) {
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
				${i > 0 && canEdit && html`<button class="btn sm" disabled=${running} onClick=${() => restore(v.commit)}>Restore</button>`}
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

function GitHubPanel({ project, running, open }) {
	const [info, setInfo] = useState(null);
	const [form, setForm] = useState({ mode: "create", repo: project.slug, branch: "main", private: true, autoPush: true });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [conflict, setConflict] = useState(false);
	const load = () => api(`/projects/${project.id}/github`).then(setInfo, (err) => setError(err.message));
	useEffect(() => {
		if (open) load();
	}, [open, project.id]);
	const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
	const run = async (fn) => {
		setBusy(true);
		setError("");
		try {
			await fn();
		} catch (err) {
			setError(err.message);
		}
		setBusy(false);
	};
	const link = () =>
		run(async () => {
			const result = await api(`/projects/${project.id}/github/link`, {
				method: "POST",
				body: { create: form.mode === "create", repo: form.repo, branch: form.branch, private: form.private, autoPush: form.autoPush },
			});
			setInfo({ ...info, ...result });
			if (result.pushError) setError(result.pushError);
			else toast(`Pushed to ${result.repo}`);
		});
	const push = (force = false) =>
		run(async () => {
			try {
				await api(`/projects/${project.id}/github/push`, { method: "POST", body: { force } });
				setConflict(false);
				toast(`Pushed to ${info.repo}`);
				load();
			} catch (err) {
				setConflict(/Overwrite/.test(err.message));
				throw err;
			}
		});
	if (!info) return html`<div class="sheet-body">${error ? html`<p class="error">${error}</p>` : html`<div class="empty"><span class="spinner"></span></div>`}</div>`;
	if (!info.configured) {
		return html`<div class="sheet-body">
			<div class="callout">Push this app's code to your organization's GitHub. An admin connects GitHub once under <a href="#/settings">Settings</a>.</div>
		</div>`;
	}
	if (!info.repo) {
		if (!info.canLink) return html`<div class="sheet-body"><div class="callout">Not linked to GitHub yet. The app's owner or an admin can link a repository.</div></div>`;
		return html`<div class="sheet-body">
			<p class="faint" style="font-size:13px;margin:0 0 8px">Every version of the app becomes a commit in the repository, so the team can review the code, keep a copy, or take it further outside Agency.</p>
			<div class="seg-choice">
				<label class="check"><input type="radio" checked=${form.mode === "create"} onChange=${() => setForm({ ...form, mode: "create", repo: project.slug })} /> New repository in ${info.owner}</label>
				<label class="check"><input type="radio" checked=${form.mode === "existing"} onChange=${() => setForm({ ...form, mode: "existing", repo: `${info.owner}/` })} /> Existing repository</label>
			</div>
			<label class="field">
				<span>${form.mode === "create" ? "Repository name" : "Repository"} ${form.mode === "existing" && html`<span class="hint">owner/name</span>`}</span>
				<input class="input mono" value=${form.repo} onInput=${set("repo")} />
			</label>
			<label class="field">
				<span>Branch</span>
				<input class="input mono" value=${form.branch} onInput=${set("branch")} />
			</label>
			${form.mode === "create" && html`<label class="check"><input type="checkbox" checked=${form.private} onChange=${set("private")} /> Private repository</label>`}
			<label class="check"><input type="checkbox" checked=${form.autoPush} onChange=${set("autoPush")} /> Push every new version automatically</label>
			${error && html`<p class="error">${error}</p>`}
			<button class="btn primary" disabled=${busy || running || !form.repo.trim()} onClick=${link}>
				${busy ? html`<span class="spinner"></span>` : icon("github")} ${form.mode === "create" ? "Create and push" : "Link and push"}
			</button>
			${running && html`<p class="faint" style="font-size:12.5px">Available when the agent finishes.</p>`}
		</div>`;
	}
	return html`<div class="sheet-body">
		<div class="callout">
			${icon("github")} <a href=${info.url} target="_blank" rel="noopener">${info.repo}</a> · branch <span class="mono">${info.branch}</span>
			<div class="faint" style="margin-top:4px">
				${info.pushedAt ? html`Last pushed <span class="mono">${info.pushedCommit?.slice(0, 7)}</span> ${timeAgo(info.pushedAt)}` : "Not pushed yet"}
			</div>
		</div>
		${info.canPush &&
		html`<div class="row">
			<button class="btn primary grow" disabled=${busy || running} onClick=${() => push(false)}>
				${busy ? html`<span class="spinner"></span> Pushing` : html`${icon("github")} Push now`}
			</button>
			${conflict && html`<button class="btn danger" disabled=${busy} onClick=${() => confirm(`Replace the history of ${info.branch} on GitHub with this app's?`) && push(true)}>Overwrite</button>`}
		</div>`}
		<label class="check">
			<input
				type="checkbox"
				checked=${info.autoPush}
				disabled=${!info.canLink}
				onChange=${(e) => run(async () => setInfo({ ...info, ...(await api(`/projects/${project.id}/github`, { method: "PATCH", body: { autoPush: e.target.checked } })) }))}
			/>
			Push every new version automatically
		</label>
		${error && html`<p class="error">${error}</p>`}
		${info.canLink &&
		html`<button
			class="link-btn"
			onClick=${() => confirm("Unlink this repository? Nothing is deleted on GitHub.") && run(async () => setInfo({ ...info, ...(await api(`/projects/${project.id}/github`, { method: "DELETE" })) }))}
		>
			Unlink repository
		</button>`}
	</div>`;
}

const TEAM_ACCESS = {
	none: "Only the people below",
	viewer: "Everyone on the team can view",
	editor: "Everyone on the team can edit",
};

function SharePanel({ project, onChange }) {
	const [data, setData] = useState(null);
	const [people, setPeople] = useState([]);
	const [pick, setPick] = useState("");
	const [pickRole, setPickRole] = useState("editor");
	const [error, setError] = useState("");
	useEffect(() => {
		api(`/projects/${project.id}/sharing`).then(setData, (err) => setError(err.message));
		api("/people").then(setPeople, () => {});
	}, [project.id]);
	const update = async (body) => {
		setError("");
		try {
			setData(await api(`/projects/${project.id}/sharing`, { method: "PUT", body }));
			onChange();
		} catch (err) {
			setError(err.message);
		}
	};
	if (!data) return html`<div class="sheet-body">${error ? html`<p class="error">${error}</p>` : html`<div class="empty"><span class="spinner"></span></div>`}</div>`;
	const taken = new Set([data.owner.id, ...data.members.map((m) => m.userId)]);
	const candidates = people.filter((p) => !taken.has(p.id));
	const who = (person) => html`<span class="avatar">${(person.name || person.email).slice(0, 1)}</span>
		<div class="grow">
			<div class="title">${person.name || person.email}</div>
			${person.name && html`<div class="sub">${person.email}</div>`}
		</div>`;
	return html`<div class="sheet-body">
		<p class="faint" style="font-size:13px;margin:0 0 8px">
			Viewers open the preview and the published app. Editors also chat with the agent, edit code and data, and publish. The owner and admins can always do everything.
		</p>
		<label class="field">
			<span>General access</span>
			<select class="select" value=${data.teamAccess} disabled=${!data.canManage} onChange=${(e) => update({ teamAccess: e.target.value })}>
				${Object.entries(TEAM_ACCESS).map(([key, label]) => html`<option value=${key}>${label}</option>`)}
			</select>
		</label>
		<h4 class="section-title" style="margin:8px 0 0">People</h4>
		<div>
			<div class="list-row person">${who(data.owner)}<span class="badge accent">Owner</span></div>
			${data.members.map(
				(m) => html`<div class="list-row person">
					${who(m)}
					${data.canManage
						? html`<select class="select sm" value=${m.role} onChange=${(e) => update({ member: { userId: m.userId, role: e.target.value } })}>
									<option value="viewer">Can view</option>
									<option value="editor">Can edit</option>
								</select>
								<button class="icon-btn" title="Remove" onClick=${() => update({ member: { userId: m.userId, role: null } })}>${icon("x")}</button>`
						: html`<span class="badge">${m.role === "editor" ? "Can edit" : "Can view"}</span>`}
				</div>`,
			)}
		</div>
		${data.canManage &&
		html`<div class="row share-add">
			<select class="select grow" value=${pick} onChange=${(e) => setPick(e.target.value)}>
				<option value="">${candidates.length ? "Add a person..." : "Everyone is already added"}</option>
				${candidates.map((p) => html`<option value=${p.id}>${p.name ? `${p.name} (${p.email})` : p.email}</option>`)}
			</select>
			<select class="select sm" value=${pickRole} onChange=${(e) => setPickRole(e.target.value)}>
				<option value="viewer">Can view</option>
				<option value="editor">Can edit</option>
			</select>
			<button
				class="btn primary sm"
				disabled=${!pick}
				onClick=${async () => {
					await update({ member: { userId: pick, role: pickRole } });
					setPick("");
				}}
			>
				Add
			</button>
		</div>`}
		${!data.canManage && html`<div class="callout">Only the owner or an admin can change who has access.</div>`}
		${error && html`<p class="error">${error}</p>`}
	</div>`;
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
			Publishes to <a href=${project.appUrl} target="_blank" rel="noopener">${project.appUrl}</a>. Only people the app is shared with can open it.
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

const REDIRECT_URL = `${location.origin}/oauth/callback`;

const CONNECTION_TYPES = {
	postgres: { label: "Postgres", kind: "postgres", ssl: "verify", hint: "postgres://user:password@host:5432/database" },
	supabase: {
		label: "Supabase",
		kind: "postgres",
		ssl: "require",
		hint: "Supabase > Project Settings > Database > Connection string (session pooler)",
	},
	rds: { label: "AWS RDS / Aurora Postgres", kind: "postgres", ssl: "require", hint: "postgres://user:password@xxx.rds.amazonaws.com:5432/db" },
	google_drive: {
		label: "Google Drive and Sheets",
		kind: "google_drive",
		name: "drive",
		description: "Shared drive files and spreadsheets",
		hint: "Files, Docs and Sheets, read with the Google account you connect.",
		steps: [
			"In Google Cloud Console, open APIs & Services and enable the Google Drive API and the Google Sheets API.",
			"Set up the OAuth consent screen. On Google Workspace pick Internal, so only your organization can use it.",
			"Under Credentials, create an OAuth client ID of type Web application and add the redirect URI below.",
			"Paste the client ID and secret here, add the connection, and sign in with the Google account whose files apps should see.",
		],
	},
	salesforce: {
		label: "Salesforce",
		kind: "salesforce",
		name: "salesforce",
		description: "CRM: accounts, opportunities, contacts",
		hint: "Objects and SOQL queries, with the Salesforce user you connect.",
		steps: [
			"In Salesforce Setup, open App Manager and create an External Client App (or a Connected App) with OAuth enabled.",
			"Use the redirect URI below as the callback URL, add the scopes api and refresh_token (offline_access), and keep PKCE on.",
			"Paste the consumer key (and the secret if the app has one). Sandboxes sign in at https://test.salesforce.com.",
			"Add the connection and sign in with the Salesforce user whose data apps should see; a read-only integration user is safest.",
		],
	},
	monday: {
		label: "monday.com",
		kind: "mcp_http",
		name: "monday",
		description: "Boards, items and updates",
		url: "https://mcp.monday.com/mcp",
		auth: "oauth",
		hint: "monday.com's own MCP server. Sign in, or paste an API token from your monday.com profile > Developers.",
		tokenHeader: "Authorization: Bearer <API token>",
	},
	notion: {
		label: "Notion",
		kind: "mcp_http",
		name: "notion",
		description: "Pages and databases",
		url: "https://mcp.notion.com/mcp",
		auth: "oauth",
		hint: "Notion's own MCP server. Sign in with the workspace apps should read.",
	},
	linear: {
		label: "Linear",
		kind: "mcp_http",
		name: "linear",
		description: "Issues and projects",
		url: "https://mcp.linear.app/mcp",
		auth: "oauth",
		hint: "Linear's own MCP server. Sign in with the workspace apps should read.",
	},
	mcp_http: {
		label: "Other MCP server (URL)",
		kind: "mcp_http",
		auth: "headers",
		hint: "The vendor's streamable HTTP MCP endpoint, usually ending in /mcp",
	},
	mcp_stdio: { label: "MCP server (command)", kind: "mcp_stdio", hint: "npx -y some-mcp-server --flag" },
};

const KIND_LABELS = { postgres: "Postgres", mcp_http: "MCP", mcp_stdio: "MCP command", google_drive: "Google Drive", salesforce: "Salesforce" };

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

function emptyForm(spec = {}) {
	return {
		name: spec.name ?? "",
		description: spec.description ?? "",
		target: spec.url ?? "",
		extra: "",
		clientId: "",
		clientSecret: "",
		loginUrl: "",
		auth: spec.auth ?? "headers",
		allowWrite: false,
	};
}

function connectionConfig(spec, form) {
	if (spec.kind === "postgres") return { connectionString: form.target, ssl: spec.ssl };
	if (spec.kind === "google_drive") return { clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim() };
	if (spec.kind === "salesforce") {
		return { clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim() || undefined, loginUrl: form.loginUrl.trim() || undefined };
	}
	if (spec.kind === "mcp_http") {
		const config = { url: form.target.trim(), headers: parseHeaders(form.extra) };
		if (form.auth === "oauth") {
			config.oauth = {};
			if (form.clientId.trim()) config.oauth.clientId = form.clientId.trim();
			if (form.clientSecret.trim()) config.oauth.clientSecret = form.clientSecret.trim();
		}
		return config;
	}
	const [command, ...args] = form.target.trim().split(/\s+/);
	return { command, args, env: parseEnv(form.extra) };
}

/** Sends the admin to the provider's sign-in page; they come back to /oauth/callback. */
async function connectAccount(connection) {
	try {
		const { url } = await api(`/connections/${connection.id}/connect`, { method: "POST" });
		if (url) location.href = url;
		else toast(`${connection.name} is already connected`);
		return Boolean(url);
	} catch (err) {
		toast(err.message, "error");
		return false;
	}
}

function AppAccess({ connection, projects, onSaved, onCancel }) {
	const [all, setAll] = useState(connection.allProjects);
	const [ids, setIds] = useState(() => new Set(connection.projectIds));
	const [busy, setBusy] = useState(false);
	const save = async () => {
		setBusy(true);
		try {
			await api(`/connections/${connection.id}/projects`, { method: "PUT", body: { allProjects: all, projectIds: [...ids] } });
			toast(`Updated who can use ${connection.name}`);
			onSaved();
		} catch (err) {
			toast(err.message, "error");
		}
		setBusy(false);
	};
	return html`<div class="app-access">
		<label class="check"><input type="radio" checked=${all} onChange=${() => setAll(true)} /> All apps</label>
		<label class="check"><input type="radio" checked=${!all} onChange=${() => setAll(false)} /> Only these apps</label>
		${!all &&
		html`<div class="app-list">
			${projects === null
				? html`<span class="spinner"></span>`
				: projects.length === 0
					? html`<span class="faint">No apps yet.</span>`
					: projects.map(
							(p) => html`<label class="check">
								<input
									type="checkbox"
									checked=${ids.has(p.id)}
									onChange=${(e) => {
										const next = new Set(ids);
										if (e.target.checked) next.add(p.id);
										else next.delete(p.id);
										setIds(next);
									}}
								/>
								${p.name} <span class="faint mono">${p.slug}</span>
							</label>`,
						)}
		</div>`}
		<div class="row">
			<button class="btn primary sm" disabled=${busy} onClick=${save}>Save</button>
			<button class="btn sm" onClick=${onCancel}>Cancel</button>
		</div>
	</div>`;
}

function Connections({ user }) {
	const [connections, setConnections] = useState(null);
	const [projects, setProjects] = useState(null);
	const [type, setType] = useState("postgres");
	const [form, setForm] = useState(emptyForm());
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [results, setResults] = useState({});
	const [editing, setEditing] = useState(null);
	const isAdmin = user.role === "admin";
	const load = () => api("/connections").then(setConnections, (err) => setError(err.message));
	useEffect(() => {
		load();
		if (isAdmin) api("/projects").then(setProjects, () => setProjects([]));
		// Back from a provider's sign-in page.
		const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
		if (params.get("connected")) toast(`Connected ${params.get("connected")}`);
		if (params.get("oauth_error")) toast(`Sign-in failed: ${params.get("oauth_error")}`, "error");
		if (params.size) history.replaceState(null, "", "#/connections");
	}, []);
	const spec = CONNECTION_TYPES[type];
	const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
	const pickType = (next) => {
		setType(next);
		setForm(emptyForm(CONNECTION_TYPES[next]));
		setError("");
	};
	const signInType = spec.kind === "google_drive" || spec.kind === "salesforce" || (spec.kind === "mcp_http" && form.auth === "oauth");
	const add = async (e) => {
		e.preventDefault();
		setError("");
		setBusy(true);
		try {
			const connection = await api("/connections", {
				method: "POST",
				body: {
					name: form.name,
					kind: spec.kind,
					description: form.description,
					allowWrite: form.allowWrite,
					config: connectionConfig(spec, form),
				},
			});
			setForm(emptyForm(spec));
			await load();
			if (connection.signIn === "needed") {
				if (await connectAccount(connection)) return;
			} else toast(`Added ${connection.name}`);
		} catch (err) {
			setError(err.message);
		}
		setBusy(false);
	};
	const test = async (name) => {
		setResults({ ...results, [name]: { pending: true } });
		const result = await api(`/connections/${name}/test`, { method: "POST" });
		setResults((r) => ({ ...r, [name]: result }));
	};
	const disconnect = async (c) => {
		if (!confirm(`Sign ${c.name} out? Apps using it stop getting data until someone connects it again.`)) return;
		await api(`/connections/${c.id}/disconnect`, { method: "POST" });
		load();
	};
	const remove = async (id) => {
		if (!confirm("Remove this connection? Apps using it will stop getting data.")) return;
		await api(`/connections/${id}`, { method: "DELETE" });
		load();
	};
	const appsLabel = (c) => {
		if (c.allProjects) return "All apps";
		const names = (projects ?? []).filter((p) => c.projectIds.includes(p.id)).map((p) => p.name);
		if (names.length === 0) return c.projectIds.length ? `${c.projectIds.length} apps` : "No apps";
		return names.length <= 2 ? names.join(", ") : `${names.length} apps`;
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
								return html`<div class="list-row connection-row">
									<div class="grow">
										<div class="title">
											${c.name} <span class="badge">${KIND_LABELS[c.kind] ?? c.kind}</span>
											${c.allowWrite ? html`<span class="badge">writes allowed</span>` : html`<span class="badge">read-only</span>`}
											${c.signIn === "needed" && html`<span class="badge warn"><span class="dot"></span>Not connected</span>`}
											${c.signIn === "signed_in" && html`<span class="badge live"><span class="dot"></span>Connected</span>`}
										</div>
										${c.description && html`<div class="sub">${c.description}</div>`}
										<div class="sub">
											${c.signIn === "signed_in" && c.account ? html`Signed in as ${c.account} · ` : null}
											${isAdmin
												? html`<button class="link-btn" onClick=${() => setEditing(editing === c.id ? null : c.id)}>${icon("link")} ${appsLabel(c)}</button>`
												: appsLabel(c)}
										</div>
										${result &&
										html`<div class="sub" style=${result.pending ? "" : `color:var(${result.ok ? "--success" : "--danger"})`}>
											${result.pending ? "Testing..." : result.message}
										</div>`}
										${editing === c.id &&
										html`<${AppAccess}
											connection=${c}
											projects=${projects}
											onSaved=${() => {
												setEditing(null);
												load();
											}}
											onCancel=${() => setEditing(null)}
										/>`}
									</div>
									<div class="row-actions">
										${isAdmin && c.signIn === "needed" && html`<button class="btn sm primary" onClick=${() => connectAccount(c)}>Connect</button>`}
										${c.signIn !== "needed" && html`<button class="btn sm" onClick=${() => test(c.name)}>Test</button>`}
										${isAdmin && c.signIn === "signed_in" && html`<button class="btn sm" onClick=${() => connectAccount(c)}>Reconnect</button>`}
										${isAdmin && c.signIn === "signed_in" && html`<button class="btn sm" onClick=${() => disconnect(c)}>Disconnect</button>`}
										${isAdmin && html`<button class="btn sm danger" onClick=${() => remove(c.id)}>Remove</button>`}
									</div>
								</div>`;
							})}
			</div>
			${isAdmin &&
			html`<form class="card" onSubmit=${add}>
				<div class="card-head">
					<h2>Add a connection</h2>
					<p>${spec.hint}</p>
				</div>
				<div class="card-body form-grid">
					<label class="field">
						<span>Type</span>
						<select class="select" value=${type} onChange=${(e) => pickType(e.target.value)}>
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
					${spec.steps &&
					html`<ol class="steps wide">
						${spec.steps.map((step) => html`<li>${step}</li>`)}
					</ol>`}
					${(spec.kind === "postgres" || spec.kind === "mcp_http" || spec.kind === "mcp_stdio") &&
					html`<label class="field wide">
						<span>${spec.kind === "postgres" ? "Connection string" : spec.kind === "mcp_http" ? "MCP URL" : "Command"}</span>
						<input class="input mono" placeholder=${spec.hint} value=${form.target} onInput=${set("target")} required />
					</label>`}
					${spec.kind === "mcp_http" &&
					html`<label class="field wide">
						<span>Authentication</span>
						<select class="select" value=${form.auth} onChange=${set("auth")}>
							<option value="oauth">Sign in with the service (OAuth)</option>
							<option value="headers">${spec.tokenHeader ? "API token" : "Headers or none"}</option>
						</select>
					</label>`}
					${spec.kind === "mcp_http" &&
					form.auth === "headers" &&
					html`<label class="field wide">
						<span>Headers <span class="hint">one per line</span></span>
						<textarea class="textarea mono" rows="2" placeholder=${spec.tokenHeader ?? "Authorization: Bearer ..."} value=${form.extra} onInput=${set("extra")}></textarea>
					</label>`}
					${spec.kind === "mcp_stdio" &&
					html`<label class="field wide">
						<span>Environment <span class="hint">KEY=value per line</span></span>
						<textarea class="textarea mono" rows="2" placeholder="API_TOKEN=..." value=${form.extra} onInput=${set("extra")}></textarea>
					</label>`}
					${(spec.kind === "google_drive" || spec.kind === "salesforce") &&
					html`<label class="field">
							<span>${spec.kind === "salesforce" ? "Consumer key" : "Client ID"}</span>
							<input class="input mono" value=${form.clientId} onInput=${set("clientId")} required />
						</label>
						<label class="field">
							<span>${spec.kind === "salesforce" ? "Consumer secret" : "Client secret"} ${spec.kind === "salesforce" && html`<span class="hint">optional</span>`}</span>
							<input class="input mono" type="password" value=${form.clientSecret} onInput=${set("clientSecret")} required=${spec.kind === "google_drive"} />
						</label>`}
					${spec.kind === "salesforce" &&
					html`<label class="field wide">
						<span>Login URL <span class="hint">optional</span></span>
						<input class="input mono" placeholder="https://login.salesforce.com" value=${form.loginUrl} onInput=${set("loginUrl")} />
					</label>`}
					${spec.kind === "mcp_http" &&
					form.auth === "oauth" &&
					html`<p class="faint wide" style="margin:0;font-size:12.5px">
							Agency registers itself with the server when you connect. Only if the server asks for an app you registered yourself, enter its client ID and secret.
						</p>
						<label class="field">
							<span>Client ID <span class="hint">optional</span></span>
							<input class="input mono" value=${form.clientId} onInput=${set("clientId")} />
						</label>
						<label class="field">
							<span>Client secret <span class="hint">optional</span></span>
							<input class="input mono" type="password" value=${form.clientSecret} onInput=${set("clientSecret")} />
						</label>`}
					${signInType &&
					html`<div class="field wide">
						<span>Redirect URI <span class="hint">register this with the provider</span></span>
						<div class="copy-field">
							<code class="mono">${REDIRECT_URL}</code>
							<button
								type="button"
								class="btn sm"
								onClick=${() => navigator.clipboard?.writeText(REDIRECT_URL).then(() => toast("Copied the redirect URI"))}
							>
								Copy
							</button>
						</div>
					</div>`}
					<label class="check wide"><input type="checkbox" checked=${form.allowWrite} onChange=${set("allowWrite")} /> Allow apps to write</label>
					${error && html`<div class="error wide">${error}</div>`}
				</div>
				<div class="card-foot">
					<button class="btn primary" disabled=${busy}>
						${busy ? html`<span class="spinner"></span>` : icon("plus")} ${signInType ? "Add and connect" : "Add connection"}
					</button>
				</div>
			</form>`}
		</div>
	</div>`;
}

function UsagePage() {
	const [usage, setUsage] = useState(null);
	const [error, setError] = useState("");
	useEffect(() => {
		api("/usage").then(setUsage, (err) => setError(err.message));
	}, []);
	if (!usage) {
		return html`<div class="page">${error ? html`<p class="error">${error}</p>` : html`<div class="empty"><span class="spinner"></span></div>`}</div>`;
	}
	// One bar per day of the month so far, scaled to the busiest day.
	const days = [];
	const start = new Date(usage.periodStart);
	const today = new Date();
	for (let d = new Date(start); d <= today; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
	const byDay = Object.fromEntries(usage.byDay.map((d) => [d.day, d.costUsd]));
	const peak = Math.max(0.0001, ...usage.byDay.map((d) => d.costUsd));
	const out = !usage.unlimited && usage.spentUsd >= usage.budgetUsd;
	return html`<div class="page">
		<header class="page-head">
			<h1>Usage</h1>
			<p>What the AI agent has cost while building your apps this month. Your admin sets the budget.</p>
		</header>
		<div class="stack">
			<div class="card usage-hero">
				<div class="card-body">
					<div class="usage-figures">
						<div>
							<div class="label">Spent this month</div>
							<div class="amount">${money(usage.spentUsd)}</div>
						</div>
						<div class="right">
							<div class="label">${usage.unlimited ? "Budget" : "Remaining"}</div>
							<div class="amount soft">
								${usage.unlimited ? html`${icon("infinity")} Unlimited` : money(usage.remainingUsd)}
							</div>
						</div>
					</div>
					<${Meter} spent=${usage.spentUsd} budget=${usage.budgetUsd} unlimited=${usage.unlimited} />
					<div class="usage-foot">
						<span>${usage.unlimited ? "No monthly limit" : `Monthly budget ${money(usage.budgetUsd)}`}</span>
						<span>Resets ${shortDate(usage.resetsAt)}</span>
					</div>
					${out &&
					html`<p class="notice danger">${icon("alert")} You have used this month's budget. Ask an admin to raise it to keep building.</p>`}
				</div>
			</div>
			<div class="card">
				<div class="card-head"><h2>By day</h2></div>
				<div class="card-body">
					<div class="spark" aria-label="Spend per day">
						${days.map(
							(day) => html`<div class="spark-col" title=${`${shortDate(day)}: ${money(byDay[day] ?? 0)}`}>
								<span style=${`transform:scaleY(${(byDay[day] ?? 0) / peak})`}></span>
							</div>`,
						)}
					</div>
					<div class="usage-foot"><span>${shortDate(usage.periodStart)}</span><span>Today</span></div>
				</div>
			</div>
			<div class="card">
				<div class="card-head"><h2>By app</h2></div>
				${usage.byProject.length === 0
					? html`<div class="card-body faint">Nothing yet this month.</div>`
					: usage.byProject.map(
							(p) => html`<div class="list-row">
								<div class="grow">
									<div class="title">
										${p.projectId ? html`<a href=${`#/p/${p.projectId}`}>${p.name}</a>` : html`<span class="faint">${p.name}</span>`}
									</div>
									<div class="sub">${p.messages} agent ${p.messages === 1 ? "step" : "steps"}</div>
								</div>
								<span class="mono">${money(p.costUsd)}</span>
							</div>`,
						)}
			</div>
		</div>
	</div>`;
}

function BudgetEditor({ member, onSaved, onCancel }) {
	const [budget, setBudget] = useState(String(member.budgetUsd));
	const [unlimited, setUnlimited] = useState(member.unlimited);
	const [busy, setBusy] = useState(false);
	const save = async (e) => {
		e.preventDefault();
		setBusy(true);
		try {
			await api(`/users/${member.id}/budget`, { method: "PATCH", body: { budgetUsd: budget, unlimited } });
			toast(`Updated the budget for ${member.email}`);
			onSaved();
		} catch (err) {
			toast(err.message, "error");
			setBusy(false);
		}
	};
	return html`<form class="budget-editor" onSubmit=${save}>
		<label class="money-input" aria-disabled=${unlimited}>
			<span>$</span>
			<input
				class="input"
				type="number"
				min="0"
				step="1"
				inputmode="decimal"
				aria-label="Monthly budget in dollars"
				value=${budget}
				disabled=${unlimited}
				onInput=${(e) => setBudget(e.target.value)}
				autofocus
			/>
			<span class="faint">/ month</span>
		</label>
		<label class="check"><input type="checkbox" checked=${unlimited} onChange=${(e) => setUnlimited(e.target.checked)} /> Unlimited</label>
		<span class="grow"></span>
		<button type="button" class="btn sm" onClick=${onCancel}>Cancel</button>
		<button class="btn primary sm" disabled=${busy}>Save</button>
	</form>`;
}

const EMPTY_MEMBER = { email: "", name: "", password: "", role: "member", budgetUsd: "", unlimited: false };

function Team({ user, onChange }) {
	const [users, setUsers] = useState([]);
	const [form, setForm] = useState(EMPTY_MEMBER);
	const [editing, setEditing] = useState(null);
	const [error, setError] = useState("");
	const load = () => api("/users").then(setUsers, (err) => setError(err.message));
	useEffect(() => {
		load();
	}, []);
	const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
	const add = async (e) => {
		e.preventDefault();
		setError("");
		try {
			await api("/users", { method: "POST", body: form });
			toast(`Added ${form.email}`);
			setForm(EMPTY_MEMBER);
			load();
		} catch (err) {
			setError(err.message);
		}
	};
	if (user.role !== "admin") return html`<div class="page"><div class="empty">${icon("lock")} Only admins manage the team.</div></div>`;
	const total = users.reduce((sum, u) => sum + u.spentUsd, 0);
	return html`<div class="page">
		<header class="page-head">
			<h1>Team</h1>
			<p>People who can sign in, build apps and open published apps, and what each may spend on the AI agent per month.</p>
		</header>
		<div class="stack">
			<div class="card">
				<div class="card-head row">
					<h2 class="grow">Members</h2>
					<span class="muted" style="font-size:13px">${money(total)} spent this month</span>
				</div>
				${users.map(
					(u) => html`<div class="list-row member-row">
						<span class="avatar">${(u.name || u.email).slice(0, 1)}</span>
						<div class="grow">
							<div class="title">${u.name || u.email} <span class="badge">${u.role}</span></div>
							${u.name && html`<div class="sub">${u.email}</div>`}
						</div>
						${editing === u.id
							? html`<${BudgetEditor}
									member=${u}
									onCancel=${() => setEditing(null)}
									onSaved=${() => {
										setEditing(null);
										load();
										if (u.id === user.id) onChange?.();
									}}
								/>`
							: html`<div class="member-usage">
										<div class="row"><span class="mono">${spendLabel(u)}</span></div>
										<${Meter} spent=${u.spentUsd} budget=${u.budgetUsd} unlimited=${u.unlimited} />
									</div>
									<button class="btn sm" onClick=${() => setEditing(u.id)}>Budget</button>
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
									</button>`}`}
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
					<label class="field">
						<span>Monthly budget <span class="hint">US dollars, empty for the default</span></span>
						<input
							class="input"
							type="number"
							min="0"
							step="1"
							inputmode="decimal"
							placeholder="20"
							value=${form.budgetUsd}
							disabled=${form.unlimited}
							onInput=${set("budgetUsd")}
						/>
					</label>
					<label class="check field-check"><input type="checkbox" checked=${form.unlimited} onChange=${set("unlimited")} /> Unlimited budget</label>
					${error && html`<div class="error wide">${error}</div>`}
				</div>
				<div class="card-foot"><button class="btn primary">${icon("plus")} Add member</button></div>
			</form>
		</div>
	</div>`;
}

const SSO_PRESETS = {
	google: { label: "Google", issuer: "https://accounts.google.com", hint: "Google Cloud Console > APIs & Services > Credentials > OAuth client ID (Web application)" },
	entra: {
		label: "Microsoft",
		issuer: "https://login.microsoftonline.com/<tenant-id>/v2.0",
		hint: "Entra ID > App registrations > New registration (Web). Use your tenant ID in the issuer.",
	},
	okta: { label: "Okta", issuer: "https://<your-org>.okta.com", hint: "Okta Admin > Applications > Create App Integration > OIDC, Web Application" },
	other: { label: "SSO", issuer: "", hint: "Any OpenID Connect provider: use its issuer URL" },
};

function SsoSettings({ sso, publicUrl, onSaved }) {
	const [form, setForm] = useState(() => ({
		enabled: sso?.enabled ?? false,
		label: sso?.label ?? "Google",
		issuer: sso?.issuer ?? SSO_PRESETS.google.issuer,
		clientId: sso?.clientId ?? "",
		clientSecret: "",
		domains: (sso?.domains ?? []).join(", "),
		passwordLogin: sso?.passwordLogin ?? "admins",
	}));
	const [preset, setPreset] = useState("google");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
	const redirect = sso?.redirectUri ?? `${publicUrl}/auth/sso/callback`;
	const save = async (e) => {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			await api("/settings/sso", { method: "PUT", body: form });
			toast(form.enabled ? "Single sign-on is on" : "Saved");
			onSaved();
		} catch (err) {
			setError(err.message);
		}
		setBusy(false);
	};
	return html`<form class="card" onSubmit=${save}>
		<div class="card-head">
			<h2>${icon("key")} Single sign-on ${sso?.enabled ? html`<span class="badge live"><span class="dot"></span>On</span>` : html`<span class="badge">Off</span>`}</h2>
			<p>Only people with a verified email in your organization's domains can sign in. They join as members on their first sign-in.</p>
		</div>
		<div class="card-body form-grid">
			<label class="field">
				<span>Provider</span>
				<select
					class="select"
					value=${preset}
					onChange=${(e) => {
						const p = SSO_PRESETS[e.target.value];
						setPreset(e.target.value);
						setForm({ ...form, label: p.label, issuer: p.issuer });
					}}
				>
					<option value="google">Google Workspace</option>
					<option value="entra">Microsoft Entra ID</option>
					<option value="okta">Okta</option>
					<option value="other">Other OpenID Connect</option>
				</select>
			</label>
			<label class="field">
				<span>Button label <span class="hint">"Sign in with ..."</span></span>
				<input class="input" value=${form.label} onInput=${set("label")} />
			</label>
			<p class="faint wide" style="margin:0;font-size:12.5px">${SSO_PRESETS[preset].hint}</p>
			<label class="field wide">
				<span>Issuer URL</span>
				<input class="input mono" value=${form.issuer} onInput=${set("issuer")} required />
			</label>
			<label class="field">
				<span>Client ID</span>
				<input class="input mono" value=${form.clientId} onInput=${set("clientId")} />
			</label>
			<label class="field">
				<span>Client secret ${sso?.hasSecret && html`<span class="hint">saved; leave empty to keep</span>`}</span>
				<input class="input mono" type="password" value=${form.clientSecret} onInput=${set("clientSecret")} />
			</label>
			<label class="field wide">
				<span>Allowed email domains <span class="hint">comma separated</span></span>
				<input class="input" placeholder="acme.com, acme.co.il" value=${form.domains} onInput=${set("domains")} />
			</label>
			<div class="field wide">
				<span>Redirect URI <span class="hint">register this with the provider</span></span>
				<div class="copy-field">
					<code class="mono">${redirect}</code>
					<button type="button" class="btn sm" onClick=${() => navigator.clipboard?.writeText(redirect).then(() => toast("Copied the redirect URI"))}>Copy</button>
				</div>
			</div>
			<label class="field wide">
				<span>Password sign-in</span>
				<select class="select" value=${form.passwordLogin} onChange=${set("passwordLogin")}>
					<option value="admins">Only admins (a way in if the provider is down)</option>
					<option value="all">Everyone, alongside SSO</option>
				</select>
			</label>
			<label class="check wide"><input type="checkbox" checked=${form.enabled} onChange=${set("enabled")} /> Turn on single sign-on</label>
			${error && html`<div class="error wide">${error}</div>`}
		</div>
		<div class="card-foot"><button class="btn primary" disabled=${busy}>${busy && html`<span class="spinner"></span>`} Save</button></div>
	</form>`;
}

function GitHubSettings({ github, onSaved }) {
	const [form, setForm] = useState(() => ({ apiUrl: github?.apiUrl ?? "https://api.github.com", owner: github?.owner ?? "", token: "" }));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
	const save = async (e) => {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			await api("/settings/github", { method: "PUT", body: form });
			toast("GitHub connected");
			setForm({ ...form, token: "" });
			onSaved();
		} catch (err) {
			setError(err.message);
		}
		setBusy(false);
	};
	const remove = async () => {
		if (!confirm("Disconnect GitHub? Apps keep their links but can't push until it is connected again.")) return;
		await api("/settings/github", { method: "DELETE" });
		onSaved();
	};
	return html`<form class="card" onSubmit=${save}>
		<div class="card-head">
			<h2>
				${icon("github")} GitHub
				${github ? html`<span class="badge live"><span class="dot"></span>Connected as ${github.account}</span>` : html`<span class="badge">Not connected</span>`}
			</h2>
			<p>Apps push their code to repositories in your organization, from the GitHub button in the builder.</p>
		</div>
		<div class="card-body form-grid">
			<ol class="steps wide">
				<li>On GitHub, open Settings > Developer settings > Fine-grained tokens and generate a token with your organization as the resource owner.</li>
				<li>Give it access to all repositories (or the ones apps should use) with Contents: Read and write and Administration: Read and write, so it can create repositories.</li>
				<li>Paste it here with the organization's name.</li>
			</ol>
			<label class="field">
				<span>Organization</span>
				<input class="input mono" placeholder="acme" value=${form.owner} onInput=${set("owner")} required />
			</label>
			<label class="field">
				<span>Token ${github && html`<span class="hint">saved; leave empty to keep</span>`}</span>
				<input class="input mono" type="password" placeholder="github_pat_..." value=${form.token} onInput=${set("token")} required=${!github} />
			</label>
			<label class="field wide">
				<span>API URL <span class="hint">change only for GitHub Enterprise Server</span></span>
				<input class="input mono" value=${form.apiUrl} onInput=${set("apiUrl")} />
			</label>
			${error && html`<div class="error wide">${error}</div>`}
		</div>
		<div class="card-foot">
			${github && html`<button type="button" class="btn danger" onClick=${remove}>Disconnect</button>`}
			<button class="btn primary" disabled=${busy}>${busy && html`<span class="spinner"></span>`} ${github ? "Save" : "Connect GitHub"}</button>
		</div>
	</form>`;
}

function Settings() {
	const [data, setData] = useState(null);
	const [error, setError] = useState("");
	const load = () => api("/settings").then(setData, (err) => setError(err.message));
	useEffect(() => {
		load();
	}, []);
	return html`<div class="page">
		<header class="page-head">
			<h1>Settings</h1>
			<p>How your organization signs in, and where apps keep their code.</p>
		</header>
		${error && html`<p class="error">${error}</p>`}
		${data === null
			? html`<div class="empty"><span class="spinner"></span></div>`
			: html`<div class="stack">
					<${SsoSettings} sso=${data.sso} publicUrl=${data.publicUrl} onSaved=${load} />
					<${GitHubSettings} github=${data.github} onSaved=${load} />
				</div>`}
	</div>`;
}

function App() {
	const [user, setUser] = useState(undefined);
	const [usage, setUsage] = useState(null);
	const route = useRoute();
	const refreshUsage = () => api("/me").then((data) => setUsage(data.usage), () => {});
	useEffect(() => {
		api("/me").then(
			(data) => {
				const next = new URLSearchParams(location.search).get("next");
				if (next) location.href = next;
				else {
					setUser(data.user);
					setUsage(data.usage);
				}
			},
			() => setUser(null),
		);
	}, []);
	const view = useMemo(() => {
		if (!user) return null;
		const project = /^\/p\/([0-9a-f-]+)/.exec(route);
		if (project) return html`<${Builder} id=${project[1]} />`;
		if (route.startsWith("/connections")) return html`<${Connections} user=${user} />`;
		if (route.startsWith("/team")) return html`<${Team} user=${user} onChange=${refreshUsage} />`;
		if (route.startsWith("/usage")) return html`<${UsagePage} />`;
		if (route.startsWith("/settings") && user.role === "admin") return html`<${Settings} />`;
		return html`<${Home} />`;
	}, [route, user]);
	// Spend changes as the agent works, so the sidebar meter refreshes on every navigation.
	useEffect(() => {
		if (user) refreshUsage();
	}, [route]);
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
				${link("#/usage", "Usage", "gauge")} ${user.role === "admin" && link("#/team", "Team", "users")}
				${user.role === "admin" && link("#/settings", "Settings", "settings")}
				<span class="spacer"></span>
				${usage &&
				html`<a class="usage-chip" href="#/usage" title="Your AI usage this month">
					<div class="row"><span class="grow">AI usage</span><span class="mono">${spendLabel(usage)}</span></div>
					<${Meter} spent=${usage.spentUsd} budget=${usage.budgetUsd} unlimited=${usage.unlimited} />
				</a>`}
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
