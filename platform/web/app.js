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

function Login({ onLogin }) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const submit = async (e) => {
		e.preventDefault();
		setError("");
		try {
			const next = new URLSearchParams(location.search).get("next") ?? undefined;
			const result = await api("/login", { method: "POST", body: { email, password, next } });
			if (result.next && result.next !== "/") location.href = result.next;
			else onLogin(result.user);
		} catch (err) {
			setError(err.message);
		}
	};
	return html`<div class="login">
		<div class="brand"><img src="/static/logo.svg" alt="" /> Agency</div>
		<form class="card" onSubmit=${submit}>
			<h2 style="margin-top:0">Sign in</h2>
			<label>Email</label>
			<input type="email" value=${email} onInput=${(e) => setEmail(e.target.value)} autocomplete="username" required />
			<label>Password</label>
			<input type="password" value=${password} onInput=${(e) => setPassword(e.target.value)} autocomplete="current-password" required />
			${error && html`<p class="error">${error}</p>`}
			<p><button class="primary" style="width:100%">Sign in</button></p>
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
	useEffect(() => {
		api("/projects").then(setProjects, (err) => setError(err.message));
	}, []);
	const create = async () => {
		if (!prompt.trim()) return;
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
		<div class="hero">
			<h1>What should we build?</h1>
			<p class="muted">Describe an app. Agency builds it on your organization's data and runs it live.</p>
			<div class="composer">
				<textarea
					placeholder="A dashboard of open deals from our CRM..."
					value=${prompt}
					onInput=${(e) => setPrompt(e.target.value)}
					onKeyDown=${(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && create()}
				></textarea>
				<div class="row">
					<input placeholder="App name (optional)" value=${name} onInput=${(e) => setName(e.target.value)} />
					<span class="grow"></span>
					<button class="primary" disabled=${busy || !prompt.trim()} onClick=${create}>${busy ? "Creating..." : "Build it"}</button>
				</div>
			</div>
			<div class="row-gap" style="justify-content:center;margin-top:12px">
				${IDEAS.map((idea) => html`<button class="badge" style="border:none" onClick=${() => setPrompt(idea)}>${idea}</button>`)}
			</div>
			${error && html`<p class="error">${error}</p>`}
		</div>
		<h3>Apps</h3>
		${projects === null
			? html`<p class="muted">Loading...</p>`
			: projects.length === 0
				? html`<p class="muted">No apps yet.</p>`
				: html`<div class="grid">
						${projects.map(
							(p) => html`<a class="card project-card" href=${`#/p/${p.id}`}>
								<strong>${p.name}</strong>
								<div class="muted" style="font-size:12.5px">${p.slug}.${location.hostname}</div>
								<div style="margin-top:8px">
									${p.published ? html`<span class="badge live">Live v${p.published}</span>` : html`<span class="badge">Draft</span>`}
									${p.agentRunning && html` <span class="badge">Building</span>`}
								</div>
							</a>`,
						)}
					</div>`}
	</div>`;
}

function Builder({ id }) {
	const [project, setProject] = useState(null);
	const [items, setItems] = useState([]);
	const [running, setRunning] = useState(false);
	const [input, setInput] = useState("");
	const [error, setError] = useState("");
	const [panel, setPanel] = useState(null);
	const [previewKey, setPreviewKey] = useState(0);
	const scroller = useRef(null);

	const loadProject = () => api(`/projects/${id}`).then(setProject, (err) => setError(err.message));

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

	if (!project) return html`<div class="page">${error ? html`<p class="error">${error}</p>` : html`<p class="muted">Loading...</p>`}</div>`;

	return html`<div class="builder">
		<section class="chat">
			<div class="chat-header">
				<a href="#/" title="All apps">←</a>
				<h2>${project.name}</h2>
				${running && html`<span class="badge">Working</span>`}
			</div>
			<div class="messages" ref=${scroller}>
				${items.length === 0 && html`<p class="muted">Describe what to build or change. The agent edits the code and the preview updates.</p>`}
				${items.map((item) =>
					item.kind === "user"
						? html`<div class="msg-user">${item.text}</div>`
						: html`<div>
								${item.thinking && !item.text && item.tools.length === 0 && html`<div class="thinking">Thinking...</div>`}
								${item.text && html`<div class="msg-assistant">${item.text}</div>`}
								${item.tools.length > 0 &&
								html`<div class="tools">${item.tools.map((t) => html`<div class=${`tool ${t.status}`} title=${t.label}>${t.label}</div>`)}</div>`}
								${item.error && html`<div class="msg-error">${item.error}</div>`}
							</div>`,
				)}
			</div>
			<div class="chat-input">
				${error && html`<div class="error">${error}</div>`}
				<textarea
					placeholder=${running ? "Add an instruction for after this step..." : "Ask for a change..."}
					value=${input}
					onInput=${(e) => setInput(e.target.value)}
					onKeyDown=${(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							send();
						}
					}}
				></textarea>
				<div class="row">
					${running && html`<button onClick=${() => api(`/projects/${id}/abort`, { method: "POST" })}>Stop</button>`}
					<button class="primary" disabled=${!input.trim()} onClick=${send}>Send</button>
				</div>
			</div>
		</section>
		<section class="preview">
			<div class="toolbar">
				<button title="Reload preview" onClick=${() => setPreviewKey((k) => k + 1)}>↻</button>
				<span class="url">${project.previewUrl}</span>
				<button onClick=${() => setPanel(panel === "versions" ? null : "versions")}>Versions</button>
				<button onClick=${() => setPanel(panel === "logs" ? null : "logs")}>Logs</button>
				<a href=${project.previewUrl} target="_blank" rel="noopener"><button>Open</button></a>
				<button class="primary" onClick=${() => setPanel("publish")}>${project.published ? `Live v${project.published}` : "Publish"}</button>
			</div>
			${panel === "versions" && html`<${VersionsPanel} id=${id} running=${running} onRestored=${() => setPreviewKey((k) => k + 1)} />`}
			${panel === "logs" && html`<${LogsPanel} id=${id} />`}
			${panel === "publish" && html`<${PublishPanel} project=${project} running=${running} onChange=${loadProject} onClose=${() => setPanel(null)} />`}
			<iframe key=${previewKey} src=${project.previewUrl} title="App preview"></iframe>
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
			load();
			onRestored();
		} catch (err) {
			setError(err.message);
		}
	};
	return html`<div class="panel">
		<strong>Versions</strong>
		${error && html`<p class="error">${error}</p>`}
		<div class="list">
			${(versions ?? []).map(
				(v, i) => html`<div class="list-row">
					<code>${v.commit}</code>
					<span class="grow">${v.subject}</span>
					<span class="muted">${new Date(v.date).toLocaleString()}</span>
					${i > 0 && html`<button disabled=${running} onClick=${() => restore(v.commit)}>Restore</button>`}
				</div>`,
			)}
		</div>
	</div>`;
}

