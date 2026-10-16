// Pushes an app's code to the organization's GitHub (github.com or GitHub Enterprise Server).
// An admin saves a token once; each app links to a repository and pushes its version history there.
// The token never enters the sandbox: the platform copies the sandbox's git history out as a bundle
// and pushes it from its own container.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "./db.ts";
import { execArgv } from "./docker.ts";
import { getProject, type Project, sandboxName } from "./projects.ts";
import { deleteSetting, getSetting, putSetting } from "./settings.ts";

export interface GitHubConfig {
	/** https://api.github.com, or https://github.example.com/api/v3 for GitHub Enterprise Server. */
	apiUrl: string;
	/** The organization (or user) new repositories are created under. */
	owner: string;
	/** A fine-grained token (or a classic one with repo scope) with Contents and Administration write on the owner's repositories. */
	token: string;
	/** The account the token belongs to, filled in when it is saved. */
	account: string;
}

export class GitHubError extends Error {}

const KEY = "github";
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!\/|.*\/\/|.*\.\.|.*\.lock$|.*[\s~^:?*[\\])[A-Za-z0-9._\/-]{1,100}$/;

export async function getGitHub(): Promise<GitHubConfig | undefined> {
	return getSetting<GitHubConfig>(KEY);
}

export async function gitHubView() {
	const gh = await getGitHub();
	return gh ? { apiUrl: gh.apiUrl, owner: gh.owner, account: gh.account, webUrl: webUrl(gh) } : null;
}

/** https://github.com for the public API, the server's own address for GitHub Enterprise. */
function webUrl(gh: Pick<GitHubConfig, "apiUrl">): string {
	if (/^https:\/\/api\.github\.com\/?$/.test(gh.apiUrl)) return "https://github.com";
	return gh.apiUrl.replace(/\/api\/v3\/?$/, "");
}

async function gh<T>(cfg: Pick<GitHubConfig, "apiUrl" | "token">, path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(`${cfg.apiUrl.replace(/\/+$/, "")}${path}`, {
		...init,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			Authorization: `Bearer ${cfg.token}`,
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
	const current = await getGitHub();
	const cfg = {
		apiUrl: (input.apiUrl?.trim() || "https://api.github.com").replace(/\/+$/, ""),
		owner: String(input.owner ?? "").trim(),
		token: input.token?.trim() || current?.token || "",
	};
	if (!/^https?:\/\//.test(cfg.apiUrl)) throw new GitHubError("API URL must start with https://");
	if (!NAME.test(cfg.owner)) throw new GitHubError("Enter the GitHub organization name");
	if (!cfg.token) throw new GitHubError("A token is required");
	const user = await gh<{ login: string }>(cfg, "/user");
	await gh(cfg, `/users/${cfg.owner}`);
	await putSetting(KEY, { ...cfg, account: user.login } satisfies GitHubConfig);
	return gitHubView();
}

export async function removeGitHub(): Promise<void> {
	await deleteSetting(KEY);
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
	const branch = (input.branch ?? "").trim() || "main";
	if (!BRANCH.test(branch)) throw new GitHubError(`"${branch}" is not a valid branch name`);
	let full: string;
	if (input.create) {
		const name = (input.repo ?? "").trim() || project.slug;
		if (!NAME.test(name)) throw new GitHubError("Repository names use letters, digits, '.', '-' and '_'");
		const org = await gh<{ type?: string }>(cfg, `/users/${cfg.owner}`);
		const body = JSON.stringify({ name, private: input.private !== false, description: `${project.name} (built with Agency)`, auto_init: false });
		const path = org.type === "Organization" ? `/orgs/${cfg.owner}/repos` : "/user/repos";
		const created = await gh<{ full_name: string }>(cfg, path, { method: "POST", body });
		full = created.full_name;
	} else {
		const [owner, name, ...rest] = (input.repo ?? "").trim().replace(/\.git$/, "").split("/");
		if (!owner || !name || rest.length || !NAME.test(owner) || !NAME.test(name)) throw new GitHubError("Enter the repository as owner/name");
		const found = await gh<{ full_name: string; permissions?: { push?: boolean } }>(cfg, `/repos/${owner}/${name}`);
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
		const bundle = await execArgv(sandboxName(project), ["git", "bundle", "create", "-", "main"], { timeoutMs: 120_000 });
		if (bundle.code !== 0 || bundle.stdout.length === 0) throw new GitHubError(`Couldn't read the app's history: ${bundle.stderr.trim() || "empty bundle"}`);
		await writeFile(join(dir, "app.bundle"), bundle.stdout);
		const repo = join(dir, "repo.git");
		let result = await git(["init", "-q", "--bare", repo], { cwd: dir });
		if (result.code === 0) result = await git(["fetch", "-q", join(dir, "app.bundle"), "main:main"], { cwd: repo });
		if (result.code !== 0) throw new GitHubError(`Couldn't read the app's history: ${result.out.trim()}`);
		const commit = (await git(["rev-parse", "main"], { cwd: repo })).out.trim();
		// The token goes in an HTTP header through environment config: never in a URL, a file or the sandbox.
		const basic = Buffer.from(`x-access-token:${cfg.token}`).toString("base64");
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

/** After a new version (agent turn, code save, restore): pushes it when the app has automatic pushes on. */
export function autoPush(projectId: string): void {
	void (async () => {
		const project = await getProject(projectId);
		if (!project?.github_repo || !project.github_auto_push) return;
		if (!(await getGitHub())) return;
		await pushToGitHub(project);
	})().catch((error) => console.error(`[github ${projectId}] automatic push failed: ${error instanceof Error ? error.message : error}`));
}
