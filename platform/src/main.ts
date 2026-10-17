import { existsSync, readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { compress } from "hono/compress";
import { streamSSE } from "hono/streaming";
import { type AgentEvent, bridgeFor, dropBridge } from "./agent.ts";
import { AccessError, assertRole, atLeast, getSharing, type ProjectRole, projectRole, setMember, setTeamAccess, visibleProjects } from "./access.ts";
import { closeDataPools, DataError, deleteRow, insertRow, listTables, readRows, runSql, updateRow } from "./appdata.ts";
import {
	type AppEnv,
	createUser,
	currentUser,
	ensureAdmin,
	login,
	LoginError,
	loginWithSso,
	logout,
	requireAdmin,
	requireUser,
	safeNext,
	type User,
	verifyForwardAuth,
} from "./auth.ts";
import { appHost, config, previewHost } from "./config.ts";
import {
	CONNECTION_KINDS,
	type ConnectionConfig,
	type ConnectionKind,
	createConnection,
	deleteConnection,
	finishSignIn,
	listConnections,
	setConnectionProjects,
	signOut,
	startSignIn,
	testConnection,
} from "./connectors.ts";
import { migrate, query } from "./db.ts";
import { containerState, execIn } from "./docker.ts";
import { FileError, listFiles, readFile, writeFile } from "./files.ts";
import { gateway, mcpApp } from "./gateway.ts";
import {
	appContainerName,
	createProject,
	type DataEnv,
	deleteProject,
	ensureSandbox,
	getProject,
	listProjects,
	type Project,
	sandboxName,
	sandboxOutdated,
} from "./projects.ts";
import {
	autoPush,
	appManifestPage,
	finishAppInstall,
	finishAppManifest,
	getGitHub,
	GitHubError,
	gitHubView,
	linkRepository,
	projectGitHub,
	pushToGitHub,
	removeGitHub,
	saveGitHub,
	setAutoPush,
	unlinkRepository,
} from "./github.ts";
import { listDeployments, publish, rollback, unpublish } from "./publish.ts";
import { saveSso, signInOptions, SsoError, ssoFinish, ssoStartUrl, ssoView } from "./sso.ts";
import { assertBudget, BudgetError, listUsersWithUsage, parseBudget, setBudget, usageDetail, usageFor } from "./usage.ts";

class NotFoundError extends Error {}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function projectView(project: Project, role: ProjectRole | null) {
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
		liveDatabase: Boolean(project.live_db_name),
		agentRunning: bridgeFor(project).running,
		role,
		teamAccess: project.team_access,
	};
}

const app = new Hono<AppEnv>();

app.onError((error, c) => {
	// 402: the user's monthly agent budget is used up.
	if (error instanceof BudgetError) return c.json({ error: error.message, code: "budget" }, 402);
	if (error instanceof DataError) return c.json({ error: error.message }, 400);
	if (error instanceof AccessError) return c.json({ error: error.message }, 403);
	if (error instanceof GitHubError || error instanceof SsoError) return c.json({ error: error.message }, 400);
	if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
	console.error(error);
	return c.json({ error: errorMessage(error) }, 500);
});

app.get("/healthz", (c) => c.text("ok"));
app.get("/auth/verify", (c) => verifyForwardAuth(c));
app.route("/gateway", gateway);
app.route("/mcp", mcpApp);

// Providers send the admin back here after they approve a connection's access.
app.get("/oauth/callback", async (c) => {
	const back = (params: Record<string, string>) => c.redirect(`/#/connections?${new URLSearchParams(params)}`, 302);
	const user = await currentUser(c);
	if (!user || user.role !== "admin") return back({ oauth_error: "Sign in as an admin, then click Connect again." });
	const error = c.req.query("error_description") ?? c.req.query("error");
	if (error) return back({ oauth_error: error });
	try {
		const name = await finishSignIn(c.req.query("state") ?? "", c.req.query("code") ?? "", user.id);
		return back({ connected: name });
	} catch (err) {
		return back({ oauth_error: errorMessage(err) });
	}
});

// One-click GitHub: create the app from a manifest on GitHub, then install it on the organization.
const settingsBack = (c: Context<AppEnv>, params: Record<string, string>) => c.redirect(`/#/settings?${new URLSearchParams(params)}`, 302);

app.get("/github/app/start", async (c) => {
	const user = await currentUser(c);
	if (!user || user.role !== "admin") return settingsBack(c, { github_error: "Only admins can connect GitHub" });
	try {
		return c.html(appManifestPage({ owner: c.req.query("owner"), webUrl: c.req.query("webUrl") }));
	} catch (error) {
		return settingsBack(c, { github_error: errorMessage(error) });
	}
});

