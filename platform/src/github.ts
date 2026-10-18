// Pushes an app's code to the organization's GitHub (github.com or GitHub Enterprise Server).
// An admin connects GitHub once, either in one click (Agency creates a GitHub App in the organization
// from a manifest and installs it) or with a token; each app links to a repository and pushes its
// version history there. Tokens never enter the sandbox: the platform copies the sandbox's git
// history out as a bundle and pushes it from its own container.

import { spawn } from "node:child_process";
import { createSign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.ts";
import { randomToken } from "./crypto.ts";
import { query } from "./db.ts";
import { ensureSandbox, getProject, type Project } from "./projects.ts";
import { execArgv } from "./sandboxes.ts";
import { deleteSetting, getSetting, putSetting } from "./settings.ts";

interface Common {
	/** https://api.github.com, or https://github.example.com/api/v3 for GitHub Enterprise Server. */
	apiUrl: string;
	/** The organization (or user) new repositories are created under. */
	owner: string;
	/** Who pushes: the token's user, or the app's bot. */
	account: string;
}

export interface GitHubTokenConfig extends Common {
	mode?: "token";
	/** A fine-grained token (or a classic one with repo scope) with Contents and Administration write on the owner's repositories. */
	token: string;
}

/** A GitHub App Agency created in the organization. It pushes with installation tokens that last an hour. */
export interface GitHubAppConfig extends Common {
	mode: "app";
	appId: number;
	slug: string;
	privateKey: string;
	/** Null until the app is installed on the organization. */
	installationId: number | null;
}

export type GitHubConfig = GitHubTokenConfig | GitHubAppConfig;

export class GitHubError extends Error {}

const KEY = "github";
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!\/|.*\/\/|.*\.\.|.*\.lock$|.*[\s~^:?*[\\])[A-Za-z0-9._\/-]{1,100}$/;

/** Connected means pushes can work: a token, or an app that is installed. */
export async function getGitHub(): Promise<GitHubConfig | undefined> {
	const cfg = await getSetting<GitHubConfig>(KEY);
	return cfg && (cfg.mode !== "app" || cfg.installationId) ? cfg : undefined;
}

export async function gitHubView() {
	const cfg = await getSetting<GitHubConfig>(KEY);
	if (!cfg) return null;
	const web = webUrl(cfg);
	const base = { apiUrl: cfg.apiUrl, owner: cfg.owner, account: cfg.account, webUrl: web };
	if (cfg.mode !== "app") return { ...base, mode: "token" as const, installed: true };
	return {
		...base,
		mode: "app" as const,
		installed: Boolean(cfg.installationId),
		appUrl: `${web}/organizations/${cfg.owner}/settings/apps/${cfg.slug}`,
		installUrl: `${web}/apps/${cfg.slug}/installations/new`,
		installationUrl: cfg.installationId ? `${web}/organizations/${cfg.owner}/settings/installations/${cfg.installationId}` : null,
	};
}

/** https://github.com for the public API, the server's own address for GitHub Enterprise. */
function webUrl(gh: Pick<GitHubConfig, "apiUrl">): string {
	if (/^https:\/\/api\.github\.com\/?$/.test(gh.apiUrl)) return "https://github.com";
	return gh.apiUrl.replace(/\/api\/v3\/?$/, "");
}

/** The API address for a web address: api.github.com for github.com, /api/v3 on GitHub Enterprise Server. */
function apiUrlFor(web: string): string {
	return /^https:\/\/github\.com$/.test(web) ? "https://api.github.com" : `${web}/api/v3`;
}

async function gh<T>(cfg: { apiUrl: string; token?: string }, path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(`${cfg.apiUrl.replace(/\/+$/, "")}${path}`, {
		...init,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
			...(init.body ? { "Content-Type": "application/json" } : {}),
		},
	});
	const data = (await response.json().catch(() => ({}))) as T & { message?: string; errors?: { message?: string }[] };
	if (!response.ok) {
		const detail = data.errors?.map((e) => e.message).filter(Boolean).join("; ");
		throw new GitHubError(`GitHub: ${data.message ?? response.status}${detail ? ` (${detail})` : ""}`);
	}
	return data;
}

