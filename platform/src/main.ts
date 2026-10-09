import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type AgentEvent, bridgeFor, dropBridge } from "./agent.ts";
import {
	type AppEnv,
	createUser,
	ensureAdmin,
	login,
	logout,
	requireAdmin,
	requireUser,
	safeNext,
	type User,
	verifyForwardAuth,
} from "./auth.ts";
import { appHost, config, previewHost } from "./config.ts";
import {
	type ConnectionConfig,
	type ConnectionKind,
	createConnection,
	deleteConnection,
	listConnections,
	testConnection,
} from "./connectors.ts";
import { migrate, query } from "./db.ts";
import { containerState, execIn } from "./docker.ts";
import { gateway, mcpApp } from "./gateway.ts";
import {
	appContainerName,
	createProject,
	deleteProject,
	ensureSandbox,
	getProject,
	listProjects,
	type Project,
	sandboxName,
} from "./projects.ts";
import { listDeployments, publish, rollback, unpublish } from "./publish.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function projectView(project: Project) {
	const [sandbox, app, deployments] = await Promise.all([
		containerState(sandboxName(project)),
		containerState(appContainerName(project)),
		listDeployments(project),
	]);
	const active = deployments.find((d) => d.active);
	return {
		id: project.id,
		slug: project.slug,
		name: project.name,
		createdAt: project.created_at,
		previewUrl: `${config.scheme}://${previewHost(project.slug)}`,
		appUrl: `${config.scheme}://${appHost(project.slug)}`,
		sandbox,
		published: app === "running" && active ? active.version : null,
		agentRunning: bridgeFor(project).running,
	};
}

const app = new Hono<AppEnv>();

app.onError((error, c) => {
	console.error(error);
	return c.json({ error: errorMessage(error) }, 500);
});

app.get("/healthz", (c) => c.text("ok"));
app.get("/auth/verify", (c) => verifyForwardAuth(c));
app.route("/gateway", gateway);
app.route("/mcp", mcpApp);

// ---------------------------------------------------------------------------
// Session

app.post("/api/login", async (c) => {
	const body = await c.req.json<{ email: string; password: string; next?: string }>();
	const user = await login(c, body.email ?? "", body.password ?? "");
	if (!user) return c.json({ error: "Wrong email or password" }, 401);
	return c.json({ user, next: safeNext(body.next) });
});

app.post("/api/logout", async (c) => {
	await logout(c);
	return c.json({ ok: true });
});

const api = new Hono<AppEnv>();
api.use("*", requireUser);

api.get("/me", (c) => c.json({ user: c.get("user"), baseDomain: config.baseDomain }));

// ---------------------------------------------------------------------------
// Projects

async function loadProject(id: string): Promise<Project> {
	const project = await getProject(id);
	if (!project) throw new Error("Project not found");
	return project;
}

function canManage(user: User, project: Project): boolean {
	return user.role === "admin" || user.id === project.owner_id;
}

api.get("/projects", async (c) => {
	const projects = await listProjects();
	return c.json(await Promise.all(projects.map(projectView)));
});

api.post("/projects", async (c) => {
	const body = await c.req.json<{ name: string; prompt?: string }>();
	const name = (body.name ?? "").trim();
	if (!name) return c.json({ error: "Name is required" }, 400);
	const project = await createProject(name, c.get("user").id);
	if (body.prompt?.trim()) {
		bridgeFor(project)
			.prompt(body.prompt.trim())
			.catch((error) => console.error(`[agent ${project.slug}] first prompt failed: ${errorMessage(error)}`));
	}
	return c.json(await projectView(project), 201);
});

api.get("/projects/:id", async (c) => c.json(await projectView(await loadProject(c.req.param("id")))));

api.delete("/projects/:id", async (c) => {
	const project = await loadProject(c.req.param("id"));
	if (!canManage(c.get("user"), project)) return c.json({ error: "Only the owner or an admin can delete" }, 403);
	dropBridge(project.id);
	await deleteProject(project);
	return c.json({ ok: true });
});