app.get("/github/app/created", async (c) => {
	const user = await currentUser(c);
	if (!user || user.role !== "admin") return settingsBack(c, { github_error: "Sign in as an admin, then click Connect GitHub again." });
	try {
		return c.redirect(await finishAppManifest(c.req.query("state") ?? "", c.req.query("code") ?? ""), 302);
	} catch (error) {
		return settingsBack(c, { github_error: errorMessage(error) });
	}
});

app.get("/github/app/installed", async (c) => {
	const user = await currentUser(c);
	if (!user || user.role !== "admin") return settingsBack(c, { github_error: "Sign in as an admin to finish connecting GitHub." });
	// An organization member who isn't an owner can only request the install; an owner approves it on GitHub.
	if (c.req.query("setup_action") === "request") return settingsBack(c, { github_error: "GitHub sent the install to an organization owner to approve. Come back here once they do." });
	try {
		await finishAppInstall(Number(c.req.query("installation_id")));
		return settingsBack(c, { github: "connected" });
	} catch (error) {
		return settingsBack(c, { github_error: errorMessage(error) });
	}
});

// ---------------------------------------------------------------------------
// Session

app.get("/api/sign-in-options", async (c) => c.json(await signInOptions()));

// Single sign-on: the identity provider sends people back to /auth/sso/callback.
app.get("/auth/sso/start", async (c) => {
	try {
		return c.redirect(await ssoStartUrl(safeNext(c.req.query("next"))), 302);
	} catch (error) {
		return c.redirect(`/?sso_error=${encodeURIComponent(errorMessage(error))}`, 302);
	}
});

app.get("/auth/sso/callback", async (c) => {
	const fail = (message: string) => c.redirect(`/?sso_error=${encodeURIComponent(message)}`, 302);
	const error = c.req.query("error_description") ?? c.req.query("error");
	if (error) return fail(error);
	try {
		const { email, name, next } = await ssoFinish(c.req.query("state") ?? "", c.req.query("code") ?? "");
		await loginWithSso(c, email, name);
		return c.redirect(next, 302);
	} catch (err) {
		return fail(errorMessage(err));
	}
});

app.post("/api/login", async (c) => {
	const body = await c.req.json<{ email: string; password: string; next?: string }>();
	let user: User | undefined;
	try {
		user = await login(c, body.email ?? "", body.password ?? "");
	} catch (error) {
		if (error instanceof LoginError) return c.json({ error: error.message }, 403);
		throw error;
	}
	if (!user) return c.json({ error: "Wrong email or password" }, 401);
	return c.json({ user, next: safeNext(body.next) });
});

app.post("/api/logout", async (c) => {
	await logout(c);
	return c.json({ ok: true });
});

const api = new Hono<AppEnv>();
api.use("*", requireUser);

api.get("/me", async (c) =>
	c.json({ user: c.get("user"), baseDomain: config.baseDomain, usage: await usageFor(c.get("user").id) }),
);

api.get("/usage", async (c) => c.json(await usageDetail(c.get("user").id)));

// ---------------------------------------------------------------------------
// Projects

type ProjectContext = { get(key: "user"): User; req: { param(name: "id"): string } };

/** Loads the route's project and checks the signed-in member has at least the given role on it. */
async function projectFor(c: ProjectContext, needed: ProjectRole): Promise<{ project: Project; role: ProjectRole }> {
	const project = await getProject(c.req.param("id"));
	if (!project) throw new NotFoundError("App not found");
	const role = await assertRole(c.get("user"), project, needed);
	return { project, role };
}

api.get("/projects", async (c) => {
	const user = c.get("user");
	const projects = await visibleProjects(user);
	return c.json(await Promise.all(projects.map(async (p) => projectView(p, await projectRole(user, p)))));
});

api.post("/projects", async (c) => {
	const body = await c.req.json<{ name: string; prompt?: string }>();
	const name = (body.name ?? "").trim();
	if (!name) return c.json({ error: "Name is required" }, 400);
	const user = c.get("user");
	if (body.prompt?.trim()) await assertBudget(user.id);
	const project = await createProject(name, user.id);
	if (body.prompt?.trim()) {
		bridgeFor(project)
			.prompt(body.prompt.trim(), user.id)
			.catch((error) => console.error(`[agent ${project.slug}] first prompt failed: ${errorMessage(error)}`));
	}
	return c.json(await projectView(project, "owner"), 201);
});

api.get("/projects/:id", async (c) => {
	const { project, role } = await projectFor(c, "viewer");
	return c.json(await projectView(project, role));
});