/** Checks the token and the owner, then saves. An empty token keeps the stored one. */
export async function saveGitHub(input: { apiUrl?: string; owner?: string; token?: string }) {
	const current = await getSetting<GitHubConfig>(KEY);
	const cfg = {
		apiUrl: (input.apiUrl?.trim() || "https://api.github.com").replace(/\/+$/, ""),
		owner: String(input.owner ?? "").trim(),
		token: input.token?.trim() || (current?.mode !== "app" ? current?.token : "") || "",
	};
	if (!/^https?:\/\//.test(cfg.apiUrl)) throw new GitHubError("API URL must start with https://");
	if (!NAME.test(cfg.owner)) throw new GitHubError("Enter the GitHub organization name");
	if (!cfg.token) throw new GitHubError("A token is required");
	const user = await gh<{ login: string }>(cfg, "/user");
	await gh(cfg, `/users/${cfg.owner}`);
	await putSetting(KEY, { mode: "token", ...cfg, account: user.login } satisfies GitHubConfig);
	return gitHubView();
}

/** Disconnects. An app's installation is removed too; the app itself is deleted on GitHub by an owner. */
export async function removeGitHub(): Promise<void> {
	const cfg = await getSetting<GitHubConfig>(KEY);
	if (cfg?.mode === "app" && cfg.installationId) {
		await gh(appAuth(cfg), `/app/installations/${cfg.installationId}`, { method: "DELETE" }).catch((error) =>
			console.error(`[github] couldn't uninstall the app: ${error instanceof Error ? error.message : error}`),
		);
	}
	installationTokens.clear();
	await deleteSetting(KEY);
}

// ---------------------------------------------------------------------------
// One-click setup: a GitHub App created from a manifest
// (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)

const manifests = new Map<string, { owner: string; web: string; expires: number }>();

/**
 * The page that sends the admin to GitHub with the app's manifest. GitHub shows what the app may do,
 * the admin clicks Create, and GitHub sends them back to /github/app/created.
 */
export function appManifestPage(input: { owner?: string; webUrl?: string }): string {
	const owner = String(input.owner ?? "").trim();
	if (!NAME.test(owner)) throw new GitHubError("Enter the GitHub organization name");
	const web = (String(input.webUrl ?? "").trim() || "https://github.com").replace(/\/+$/, "");
	if (!/^https?:\/\//.test(web)) throw new GitHubError("The GitHub address must start with https://");
	for (const [key, value] of manifests) if (value.expires < Date.now()) manifests.delete(key);
	const state = randomToken(24);
	manifests.set(state, { owner, web, expires: Date.now() + 30 * 60_000 });
	const host = new URL(config.publicUrl).host;
	const manifest = {
		// App names are unique across GitHub; the admin can change it on the next page.
		name: `Agency ${host}`.slice(0, 34),
		url: config.publicUrl,
		description: `Pushes app code from Agency (${config.publicUrl}) to repositories in ${owner}.`,
		redirect_url: `${config.publicUrl}/github/app/created`,
		setup_url: `${config.publicUrl}/github/app/installed`,
		setup_on_update: true,
		public: false,
		default_permissions: { contents: "write", administration: "write", metadata: "read" },
		default_events: [],
		hook_attributes: { url: `${config.publicUrl}/github/app/events`, active: false },
	};
	const action = `${web}/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${state}`;
	const escape = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
	return `<!doctype html><meta charset="utf-8"><title>Connecting GitHub</title>
<body style="font-family:system-ui;padding:40px;color:#555">
<form id="f" method="post" action="${escape(action)}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">
<p>Taking you to GitHub...</p><noscript><button>Continue to GitHub</button></noscript></form>
<script>document.getElementById("f").submit()</script>`;
}

/** Back from GitHub with the new app: saves its credentials and returns the page that installs it. */
export async function finishAppManifest(state: string, code: string): Promise<string> {
	const pending = manifests.get(state);
	manifests.delete(state);
	if (!pending || pending.expires < Date.now()) throw new GitHubError("This setup expired. Click Connect GitHub again.");
	const apiUrl = apiUrlFor(pending.web);
	const app = await gh<{ id: number; slug: string; pem: string; owner?: { login?: string; type?: string } }>(
		{ apiUrl },
		`/app-manifests/${encodeURIComponent(code)}/conversions`,
		{ method: "POST" },
	);
	const owner = app.owner?.login ?? pending.owner;
	await putSetting(KEY, {
		mode: "app",
		apiUrl,
		owner,
		appId: app.id,
		slug: app.slug,
		privateKey: app.pem,
		installationId: null,
		account: `${app.slug}[bot]`,
	} satisfies GitHubAppConfig);
	installationTokens.clear();
	return `${pending.web}/apps/${app.slug}/installations/new`;
}

/** Back from installing the app: checks the installation belongs to this app and the organization. */
export async function finishAppInstall(installationId: number): Promise<void> {
	const cfg = await getSetting<GitHubConfig>(KEY);
	if (cfg?.mode !== "app") throw new GitHubError("Click Connect GitHub in Settings first");
	if (!Number.isInteger(installationId) || installationId <= 0) throw new GitHubError("GitHub didn't say where the app was installed");
	const installation = await gh<{ id: number; app_id: number; account?: { login?: string } }>(appAuth(cfg), `/app/installations/${installationId}`);
	if (installation.app_id !== cfg.appId) throw new GitHubError("That installation belongs to a different app");
	const login = installation.account?.login ?? "";
	if (login.toLowerCase() !== cfg.owner.toLowerCase()) throw new GitHubError(`The app was installed on ${login}, not ${cfg.owner}. Install it on ${cfg.owner}.`);
	await putSetting(KEY, { ...cfg, installationId } satisfies GitHubAppConfig);
	installationTokens.clear();
}

/** A short-lived JWT the app signs with its private key, to call the /app endpoints. */
function appAuth(cfg: GitHubAppConfig): { apiUrl: string; token: string } {
	const now = Math.floor(Date.now() / 1000);
	const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const body = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: String(cfg.appId) })}`;
	const signature = createSign("RSA-SHA256").update(body).sign(cfg.privateKey).toString("base64url");
	return { apiUrl: cfg.apiUrl, token: `${body}.${signature}` };
}

const installationTokens = new Map<number, { token: string; expires: number }>();

/** The token API calls and pushes use: the saved token, or a fresh installation token for the app. */
async function accessToken(cfg: GitHubConfig): Promise<string> {
	if (cfg.mode !== "app") return cfg.token;
	if (!cfg.installationId) throw new GitHubError("Finish installing the GitHub app under Settings");
	const cached = installationTokens.get(cfg.installationId);
	if (cached && cached.expires - Date.now() > 5 * 60_000) return cached.token;
	const issued = await gh<{ token: string; expires_at: string }>(appAuth(cfg), `/app/installations/${cfg.installationId}/access_tokens`, {
		method: "POST",
	});
	installationTokens.set(cfg.installationId, { token: issued.token, expires: Date.parse(issued.expires_at) });
	return issued.token;
}

/**
 * The organization's github.com token, for reading repositories when importing skills: it reaches
 * the organization's private repositories and lifts the 60 requests an hour GitHub allows without one.
 */
export async function githubReadToken(): Promise<string | undefined> {
	const cfg = await getGitHub();
	if (!cfg || webUrl(cfg) !== "https://github.com") return undefined;
	return accessToken(cfg).catch(() => undefined);
}

async function api(cfg: GitHubConfig): Promise<{ apiUrl: string; token: string }> {
	return { apiUrl: cfg.apiUrl, token: await accessToken(cfg) };
}

async function requireGitHub(): Promise<GitHubConfig> {
	const cfg = await getGitHub();
	if (!cfg) throw new GitHubError("GitHub isn't set up. An admin connects it under Settings.");
	return cfg;
}

export function projectGitHub(project: Project, cfg: GitHubConfig | undefined) {
	return {
		configured: Boolean(cfg),
		owner: cfg?.owner ?? null,
		repo: project.github_repo,
		branch: project.github_branch,
		autoPush: project.github_auto_push,
		pushedCommit: project.github_pushed_commit,
		pushedAt: project.github_pushed_at,
		url: cfg && project.github_repo ? `${webUrl(cfg)}/${project.github_repo}` : null,
	};
}

/**
 * Links the app to a repository: a new one under the organization (create), or an existing "owner/name".
 * A new repository is created empty, so the app's history becomes its history on the first push.
 */
export async function linkRepository(
	project: Project,
	input: { create?: boolean; repo?: string; branch?: string; private?: boolean; autoPush?: boolean },
): Promise<void> {
	const cfg = await requireGitHub();
	const auth = await api(cfg);
	const branch = (input.branch ?? "").trim() || "main";
	if (!BRANCH.test(branch)) throw new GitHubError(`"${branch}" is not a valid branch name`);
	let full: string;
	if (input.create) {
		const name = (input.repo ?? "").trim() || project.slug;
		if (!NAME.test(name)) throw new GitHubError("Repository names use letters, digits, '.', '-' and '_'");
		const org = await gh<{ type?: string }>(auth, `/users/${cfg.owner}`);
		// An app's installation token can only create repositories in an organization.
		if (cfg.mode === "app" && org.type !== "Organization") throw new GitHubError(`${cfg.owner} is a personal account: link an existing repository instead`);
		const body = JSON.stringify({ name, private: input.private !== false, description: `${project.name} (built with Agency)`, auto_init: false });
		const path = org.type === "Organization" ? `/orgs/${cfg.owner}/repos` : "/user/repos";
		const created = await gh<{ full_name: string }>(auth, path, { method: "POST", body });
		full = created.full_name;
	} else {
		const [owner, name, ...rest] = (input.repo ?? "").trim().replace(/\.git$/, "").split("/");
		if (!owner || !name || rest.length || !NAME.test(owner) || !NAME.test(name)) throw new GitHubError("Enter the repository as owner/name");
		const found = await gh<{ full_name: string; permissions?: { push?: boolean } }>(auth, `/repos/${owner}/${name}`).catch((error) => {
			if (cfg.mode === "app" && /Not Found/.test(error.message)) {
				throw new GitHubError(`The GitHub app can't see ${owner}/${name}. Give it access to the repository in the app's installation settings.`);
			}
			throw error;
		});
		if (found.permissions && !found.permissions.push) throw new GitHubError(`The token can't push to ${found.full_name}`);
		full = found.full_name;
	}
	await query(
		"update projects set github_repo = $2, github_branch = $3, github_auto_push = $4, github_pushed_commit = null, github_pushed_at = null where id = $1",
		[project.id, full, branch, Boolean(input.autoPush)],
	);
}

