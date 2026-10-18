import { posix } from "node:path";
import { FileError } from "./files.ts";
import type { Project } from "./projects.ts";
import { execArgv } from "./sandboxes.ts";

/** Where chat attachments land in the workspace, so the agent (and the app) can read them. */
export const UPLOAD_DIR = "uploads";
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
// The model API refuses larger images, so they are saved but not shown to it.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MODEL_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Heading of the list appended to a prompt; the builder parses it back to draw attachment chips. */
export const ATTACHMENTS_HEADING = "Attached files (saved in the workspace):";

export interface Attachment {
	name: string;
	type: string;
	data: Buffer;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

/** Keeps a readable, safe file name: no folders, no leading dots, no characters a shell or URL trips on. */
export function safeName(input: string): string {
	const base = posix.basename(String(input ?? "").replace(/\\/g, "/"));
	const cleaned = base
		.normalize("NFC")
		.replace(/[^\p{L}\p{N}._ -]+/gu, "-")
		.replace(/\s+/g, " ")
		.replace(/^[.\s-]+/, "")
		.trim()
		.slice(-120);
	return cleaned || "file";
}

export function checkAttachments(files: Attachment[]): void {
	if (files.length > MAX_ATTACHMENTS) throw new FileError(`Attach at most ${MAX_ATTACHMENTS} files at a time`);
	let total = 0;
	for (const file of files) {
		if (file.data.length > MAX_ATTACHMENT_BYTES) throw new FileError(`${file.name} is larger than 10 MB`);
		total += file.data.length;
	}
	if (total > MAX_TOTAL_BYTES) throw new FileError("Attachments are larger than 25 MB together");
}

/**
 * Saves each file under uploads/ in the workspace, never overwriting an earlier upload (a clash gets
 * " 2", " 3"... before the extension). Returns the workspace paths the files were written to.
 */
export async function saveAttachments(project: Project, files: Attachment[]): Promise<string[]> {
	const paths: string[] = [];
	// "$1" is the wanted name; the script prints the name it used. Nothing is interpolated into the script.
	const script = `set -e
mkdir -p ${UPLOAD_DIR}
case "$(realpath -m -- ${UPLOAD_DIR})" in /workspace/*) ;; *) echo "Upload folder is outside the project" >&2; exit 3;; esac
name="$1"; stem="\${name%.*}"; ext=""
[ "$stem" != "$name" ] && [ -n "$stem" ] && ext=".\${name##*.}" || stem="$name"
n=1
while [ -e "${UPLOAD_DIR}/$name" ] || [ -L "${UPLOAD_DIR}/$name" ]; do n=$((n + 1)); name="$stem $n$ext"; done
cat > "${UPLOAD_DIR}/$name"
printf '%s' "${UPLOAD_DIR}/$name"`;
	for (const file of files) {
		const result = await execArgv(project, ["bash", "-c", script, "upload", safeName(file.name)], {
			input: file.data,
			timeoutMs: 60_000,
		});
		if (result.code !== 0) throw new FileError(result.stderr.trim() || `Could not save ${file.name}`);
		paths.push(result.stdout.toString("utf8").trim());
	}
	return paths;
}

/** Images the model can look at, as pi's ImageContent. */
export function modelImages(files: Attachment[]): ImageContent[] {
	return files
		.filter((file) => MODEL_IMAGE_TYPES.includes(file.type) && file.data.length <= MAX_IMAGE_BYTES)
		.map((file) => ({ type: "image", data: file.data.toString("base64"), mimeType: file.type }));
}

/** The prompt text the agent gets: the user's words, then where each attachment was saved. */
export function promptWithAttachments(message: string, paths: string[]): string {
	if (paths.length === 0) return message;
	const list = paths.map((path) => `- ${path}`).join("\n");
	return `${message || "See the attached files."}\n\n${ATTACHMENTS_HEADING}\n${list}`;
}