// ---------------------------------------------------------------------------
// Sharing: who besides the owner and admins can view or change an app

api.get("/projects/:id/sharing", async (c) => {
	const { project, role } = await projectFor(c, "viewer");
	return c.json({ ...(await getSharing(project)), canManage: role === "owner" });
});

api.put("/projects/:id/sharing", async (c) => {
	const { project } = await projectFor(c, "owner");
	const body = await c.req.json<{ teamAccess?: string; member?: { userId: string; role: string | null } }>();
	if (body.teamAccess !== undefined) await setTeamAccess(project, body.teamAccess);
	if (body.member) await setMember(project, String(body.member.userId ?? ""), body.member.role ?? null);
	const updated = (await getProject(project.id))!;
	return c.json({ ...(await getSharing(updated)), canManage: true });
});

/** Everyone on the team, for picking people to share an app with. */
api.get("/people", async (c) =>
	c.json(await query<{ id: string; email: string; name: string }>("select id, email, name from users order by email")),
);

api.delete("/projects/:id", async (c) => {
	const { project } = await projectFor(c, "owner");
	dropBridge(project.id);
	closeDataPools(project);
	await deleteProject(project);
	return c.json({ ok: true });
});

api.get("/projects/:id/messages", async (c) => {
	const { project } = await projectFor(c, "viewer");
	// Opening the builder moves an idle app onto the current sandbox image (its files and data stay).
	if (!bridgeFor(project).running && (await sandboxOutdated(project))) {
		dropBridge(project.id);
		await ensureSandbox(project, { upgrade: true });
	}
	return c.json({ messages: await bridgeFor(project).messages(), running: bridgeFor(project).running });
});

api.post("/projects/:id/prompt", async (c) => {
	const { project } = await projectFor(c, "editor");
	const body = await c.req.json<{ message: string }>();
	if (!body.message?.trim()) return c.json({ error: "Message is empty" }, 400);
	await assertBudget(c.get("user").id);
	return c.json(await bridgeFor(project).prompt(body.message.trim(), c.get("user").id));
});

api.post("/projects/:id/abort", async (c) => {
	const { project } = await projectFor(c, "editor");
	await bridgeFor(project).abort();
	return c.json({ ok: true });
});

api.get("/projects/:id/events", async (c) => {
	const { project } = await projectFor(c, "viewer");
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
	const { project } = await projectFor(c, "editor");
	dropBridge(project.id);
	await ensureSandbox(project);
	await execIn(sandboxName(project), "pkill -f 'next dev' || true");
	return c.json({ ok: true });
});

api.get("/projects/:id/logs", async (c) => {
	const { project } = await projectFor(c, "viewer");
	const result = await execIn(sandboxName(project), "tail -n 200 /tmp/dev.log 2>/dev/null || true");
	return c.text(result.stdout);
});

api.get("/projects/:id/versions", async (c) => {
	const { project } = await projectFor(c, "viewer");
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
	const { project } = await projectFor(c, "editor");
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
	autoPush(project.id);
	return c.json({ commit: result.stdout.trim() });
});

// ---------------------------------------------------------------------------
// Code view: the app's source files inside its sandbox

api.get("/projects/:id/files", async (c) => {
	const { project } = await projectFor(c, "viewer");
	await ensureSandbox(project);
	return c.json({ files: await listFiles(project) });
});

