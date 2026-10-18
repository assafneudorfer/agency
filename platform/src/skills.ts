import { createHash } from "node:crypto";
import { query, queryOne } from "./db.ts";
import type { Project } from "./projects.ts";
import { execArgv } from "./sandboxes.ts";
import { githubReadToken } from "./github.ts";
import { readZip } from "./zip.ts";

/**
 * Skills for the coding agent: each member's own, plus the organization's that admins add for everyone. A skill is a folder with a SKILL.md (Agent Skills
 * format) and optional scripts, references and assets. Every build a member prompts runs pi with
 * that member's enabled skills, copied into the sandbox outside the app's workspace.
 */

export class SkillError extends Error {}

/** Whose skills: a member's id, or null for the organization's, which load for everyone. */
export type Owner = string | null;

export interface SkillFile {
	path: string;
	encoding: "utf8" | "base64";
	content: string;
}

interface SkillRow {
	id: string;
	name: string;
	description: string;
	source: string;
	enabled: boolean;
	files: SkillFile[];
	updated_at: string;
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SKILLS = 100;
const MAX_FILES = 200;
const MAX_SKILL_BYTES = 5_000_000;
const MAX_UPLOAD_BYTES = 20_000_000;
// Where the sandbox keeps the skills pi was started with: outside /workspace, so they never enter the app's code.
export const SANDBOX_SKILLS_DIR = "/root/.agency/skills";

export const SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when the agent should use it, for example "Use when building charts".
---

# My skill

Instructions the agent follows when this skill applies.
`;

// ---------------------------------------------------------------------------
// SKILL.md frontmatter

/** Reads name and description from SKILL.md frontmatter (simple YAML: scalars and folded or literal blocks). */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
	const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!match) return {};
	const fields: Record<string, string> = {};
	const lines = match[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const field = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
		if (!field) continue;
		let value = field[2].trim();
		if (/^[>|][+-]?$/.test(value)) {
			const block: string[] = [];
			while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) block.push(lines[++i].trim());
			value = block.join(value.startsWith(">") ? " " : "\n").trim();
		} else if (/^(["']).*\1$/.test(value)) {
			value = value.slice(1, -1);
		}
		fields[field[1]] = value;
	}
	return { name: fields.name, description: fields.description };
}

function checkNameAndDescription(name: string | undefined, description: string | undefined, where: string) {
	if (!name) throw new SkillError(`${where}: SKILL.md needs a name in its frontmatter`);
	if (!NAME.test(name) || name.length > 64) {
		throw new SkillError(`${where}: the name "${name}" must be lowercase letters, numbers and single hyphens, up to 64 characters`);
	}
	if (!description) throw new SkillError(`${where}: SKILL.md needs a description, so the agent knows when to use it`);
	if (description.length > 1024) throw new SkillError(`${where}: the description is longer than 1024 characters`);
}

// ---------------------------------------------------------------------------
// Turning a set of files (an upload, a zip, a GitHub folder) into skills

interface Bundle {
	name: string;
	description: string;
	files: SkillFile[];
	/** The folder the skill came from, relative to the import. */
	dir: string;
}

interface RawFile {
	path: string;
	data: Buffer;
}

function cleanPath(path: string): string | undefined {
	const parts = path.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
	if (parts.some((p) => p === ".." || p === ".git" || p === "__MACOSX" || p === ".DS_Store")) return undefined;
	return parts.join("/") || undefined;
}

function isSkillMd(path: string): boolean {
	return /(^|\/)skill\.md$/i.test(path);
}

function dirOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function toSkillFile(path: string, data: Buffer): SkillFile {
	const text = data.toString("utf8");
	if (!data.includes(0) && Buffer.from(text, "utf8").equals(data)) return { path, encoding: "utf8", content: text };
	return { path, encoding: "base64", content: data.toString("base64") };
}

/** Folders that hold a SKILL.md; each one is a skill. */
function skillDirs(paths: string[]): string[] {
	return [...new Set(paths.filter(isSkillMd).map(dirOf))];
}

/** The deepest skill folder a file belongs to, so a skill nested in another stays separate. */
function owningDir(path: string, dirs: string[]): string | undefined {
	let best: string | undefined;
	for (const dir of dirs) {
		if (dir === "" || path.startsWith(`${dir}/`)) {
			if (best === undefined || dir.length > best.length) best = dir;
		}
	}
	return best;
}

/**
 * Groups files into skills. A folder with a SKILL.md is a skill; with none, a lone Markdown file
 * is taken as the SKILL.md of a one-file skill.
 */
function bundlesFrom(files: RawFile[], fallbackName: string): { bundles: Bundle[]; skipped: { name: string; reason: string }[] } {
	const clean: RawFile[] = [];
	for (const file of files) {
		const path = cleanPath(file.path);
		if (path) clean.push({ path, data: file.data });
	}
	let dirs = skillDirs(clean.map((f) => f.path));
	if (dirs.length === 0) {
		const markdown = clean.filter((f) => /\.md$/i.test(f.path));
		if (markdown.length !== 1) throw new SkillError("No SKILL.md found. A skill is a folder with a SKILL.md file in it.");
		clean.splice(0, clean.length, { path: "SKILL.md", data: markdown[0].data });
		dirs = [""];
	}
	const grouped = new Map<string, RawFile[]>(dirs.map((d) => [d, []]));
	for (const file of clean) {
		const dir = owningDir(file.path, dirs);
		if (dir !== undefined) grouped.get(dir)!.push(file);
	}
	const bundles: Bundle[] = [];
	const skipped: { name: string; reason: string }[] = [];
	for (const [dir, group] of grouped) {
		const label = dir ? baseName(dir) : fallbackName;
		try {
			const skillMd = group.find((f) => f.path === (dir ? `${dir}/` : "") + baseName(f.path) && isSkillMd(f.path));
			if (!skillMd) throw new SkillError(`${label}: no SKILL.md`);
			if (group.length > MAX_FILES) throw new SkillError(`${label}: more than ${MAX_FILES} files`);
			const size = group.reduce((sum, f) => sum + f.data.length, 0);
			if (size > MAX_SKILL_BYTES) throw new SkillError(`${label}: larger than ${MAX_SKILL_BYTES / 1_000_000} MB`);
			const meta = parseFrontmatter(skillMd.data.toString("utf8"));
			const name = meta.name?.trim() || slug(label);
			checkNameAndDescription(name, meta.description?.trim(), label);
			const files = group.map((f) => {
				const relative = dir ? f.path.slice(dir.length + 1) : f.path;
				return toSkillFile(f === skillMd ? "SKILL.md" : relative, f.data);
			});
			bundles.push({ name, description: meta.description!.trim(), files, dir });
		} catch (error) {
			if (!(error instanceof SkillError)) throw error;
			skipped.push({ name: label, reason: error.message });
		}
	}
	if (bundles.length === 0) throw new SkillError(skipped.map((s) => s.reason).join("; "));
	return { bundles, skipped };
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/\.(md|zip|skill)$/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

// ---------------------------------------------------------------------------
// Storage

export interface SkillSummary {
	id: string;
	name: string;
	description: string;
	source: string;
	enabled: boolean;
	fileCount: number;
	updatedAt: string;
}

function summary(row: Omit<SkillRow, "files"> & { file_count: number }): SkillSummary {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		source: row.source,
		enabled: row.enabled,
		fileCount: Number(row.file_count),
		updatedAt: row.updated_at,
	};
}

export async function listSkills(owner: Owner): Promise<SkillSummary[]> {
	const rows = await query<Omit<SkillRow, "files"> & { file_count: number }>(
		`select id, name, description, source, enabled, updated_at, jsonb_array_length(files) as file_count
		 from user_skills where user_id is not distinct from $1 order by name`,
		[owner],
	);
	return rows.map(summary);
}

async function getRow(owner: Owner, id: string): Promise<SkillRow> {
	const row = await queryOne<SkillRow>("select * from user_skills where id::text = $1 and user_id is not distinct from $2", [id, owner]);
	if (!row) throw new SkillError("Skill not found");
	return row;
}

/** A skill with its SKILL.md and the list of its other files (binary files without contents). */
export async function getSkill(owner: Owner, id: string) {
	const row = await getRow(owner, id);
	const skillMd = row.files.find((f) => f.path === "SKILL.md");
	return {
		...summary({ ...row, file_count: row.files.length }),
		content: skillMd?.content ?? "",
		files: row.files.map((f) => ({
			path: f.path,
			size: f.encoding === "base64" ? Buffer.from(f.content, "base64").length : Buffer.byteLength(f.content),
		})),
	};
}

type SaveResult = { saved: { id: string; name: string; status: "added" | "updated" }[]; skipped: { name: string; reason: string }[] };

/** Saves skills, replacing any of the member's skills with the same name (so importing again updates). */
async function saveBundles(owner: Owner, bundles: Bundle[], sourceOf: (b: Bundle) => string): Promise<SaveResult["saved"]> {
	const existing = await query<{ name: string }>("select name from user_skills where user_id is not distinct from $1", [owner]);
	const names = new Set(existing.map((r) => r.name));
	const added = bundles.filter((b) => !names.has(b.name)).length;
	if (names.size + added > MAX_SKILLS) throw new SkillError(`There can be up to ${MAX_SKILLS} skills`);
	const saved: SaveResult["saved"] = [];
	for (const bundle of bundles) {
		// Organization skills have no user, so "on conflict" can't match them; update first, then insert.
		const values = [owner, bundle.name, bundle.description, sourceOf(bundle), JSON.stringify(bundle.files)];
		const row =
			(await queryOne<{ id: string }>(
				`update user_skills set description = $3, source = $4, files = $5, updated_at = now()
				 where user_id is not distinct from $1 and name = $2 returning id`,
				values,
			)) ??
			(await queryOne<{ id: string }>(
				"insert into user_skills (user_id, name, description, source, files) values ($1, $2, $3, $4, $5) returning id",
				values,
			));
		saved.push({ id: row!.id, name: bundle.name, status: names.has(bundle.name) ? "updated" : "added" });
	}
	return saved;
}

/** A skill written in the browser: just a SKILL.md. */
export async function createSkill(owner: Owner, content: string) {
	const meta = parseFrontmatter(content);
	checkNameAndDescription(meta.name?.trim(), meta.description?.trim(), "Skill");
	const taken = await queryOne("select 1 from user_skills where user_id is not distinct from $1 and name = $2", [owner, meta.name!.trim()]);
	if (taken) throw new SkillError(`There is already a skill named ${meta.name!.trim()}`);
	const files = [{ path: "SKILL.md", encoding: "utf8" as const, content }];
	const [saved] = await saveBundles(owner, [{ name: meta.name!.trim(), description: meta.description!.trim(), files, dir: "" }], () => "");
	return getSkill(owner, saved.id);
}

/** An uploaded SKILL.md, Markdown file, or zip (also .skill) holding one or more skill folders. */
export async function importUpload(owner: Owner, filename: string, data: Buffer): Promise<SaveResult> {
	if (data.length > MAX_UPLOAD_BYTES) throw new SkillError(`The file is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB`);
	const isZip = data.length > 4 && data.readUInt32LE(0) === 0x04034b50;
	let files: RawFile[];
	if (isZip) {
		try {
			files = readZip(data, { maxFiles: MAX_FILES * 10, maxBytes: MAX_UPLOAD_BYTES * 2 });
		} catch (error) {
			throw new SkillError(error instanceof Error ? error.message : String(error));
		}
	} else if (/\.(md|markdown|txt)$/i.test(filename) || !/\.[a-z0-9]+$/i.test(filename)) {
		files = [{ path: "SKILL.md", data }];
	} else {
		throw new SkillError("Upload a SKILL.md, a Markdown file, or a .zip of a skill folder");
	}
	const { bundles, skipped } = bundlesFrom(files, slug(filename) || "skill");
	return { saved: await saveBundles(owner, bundles, () => `upload:${filename}`), skipped };
}

export async function updateSkill(owner: Owner, id: string, input: { content?: string; enabled?: boolean }) {
	const row = await getRow(owner, id);
	if (typeof input.enabled === "boolean") {
		await query("update user_skills set enabled = $1, updated_at = now() where id = $2", [input.enabled, row.id]);
	}
	if (typeof input.content === "string") {
		const meta = parseFrontmatter(input.content);
		const name = meta.name?.trim();
		checkNameAndDescription(name, meta.description?.trim(), "Skill");
		if (name !== row.name && (await queryOne("select 1 from user_skills where user_id is not distinct from $1 and name = $2", [owner, name]))) {
			throw new SkillError(`There is already a skill named ${name}`);
		}
		const files = [{ path: "SKILL.md", encoding: "utf8", content: input.content }, ...row.files.filter((f) => f.path !== "SKILL.md")];
		await query("update user_skills set name = $1, description = $2, files = $3, updated_at = now() where id = $4", [
			name,
			meta.description!.trim(),
			JSON.stringify(files),
			row.id,
		]);
	}
	return getSkill(owner, id);
}

export async function deleteSkill(owner: Owner, id: string): Promise<void> {
	await query("delete from user_skills where id::text = $1 and user_id is not distinct from $2", [id, owner]);
}

// ---------------------------------------------------------------------------
// GitHub: a repository, or a folder or SKILL.md in one

const GITHUB_URL = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(tree|blob)\/([^?#]+?))?\/?(?:[?#].*)?$/;

async function githubJson<T>(path: string, token: string | undefined): Promise<{ ok: boolean; status: number; data: T }> {
	const response = await fetch(`https://api.github.com${path}`, {
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
	});
	return { ok: response.ok, status: response.status, data: (await response.json().catch(() => ({}))) as T };
}