export async function unlinkRepository(project: Project): Promise<void> {
	await query("update projects set github_repo = null, github_auto_push = false, github_pushed_commit = null, github_pushed_at = null where id = $1", [
		project.id,
	]);
}

export async function setAutoPush(project: Project, autoPush: boolean): Promise<void> {
	await query("update projects set github_auto_push = $2 where id = $1", [project.id, autoPush]);
}

function git(args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<{ code: number; out: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, {
			cwd: options.cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.stderr.on("data", (chunk) => (out += chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60_000);
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, out });
		});
	});
}

const pushing = new Set<string>();

/**
 * Pushes the app's current version history (its main branch in the sandbox) to the linked branch.
 * Without `force`, a branch that has commits Agency doesn't know is left alone and the push fails.
 */
export async function pushToGitHub(project: Project, options: { force?: boolean } = {}): Promise<{ commit: string; url: string }> {
	const cfg = await requireGitHub();
	if (!project.github_repo) throw new GitHubError("Link a repository first");
	if (pushing.has(project.id)) throw new GitHubError("A push is already running");
	pushing.add(project.id);
	const dir = await mkdtemp(join(tmpdir(), "agency-push-"));
	try {
		// Auto-push can run for an app whose sandbox is asleep.
		await ensureSandbox(project);
		const bundle = await execArgv(project, ["git", "bundle", "create", "-", "main"], { timeoutMs: 120_000 });
		if (bundle.code !== 0 || bundle.stdout.length === 0) throw new GitHubError(`Couldn't read the app's history: ${bundle.stderr.trim() || "empty bundle"}`);
		await writeFile(join(dir, "app.bundle"), bundle.stdout);
		const repo = join(dir, "repo.git");
		let result = await git(["init", "-q", "--bare", repo], { cwd: dir });
		if (result.code === 0) result = await git(["fetch", "-q", join(dir, "app.bundle"), "main:main"], { cwd: repo });
		if (result.code !== 0) throw new GitHubError(`Couldn't read the app's history: ${result.out.trim()}`);
		const commit = (await git(["rev-parse", "main"], { cwd: repo })).out.trim();
		// The token goes in an HTTP header through environment config: never in a URL, a file or the sandbox.
		const basic = Buffer.from(`x-access-token:${await accessToken(cfg)}`).toString("base64");
		const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
		const remote = `${webUrl(cfg)}/${project.github_repo}.git`;
		const refspec = `${options.force ? "+" : ""}main:refs/heads/${project.github_branch}`;
		result = await git(["push", "--porcelain", remote, refspec], { cwd: repo, env });
		if (result.code !== 0) {
			const text = result.out.replaceAll(basic, "***");
			if (/rejected|non-fast-forward|fetch first/i.test(text)) {
				throw new GitHubError(`The branch ${project.github_branch} on GitHub has commits that aren't in this app. Push again with "Overwrite" to replace them, or pick another branch.`);
			}
			throw new GitHubError(`Push failed: ${text.trim().split("\n").slice(-3).join(" ")}`);
		}
		await query("update projects set github_pushed_commit = $2, github_pushed_at = now() where id = $1", [project.id, commit]);
		project.github_pushed_commit = commit;
		return { commit, url: `${webUrl(cfg)}/${project.github_repo}/tree/${project.github_branch}` };
	} finally {
		pushing.delete(project.id);
		await rm(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// New apps: each gets a private repository and pushes every version, unless an admin turns it off.

const NEW_APPS_KEY = "github_new_apps";

export interface NewAppsDefaults {
	/** Create a repository for every new app and push each version automatically. */
	createRepo: boolean;
	private: boolean;
}

export async function newAppsDefaults(): Promise<NewAppsDefaults> {
	return { createRepo: true, private: true, ...(await getSetting<Partial<NewAppsDefaults>>(NEW_APPS_KEY)) };
}

export async function saveNewAppsDefaults(input: Partial<NewAppsDefaults>): Promise<NewAppsDefaults> {
	const next = { createRepo: input.createRepo !== false, private: input.private !== false };
	await putSetting(NEW_APPS_KEY, next);
	return next;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Right after an app is created: links it to a new repository named after it (adding -2, -3, ... when the
 * organization already has one by that name) and pushes its first version once the sandbox has committed it.
 */
export function linkNewApp(projectId: string): void {
	void (async () => {
		const defaults = await newAppsDefaults();
		if (!defaults.createRepo || !(await getGitHub())) return;
		let project = await getProject(projectId);
		if (!project || project.github_repo) return;
		for (let attempt = 1; ; attempt++) {
			const repo = attempt === 1 ? project.slug : `${project.slug}-${attempt}`;
			try {
				await linkRepository(project, { create: true, repo, private: defaults.private, autoPush: true });
				break;
			} catch (error) {
				if (attempt >= 5 || !/already exists/i.test(error instanceof Error ? error.message : "")) throw error;
			}
		}
		// The sandbox commits the template when it first starts; wait for that commit.
		for (let attempt = 1; ; attempt++) {
			project = await getProject(projectId);
			// Unlinked meanwhile, or an automatic push after the agent's first turn already got there.
			if (!project?.github_repo || project.github_pushed_commit) return;
			try {
				await pushToGitHub(project);
				return;
			} catch (error) {
				if (attempt >= 10) throw error;
				await sleep(3000);
			}
		}
	})().catch((error) => console.error(`[github ${projectId}] couldn't set up the new app's repository: ${error instanceof Error ? error.message : error}`));
}

/** After a new version (agent turn, code save, restore): pushes it when the app has automatic pushes on. */
export function autoPush(projectId: string): void {
	void (async () => {
		const project = await getProject(projectId);
		if (!project?.github_repo || !project.github_auto_push) return;
		if (!(await getGitHub())) return;
		await pushToGitHub(project);
	})().catch((error) => console.error(`[github ${projectId}] automatic push failed: ${error instanceof Error ? error.message : error}`));
}