function LogsPanel({ id }) {
	const [logs, setLogs] = useState("Loading...");
	useEffect(() => {
		const load = () => api(`/projects/${id}/logs`).then(setLogs, (err) => setLogs(err.message));
		load();
		const timer = setInterval(load, 4000);
		return () => clearInterval(timer);
	}, [id]);
	return html`<div class="panel"><strong>Dev server log</strong><pre>${logs}</pre></div>`;
}

function PublishPanel({ project, running, onChange, onClose }) {
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
				if (event === "done") setLog((lines) => [...lines, `Published v${data.version}`]);
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
	return html`<div class="panel">
		<div class="row-gap">
			<strong class="grow" style="flex:1">Publish</strong>
			<button onClick=${onClose}>Close</button>
		</div>
		<p>
			Publishes to <a href=${project.appUrl} target="_blank" rel="noopener">${project.appUrl}</a>. Only signed-in team members can open
			it.
		</p>
		<div class="row-gap">
			<button class="primary" disabled=${busy || running} onClick=${run}>${busy ? "Publishing..." : "Publish current version"}</button>
			${project.published && html`<button class="danger" onClick=${() => act("unpublish")}>Unpublish</button>`}
		</div>
		${log.length > 0 && html`<pre style="margin-top:8px">${log.join("\n")}</pre>`}
		${error && html`<pre class="error" style="margin-top:8px">${error}</pre>`}
		${deployments.length > 0 &&
		html`<div class="list" style="margin-top:8px">
			${deployments.map(
				(d) => html`<div class="list-row">
					<strong>v${d.version}</strong>
					<code>${d.git_commit}</code>
					<span class="grow muted">${new Date(d.created_at).toLocaleString()}</span>
					${d.active ? html`<span class="badge live">Live</span>` : html`<button onClick=${() => act("rollback", { version: d.version })}>Roll back</button>`}
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
			setForm({ name: "", description: "", target: "", extra: "", allowWrite: false });
			load();
		} catch (err) {
			setError(err.message);
		}
	};
	const test = async (name) => {
		setResults({ ...results, [name]: "Testing..." });
		const result = await api(`/connections/${name}/test`, { method: "POST" });
		setResults((r) => ({ ...r, [name]: result.message }));
	};
	const remove = async (id) => {
		if (!confirm("Remove this connection? Apps using it will stop getting data.")) return;
		await api(`/connections/${id}`, { method: "DELETE" });
		load();
	};
	return html`<div class="page">
		<h1>Connections</h1>
		<p class="muted">
			Organization data the agent can build on. Credentials stay in the platform; apps reach data through the gateway with their own
			token.
		</p>
		<div class="card">
			${connections === null
				? html`<p class="muted">Loading...</p>`
				: connections.length === 0
					? html`<p class="muted">No connections yet.</p>`
					: html`<div class="list">
							${connections.map(
								(c) => html`<div class="list-row">
									<div class="grow">
										<strong>${c.name}</strong> <span class="badge">${c.kind}</span>
										${c.allowWrite ? html` <span class="badge">writes allowed</span>` : html` <span class="badge">read-only</span>`}
										<div class="muted">${c.description}</div>
										${results[c.name] && html`<div style="font-size:12.5px">${results[c.name]}</div>`}
									</div>
									<button onClick=${() => test(c.name)}>Test</button>
									${user.role === "admin" && html`<button class="danger" onClick=${() => remove(c.id)}>Remove</button>`}
								</div>`,
							)}
						</div>`}
		</div>
		${user.role === "admin" &&
		html`<form class="card" style="margin-top:16px" onSubmit=${add}>
			<h3 style="margin-top:0">Add a connection</h3>
			<div class="two-col">
				<div>
					<label>Type</label>
					<select value=${type} onChange=${(e) => setType(e.target.value)}>
						${Object.entries(CONNECTION_TYPES).map(([key, value]) => html`<option value=${key}>${value.label}</option>`)}
					</select>
				</div>
				<div>
					<label>Name (used in code)</label>
					<input placeholder="crm" value=${form.name} onInput=${set("name")} required pattern="[a-z][a-z0-9_-]*" />
				</div>
			</div>
			<label>Description</label>
			<input placeholder="Sales CRM: deals, accounts, contacts" value=${form.description} onInput=${set("description")} />
			<label>${spec.kind === "postgres" ? "Connection string" : spec.kind === "mcp_http" ? "MCP URL" : "Command"}</label>
			<input placeholder=${spec.hint} value=${form.target} onInput=${set("target")} required />
			${spec.kind === "mcp_http" &&
			html`<label>Headers (one per line)</label>
				<textarea rows="2" placeholder="Authorization: Bearer ..." value=${form.extra} onInput=${set("extra")}></textarea>`}
			${spec.kind === "mcp_stdio" &&
			html`<label>Environment (KEY=value per line)</label>
				<textarea rows="2" placeholder="API_TOKEN=..." value=${form.extra} onInput=${set("extra")}></textarea>`}
			<label style="font-weight:400"><input type="checkbox" style="width:auto" checked=${form.allowWrite} onChange=${set("allowWrite")} /> Allow apps to write</label>
			${error && html`<p class="error">${error}</p>`}
			<p><button class="primary">Add connection</button></p>
		</form>`}
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
			setForm({ email: "", name: "", password: "", role: "member" });
			load();
		} catch (err) {
			setError(err.message);
		}
	};
	if (user.role !== "admin") return html`<div class="page"><p class="muted">Only admins manage the team.</p></div>`;
	return html`<div class="page">
		<h1>Team</h1>
		<div class="card">
			<div class="list">
				${users.map(
					(u) => html`<div class="list-row">
						<div class="grow"><strong>${u.name || u.email}</strong> <span class="muted">${u.email}</span></div>
						<span class="badge">${u.role}</span>
						${u.id !== user.id &&
						html`<button class="danger" onClick=${async () => {
							await api(`/users/${u.id}`, { method: "DELETE" });
							load();
						}}>Remove</button>`}
					</div>`,
				)}
			</div>
		</div>
		<form class="card" style="margin-top:16px" onSubmit=${add}>
			<h3 style="margin-top:0">Add a member</h3>
			<div class="two-col">
				<div><label>Email</label><input type="email" value=${form.email} onInput=${set("email")} required /></div>
				<div><label>Name</label><input value=${form.name} onInput=${set("name")} /></div>
				<div><label>Temporary password</label><input type="password" minlength="10" value=${form.password} onInput=${set("password")} required /></div>
				<div>
					<label>Role</label>
					<select value=${form.role} onChange=${set("role")}><option value="member">Member</option><option value="admin">Admin</option></select>
				</div>
			</div>
			${error && html`<p class="error">${error}</p>`}
			<p><button class="primary">Add member</button></p>
		</form>
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
	if (user === null) return html`<${Login} onLogin=${setUser} />`;
	const link = (href, label) => html`<a href=${href} class=${route === href.slice(1) || (href !== "#/" && route.startsWith(href.slice(1))) ? "active" : ""}>${label}</a>`;
	return html`<div class="app">
		<nav class="nav">
			<div class="brand"><img src="/static/logo.svg" alt="" /> Agency</div>
			${link("#/", "Apps")} ${link("#/connections", "Connections")} ${user.role === "admin" && link("#/team", "Team")}
			<span class="spacer"></span>
			<span class="muted" style="padding:0 10px;font-size:12.5px">${user.email}</span>
			<a
				href="#"
				onClick=${async (e) => {
					e.preventDefault();
					await api("/logout", { method: "POST" });
					location.reload();
				}}
				>Sign out</a
			>
		</nav>
		<main class="main">${view}</main>
	</div>`;
}

render(html`<${App} />`, document.getElementById("root"));