api.get("/projects/:id/messages", async (c) => {
	const project = await loadProject(c.req.param("id"));
	return c.json({ messages: await bridgeFor(project).messages(), running: bridgeFor(project).running });
});

api.post("/projects/:id/prompt", async (c) => {
	const project = await loadProject(c.req.param("id"));
	const body = await c.req.json<{ message: string }>();
	if (!body.message?.trim()) return c.json({ error: "Message is empty" }, 400);
	return c.json(await bridgeFor(project).prompt(body.message.trim()));
});

api.post("/projects/:id/abort", async (c) => {
	const project = await loadProject(c.req.param("id"));
	await bridgeFor(project).abort();
	return c.json({ ok: true });
});

api.get("/projects/:id/events", async (c) => {
	const project = await loadProject(c.req.param("id"));
	const bridge = bridgeFor(project);
	return streamSSE(c, async (stream) => {
		const queue: AgentEvent[] = [];
		let wake: (() => void) | undefined;
		const unsubscribe = bridge.subscribe((event) => {
			queue.push(event);
			wake?.();
		});
		stream.onAbort(unsubscribe);
		await stream.writeSSE({ event: "hello", data: JSON.stringify({ running: bridge.running }) });
		while (!stream.aborted) {
			if (queue.length === 0) {
				await new Promise<void>((resolve) => {
					wake = resolve;
					setTimeout(resolve, 20_000);
				});
				wake = undefined;
				if (queue.length === 0) {
					await stream.writeSSE({ event: "ping", data: "{}" });
					continue;
				}
			}
			const event = queue.shift()!;
			await stream.writeSSE({ data: JSON.stringify(event) });
		}
		unsubscribe();
	});
});

api.post("/projects/:id/restart", async (c) => {
	const project = await loadProject(c.req.param("id"));
	dropBridge(project.id);
	await ensureSandbox(project);
	await execIn(sandboxName(project), "pkill -f 'next dev' || true");
	return c.json({ ok: true });
});

api.get("/projects/:id/logs", async (c) => {
	const project = await loadProject(c.req.param("id"));
	const result = await execIn(sandboxName(project), "tail -n 200 /tmp/dev.log 2>/dev/null || true");
	return c.text(result.stdout);
});

api.get("/projects/:id/versions", async (c) => {
	const project = await loadProject(c.req.param("id"));
	const result = await execIn(sandboxName(project), "git log -n 50 --format='%h%x09%cI%x09%s'");
	const versions = result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [commit, date, ...subject] = line.split("\t");
			return { commit, date, subject: subject.join("\t") };
		});
	return c.json(versions);
});

api.post("/projects/:id/restore", async (c) => {
	const project = await loadProject(c.req.param("id"));
	const { commit } = await c.req.json<{ commit: string }>();
	if (!/^[0-9a-f]{4,40}$/.test(commit ?? "")) return c.json({ error: "Invalid version" }, 400);
	if (bridgeFor(project).running) return c.json({ error: "Wait for the agent to finish first" }, 409);
	// Restores the tree of an earlier commit as a new commit, so history is kept.
	const script = `set -e
git checkout ${commit} -- .
git diff --name-only --diff-filter=A ${commit} HEAD | xargs -r git rm -q --
git add -A
git diff --cached --quiet || git commit -q -m "Restore ${commit}"
git rev-parse --short HEAD`;
	const result = await execIn(sandboxName(project), script);
	if (result.code !== 0) return c.json({ error: result.stderr || result.stdout }, 400);
	return c.json({ commit: result.stdout.trim() });
});

api.get("/projects/:id/deployments", async (c) => {
	const project = await loadProject(c.req.param("id"));
	return c.json(await listDeployments(project));
});