interface TreeEntry {
	path: string;
	type: string;
	size?: number;
}

export async function importFromGitHub(scope: Owner, url: string): Promise<SaveResult> {
	const match = GITHUB_URL.exec(url.trim());
	if (!match) throw new SkillError("Paste a github.com link to a repository, a folder, or a SKILL.md");
	const [, owner, repo, kind, rest] = match;
	const token = await githubReadToken();
	const segments = rest ? rest.split("/").map(decodeURIComponent) : [];

	// Branch names can contain slashes, so try ever longer prefixes of the path as the ref.
	let ref = "";
	let path = "";
	let tree: TreeEntry[] | undefined;
	let truncated = false;
	const candidates: [string, string][] = [];
	if (segments.length === 0) {
		const info = await githubJson<{ default_branch?: string; message?: string }>(`/repos/${owner}/${repo}`, token);
		if (!info.ok) throw new SkillError(info.status === 404 ? `Couldn't find ${owner}/${repo} on GitHub, or it's private` : `GitHub: ${info.data.message ?? info.status}`);
		candidates.push([info.data.default_branch ?? "main", ""]);
	} else {
		for (let i = 1; i <= Math.min(segments.length, 6); i++) candidates.push([segments.slice(0, i).join("/"), segments.slice(i).join("/")]);
	}
	for (const [candidateRef, candidatePath] of candidates) {
		const result = await githubJson<{ tree?: TreeEntry[]; truncated?: boolean; message?: string }>(
			`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(candidateRef)}?recursive=1`,
			token,
		);
		if (result.ok && result.data.tree) {
			[ref, path, tree, truncated] = [candidateRef, candidatePath, result.data.tree, Boolean(result.data.truncated)];
			break;
		}
		if (result.status === 403 || result.status === 429) throw new SkillError(`GitHub: ${result.data.message ?? "rate limited"}. Try again later.`);
	}
	if (!tree) throw new SkillError(`Couldn't find ${owner}/${repo} on GitHub, or it's private`);

	// A link to a file means its folder when the file is a SKILL.md, or just that file otherwise.
	let prefix = path;
	let single = false;
	if (kind === "blob") {
		if (isSkillMd(path)) prefix = dirOf(path);
		else single = true;
	}
	const blobs = tree.filter(
		(e) => e.type === "blob" && (single ? e.path === path : prefix === "" || e.path === prefix || e.path.startsWith(`${prefix}/`)),
	);
	// Keep paths relative to the parent of the linked folder, so each skill keeps its folder's name.
	const base = single ? dirOf(path) : dirOf(prefix);
	const relative = (p: string) => (base ? p.slice(base.length + 1) : p);
	const dirs = skillDirs(blobs.map((b) => relative(b.path)));
	const wanted = single ? blobs : blobs.filter((b) => owningDir(relative(b.path), dirs) !== undefined);
	if (wanted.length === 0) {
		throw new SkillError(truncated ? "That repository is too big to scan; link the skill's folder instead" : "No SKILL.md found at that link");
	}
	if (dirs.length > 50) throw new SkillError(`That link has ${dirs.length} skills; link a folder with fewer (up to 50)`);
	if (wanted.length > MAX_FILES * 5) throw new SkillError("That link has too many files; link a single skill's folder");
	const total = wanted.reduce((sum, b) => sum + (b.size ?? 0), 0);
	if (total > MAX_UPLOAD_BYTES) throw new SkillError("The skills at that link are too large to import");

	const files: RawFile[] = [];
	const queue = [...wanted];
	const fetchOne = async () => {
		for (let entry = queue.shift(); entry; entry = queue.shift()) {
			const encoded = entry.path.split("/").map(encodeURIComponent).join("/");
			const response = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${encoded}`, {
				headers: token ? { Authorization: `token ${token}` } : {},
			});
			if (!response.ok) throw new SkillError(`Couldn't download ${entry.path} (${response.status})`);
			files.push({ path: single ? "SKILL.md" : relative(entry.path), data: Buffer.from(await response.arrayBuffer()) });
		}
	};
	await Promise.all(Array.from({ length: 8 }, fetchOne));
	const { bundles, skipped } = bundlesFrom(files, slug(baseName(path) || repo));
	const sourceOf = (b: Bundle) => {
		if (single) return `https://github.com/${owner}/${repo}/blob/${ref}/${path}`;
		const dir = [base, b.dir].filter(Boolean).join("/");
		return `https://github.com/${owner}/${repo}/tree/${ref}${dir ? `/${dir}` : ""}`;
	};
	return { saved: await saveBundles(scope, bundles, sourceOf), skipped };
}