api.get("/projects/:id/file", async (c) => {
	const { project } = await projectFor(c, "viewer");
	try {
		return c.json(await readFile(project, c.req.query("path") ?? ""));
	} catch (error) {
		if (error instanceof FileError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

api.put("/projects/:id/file", async (c) => {
	const { project } = await projectFor(c, "editor");
	const body = await c.req.json<{ path: string; content: string }>();
	if (typeof body.content !== "string") return c.json({ error: "Content is required" }, 400);
	// The agent commits its whole tree when it settles; a save in the middle of a run would get mixed into it.
	if (bridgeFor(project).running) return c.json({ error: "The agent is working. Save again when it finishes." }, 409);
	try {
		const saved = await writeFile(project, body.path, body.content);
		autoPush(project.id);
		return c.json(saved);
	} catch (error) {
		if (error instanceof FileError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

// ---------------------------------------------------------------------------
// Data view: the app's own database, preview or live. Anyone can edit the preview's data;
// changing live data takes the app's owner or an admin, others can only read it.

function dataEnv(value: string | undefined): DataEnv {
	return value === "live" ? "live" : "preview";
}

async function dataAccess(c: ProjectContext & { req: { query(name: string): string | undefined } }) {
	const { project, role } = await projectFor(c, "viewer");
	const env = dataEnv(c.req.query("env"));
	// Editors change preview data; live data takes the owner or an admin. Everyone else reads.
	const canWrite = env === "preview" ? atLeast(role, "editor") : role === "owner";
	return { project, env, canWrite };
}

api.get("/projects/:id/data/tables", async (c) => {
	const { project, env, canWrite } = await dataAccess(c);
	if (env === "live" && !project.live_db_name) return c.json({ tables: [], canWrite, missing: true });
	return c.json({ tables: await listTables(project, env), canWrite, missing: false });
});

api.get("/projects/:id/data/rows", async (c) => {
	const { project, env } = await dataAccess(c);
	const table = c.req.query("table") ?? "";
	return c.json(await readRows(project, env, table, Number(c.req.query("offset")), Number(c.req.query("limit"))));
});

api.post("/projects/:id/data/rows", async (c) => {
	const { project, env, canWrite } = await dataAccess(c);
	if (!canWrite) return c.json({ error: env === "live" ? "Only the app's owner or an admin can change live data" : "You can view this app's data but not change it" }, 403);
	const body = await c.req.json<{ table: string; values: Record<string, string | null> }>();
	await insertRow(project, env, body.table, body.values ?? {});
	return c.json({ ok: true });
});

api.patch("/projects/:id/data/rows", async (c) => {
	const { project, env, canWrite } = await dataAccess(c);
	if (!canWrite) return c.json({ error: env === "live" ? "Only the app's owner or an admin can change live data" : "You can view this app's data but not change it" }, 403);
	const body = await c.req.json<{ table: string; key: Record<string, unknown>; values: Record<string, string | null> }>();
	await updateRow(project, env, body.table, body.key ?? {}, body.values ?? {});
	return c.json({ ok: true });
});

api.delete("/projects/:id/data/rows", async (c) => {
	const { project, env, canWrite } = await dataAccess(c);
	if (!canWrite) return c.json({ error: env === "live" ? "Only the app's owner or an admin can change live data" : "You can view this app's data but not change it" }, 403);
	const body = await c.req.json<{ table: string; key: Record<string, unknown> }>();
	await deleteRow(project, env, body.table, body.key ?? {});
	return c.json({ ok: true });
});

api.post("/projects/:id/data/sql", async (c) => {
	const { project, env, canWrite } = await dataAccess(c);
	const body = await c.req.json<{ sql: string }>();
	return c.json(await runSql(project, env, String(body.sql ?? ""), !canWrite));
});

api.get("/projects/:id/deployments", async (c) => {
	const { project } = await projectFor(c, "viewer");
	return c.json(await listDeployments(project));
});

api.post("/projects/:id/publish", async (c) => {
	const { project } = await projectFor(c, "editor");
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
	const { project } = await projectFor(c, "editor");
	const { version } = await c.req.json<{ version: number }>();
	return c.json(await rollback(project, Number(version)));
});

api.post("/projects/:id/unpublish", async (c) => {
	const { project } = await projectFor(c, "editor");
	await unpublish(project);
	return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GitHub: push an app's code to the organization's GitHub

api.get("/projects/:id/github", async (c) => {
	const { project, role } = await projectFor(c, "viewer");
	return c.json({ ...projectGitHub(project, await getGitHub()), canLink: role === "owner", canPush: atLeast(role, "editor") });
});

api.post("/projects/:id/github/link", async (c) => {
	const { project } = await projectFor(c, "owner");
	const body = await c.req.json<{ create?: boolean; repo?: string; branch?: string; private?: boolean; autoPush?: boolean }>();
	await linkRepository(project, body);
	const linked = (await getProject(project.id))!;
	// A new link pushes right away, so the repository shows the app's code.
	const push = await pushToGitHub(linked).then(
		() => null,
		(error) => errorMessage(error),
	);
	return c.json({ ...projectGitHub((await getProject(project.id))!, await getGitHub()), pushError: push });
});

api.patch("/projects/:id/github", async (c) => {
	const { project } = await projectFor(c, "owner");
	const body = await c.req.json<{ autoPush?: boolean }>();
	await setAutoPush(project, Boolean(body.autoPush));
	return c.json(projectGitHub((await getProject(project.id))!, await getGitHub()));
});

api.delete("/projects/:id/github", async (c) => {
	const { project } = await projectFor(c, "owner");
	await unlinkRepository(project);
	return c.json(projectGitHub((await getProject(project.id))!, await getGitHub()));
});

api.post("/projects/:id/github/push", async (c) => {
	const { project } = await projectFor(c, "editor");
	if (bridgeFor(project).running) return c.json({ error: "Wait for the agent to finish, then push" }, 409);
	const body = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));
	return c.json(await pushToGitHub(project, { force: Boolean(body.force) }));
});

// ---------------------------------------------------------------------------
// Settings: single sign-on and GitHub (admins)

api.get("/settings", requireAdmin, async (c) => c.json({ sso: await ssoView(), github: await gitHubView(), publicUrl: config.publicUrl }));

api.put("/settings/sso", requireAdmin, async (c) => c.json(await saveSso(await c.req.json())));

api.put("/settings/github", requireAdmin, async (c) => c.json(await saveGitHub(await c.req.json())));

api.delete("/settings/github", requireAdmin, async (c) => {
	await removeGitHub();
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
	if (!CONNECTION_KINDS.includes(body.kind)) return c.json({ error: "Unknown kind" }, 400);
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

api.put("/connections/:id/projects", requireAdmin, async (c) => {
	const body = await c.req.json<{ allProjects?: boolean; projectIds?: string[] }>();
	const ids = Array.isArray(body.projectIds) ? body.projectIds.map(String) : [];
	return c.json(await setConnectionProjects(c.req.param("id"), body.allProjects !== false, ids));
});

api.post("/connections/:id/connect", requireAdmin, async (c) => {
	try {
		const url = await startSignIn(c.req.param("id"), c.get("user").id);
		return c.json({ url });
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 400);
	}
});

api.post("/connections/:id/disconnect", requireAdmin, async (c) => {
	await signOut(c.req.param("id"));
	return c.json({ ok: true });
});

api.delete("/connections/:id", requireAdmin, async (c) => {
	await deleteConnection(c.req.param("id"));
	return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Team

api.get("/users", requireAdmin, async (c) => c.json(await listUsersWithUsage()));

api.post("/users", requireAdmin, async (c) => {
	const body = await c.req.json<{
		email: string;
		name?: string;
		password: string;
		role?: User["role"];
		budgetUsd?: number | string;
		unlimited?: boolean;
	}>();
	if (!body.email || !body.password || body.password.length < 10) {
		return c.json({ error: "Email and a password of at least 10 characters are required" }, 400);
	}
	try {
		const budget = { budgetUsd: parseBudget(body.budgetUsd), unlimited: Boolean(body.unlimited) };
		const role = body.role === "admin" ? "admin" : "member";
		return c.json(await createUser(body.email, body.name ?? "", body.password, role, budget), 201);
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 400);
	}
});

api.patch("/users/:id/budget", requireAdmin, async (c) => {
	const body = await c.req.json<{ budgetUsd?: number | string; unlimited?: boolean }>();
	try {
		const unlimited = typeof body.unlimited === "boolean" ? body.unlimited : undefined;
		await setBudget(c.req.param("id"), parseBudget(body.budgetUsd), unlimited);
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 400);
	}
	return c.json(await usageFor(c.req.param("id")));
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
// ES modules for the code editor (CodeMirror), resolved to each package's entry file. Only these packages are served.
const ESM_PACKAGES = /^(codemirror|style-mod|w3c-keyname|crelt|@codemirror\/[a-z-]+|@lezer\/[a-z-]+|@marijn\/find-cluster-break)$/;
const esmEntries = new Map<string, string>();
app.use("/vendor/*", compress());
app.get("/vendor/esm/*", (c) => {
	const name = c.req.path.slice("/vendor/esm/".length);
	if (!ESM_PACKAGES.test(name)) return c.notFound();
	let file = esmEntries.get(name);
	if (!file) {
		const dir = `${config.nodeModules}${name}/`;
		if (!existsSync(`${dir}package.json`)) return c.notFound();
		const pkg = JSON.parse(readFileSync(`${dir}package.json`, "utf8"));
		const entry = pkg.exports?.["."]?.import ?? pkg.exports?.import ?? pkg.module ?? pkg.main ?? "index.js";
		file = `${dir}${typeof entry === "string" ? entry : entry.default}`;
		esmEntries.set(name, file);
	}
	c.header("Content-Type", "text/javascript; charset=utf-8");
	c.header("Cache-Control", "public, max-age=86400");
	return c.body(readFileSync(file, "utf8"));
});
app.get("/static/*", serveStatic({ root: config.webRoot, rewriteRequestPath: (p) => p.replace("/static", "") }));
const indexHtml = readFileSync(`${config.webRoot}index.html`, "utf8");
app.get("*", (c) => c.html(indexHtml));

await migrate();
await ensureAdmin();
serve({ fetch: app.fetch, port: config.port }, (info) => {
	console.log(`agency platform listening on :${info.port} for ${config.publicUrl}`);
});