api.post("/projects/:id/publish", async (c) => {
	const project = await loadProject(c.req.param("id"));
	const user = c.get("user");
	return streamSSE(c, async (stream) => {
		try {
			const deployment = await publish(project, user.id, (line) => {
				void stream.writeSSE({ event: "log", data: JSON.stringify(line) });
			});
			await stream.writeSSE({ event: "done", data: JSON.stringify(deployment) });
		} catch (error) {
			await stream.writeSSE({ event: "failed", data: JSON.stringify(errorMessage(error)) });
		}
	});
});

api.post("/projects/:id/rollback", async (c) => {
	const project = await loadProject(c.req.param("id"));
	const { version } = await c.req.json<{ version: number }>();
	return c.json(await rollback(project, Number(version)));
});

api.post("/projects/:id/unpublish", async (c) => {
	const project = await loadProject(c.req.param("id"));
	await unpublish(project);
	return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Connections

api.get("/connections", async (c) => c.json(await listConnections()));

api.post("/connections", requireAdmin, async (c) => {
	const body = await c.req.json<{
		name: string;
		kind: ConnectionKind;
		description?: string;
		allowWrite?: boolean;
		config: ConnectionConfig;
	}>();
	if (!["postgres", "mcp_http", "mcp_stdio"].includes(body.kind)) return c.json({ error: "Unknown kind" }, 400);
	try {
		const connection = await createConnection({
			name: body.name,
			kind: body.kind,
			description: body.description ?? "",
			allowWrite: Boolean(body.allowWrite),
			config: body.config,
		});
		return c.json(connection, 201);
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 400);
	}
});

api.post("/connections/:name/test", async (c) => {
	try {
		return c.json({ ok: true, message: await testConnection(c.req.param("name")) });
	} catch (error) {
		return c.json({ ok: false, message: errorMessage(error) });
	}
});

api.delete("/connections/:id", requireAdmin, async (c) => {
	await deleteConnection(c.req.param("id"));
	return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Team

api.get("/users", requireAdmin, async (c) =>
	c.json(await query("select id, email, name, role, created_at from users order by created_at")),
);

api.post("/users", requireAdmin, async (c) => {
	const body = await c.req.json<{ email: string; name?: string; password: string; role?: User["role"] }>();
	if (!body.email || !body.password || body.password.length < 10) {
		return c.json({ error: "Email and a password of at least 10 characters are required" }, 400);
	}
	try {
		return c.json(await createUser(body.email, body.name ?? "", body.password, body.role === "admin" ? "admin" : "member"), 201);
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 400);
	}
});

api.delete("/users/:id", requireAdmin, async (c) => {
	if (c.req.param("id") === c.get("user").id) return c.json({ error: "You cannot remove yourself" }, 400);
	await query("delete from users where id = $1", [c.req.param("id")]);
	return c.json({ ok: true });
});

app.route("/api", api);

// ---------------------------------------------------------------------------
// Web UI: static files plus Preact and htm served from node_modules (no build step).

app.get("/vendor/preact/*", serveStatic({ root: config.nodeModules, rewriteRequestPath: (p) => p.replace("/vendor/preact", "preact/dist") }));
app.get(
	"/vendor/hooks/*",
	serveStatic({ root: config.nodeModules, rewriteRequestPath: (p) => p.replace("/vendor/hooks", "preact/hooks/dist") }),
);
app.get("/vendor/htm/*", serveStatic({ root: config.nodeModules, rewriteRequestPath: (p) => p.replace("/vendor/htm", "htm/dist") }));
app.get("/static/*", serveStatic({ root: config.webRoot, rewriteRequestPath: (p) => p.replace("/static", "") }));
const indexHtml = readFileSync(`${config.webRoot}index.html`, "utf8");
app.get("*", (c) => c.html(indexHtml));

await migrate();
await ensureAdmin();
serve({ fetch: app.fetch, port: config.port }, (info) => {
	console.log(`agency platform listening on :${info.port} for ${config.publicUrl}`);
});