/** Imports a GitHub skill again from where it came from. */
export async function refreshSkill(owner: Owner, id: string): Promise<SaveResult> {
	const row = await getRow(owner, id);
	if (!GITHUB_URL.test(row.source)) throw new SkillError("Only skills imported from GitHub can be updated from their source");
	return importFromGitHub(owner, row.source);
}

// ---------------------------------------------------------------------------
// Loading skills into a sandbox

/**
 * What a member's builds load: their enabled skills, then the organization's enabled ones. pi keeps
 * the first skill of a name, so a member's own skill wins over an organization skill of the same name.
 */
async function effectiveSkills<T>(userId: string, columns: string): Promise<(T & { name: string })[]> {
	return query<T & { name: string }>(
		`select distinct on (name) ${columns} from user_skills
		 where enabled and (user_id = $1 or user_id is null)
		 order by name, user_id nulls last`,
		[userId],
	);
}

/** Changes whenever the skills a member's builds load change, so the agent knows to restart with the new set. */
export async function skillsFingerprint(userId: string): Promise<string> {
	const rows = await effectiveSkills<{ id: string; updated_at: Date }>(userId, "name, id, updated_at");
	return createHash("sha256")
		.update(rows.map((r) => `${r.id}@${new Date(r.updated_at).toISOString()}`).join(","))
		.digest("hex");
}
// Runs inside the sandbox with Node: replaces the skills folder with the files sent on stdin.
const INSTALL_SCRIPT = `
const fs = require("fs"), path = require("path");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
	const { root, skills } = JSON.parse(input);
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true });
	for (const skill of skills) {
		const dir = path.join(root, skill.name);
		for (const file of skill.files) {
			const target = path.join(dir, file.path);
			if (!target.startsWith(dir + "/")) continue;
			fs.mkdirSync(path.dirname(target), { recursive: true });
			const data = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
			fs.writeFileSync(target, data, { mode: data.subarray(0, 2).toString() === "#!" ? 0o755 : 0o644 });
		}
	}
});
`;

/**
 * Copies the skills a member's builds load (theirs and the organization's) into the sandbox and returns the folders to pass to pi.
 * Returns the fingerprint of what was installed.
 */
export async function installSkills(project: Project, userId: string): Promise<{ dirs: string[]; fingerprint: string }> {
	const fingerprint = await skillsFingerprint(userId);
	const rows = await effectiveSkills<{ files: SkillFile[] }>(userId, "name, files");
	const result = await execArgv(project, ["node", "-e", INSTALL_SCRIPT], {
		input: JSON.stringify({ root: SANDBOX_SKILLS_DIR, skills: rows }),
	});
	if (result.code !== 0) throw new Error(`Could not copy skills into the sandbox: ${result.stderr.trim()}`);
	return { dirs: rows.map((r) => `${SANDBOX_SKILLS_DIR}/${r.name}`), fingerprint };
}
