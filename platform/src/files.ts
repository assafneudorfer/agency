import { posix } from "node:path";
import { execArgv } from "./docker.ts";
import { type Project, sandboxName } from "./projects.ts";

/** Largest file the code view opens or saves. Bigger files are almost always generated or binary. */
export const MAX_FILE_BYTES = 1024 * 1024;

const HIDDEN = [".git", "node_modules", ".next", ".next-build", ".agency"];

/** Thrown for problems the user caused (bad path, file too large); the API answers with 400. */
export class FileError extends Error {}

/** Normalizes a workspace-relative path and rejects anything outside the editable source tree. */
export function cleanPath(input: string): string {
	const path = posix.normalize(String(input ?? "").replace(/\\/g, "/"));
	if (!path || path === "." || path.startsWith("/") || path === ".." || path.startsWith("../") || path.includes("\0")) {
		throw new FileError("Invalid file path");
	}
	if (HIDDEN.includes(path.split("/")[0])) throw new FileError("This folder is not editable");
	return path;
}

// Resolves symlinks and refuses anything that lands outside /workspace. "$1" is the path, never interpolated.
const INSIDE_WORKSPACE = `case "$(realpath -m -- "$1")" in /workspace/*) ;; *) echo "Path is outside the project" >&2; exit 3;; esac`;

/** Lists the project's source files: tracked plus untracked, minus anything .gitignore excludes. */
export async function listFiles(project: Project): Promise<string[]> {
	const result = await execArgv(sandboxName(project), ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
	if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not list files");
	const files = new Set(
		result.stdout
			.toString("utf8")
			.split("\0")
			.filter((path) => path && !HIDDEN.includes(path.split("/")[0])),
	);
	return [...files].sort();
}

export async function readFile(project: Project, rawPath: string): Promise<{ path: string; content: string } | { path: string; binary: true } | { path: string; tooLarge: true }> {
	const path = cleanPath(rawPath);
	const script = `${INSIDE_WORKSPACE}
[ -f "$1" ] || { echo "File not found" >&2; exit 4; }
[ "$(stat -c %s -- "$1")" -le ${MAX_FILE_BYTES} ] || exit 5
cat -- "$1"`;
	const result = await execArgv(sandboxName(project), ["bash", "-c", script, "read", path]);
	if (result.code === 5) return { path, tooLarge: true };
	if (result.code !== 0) throw new FileError(result.stderr.trim() || "Could not read the file");
	if (result.stdout.includes(0)) return { path, binary: true };
	return { path, content: result.stdout.toString("utf8") };
}

/** Writes a file and commits it, so a hand edit is a restorable version like an agent turn. */
export async function writeFile(project: Project, rawPath: string, content: string): Promise<{ path: string; commit: string }> {
	const path = cleanPath(rawPath);
	const data = Buffer.from(String(content), "utf8");
	if (data.length > MAX_FILE_BYTES) throw new FileError("File is larger than 1 MB");
	const script = `set -e
${INSIDE_WORKSPACE}
mkdir -p -- "$(dirname -- "$1")"
cat > "$1"
git add -- "$1"
git diff --cached --quiet -- "$1" || git commit -q -m "Edit $1" -- "$1"
git rev-parse --short HEAD`;
	const result = await execArgv(sandboxName(project), ["bash", "-c", script, "write", path], { input: data });
	if (result.code !== 0) throw new FileError(result.stderr.trim() || "Could not save the file");
	return { path, commit: result.stdout.toString("utf8").trim().split("\n").pop() ?? "" };
}
