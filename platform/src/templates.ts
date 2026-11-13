// Templates: apps an admin offers to everyone as a starting point, such as a contract generator or a
// UTM link builder. Starting from one makes a new app owned by whoever asked, with a copy of the
// template's code at its latest version, without its history or chat attachments. Data is not copied:
// the new app's tables, and any rows the template seeds, come from its lib/schema.ts like any app's.

import { query, queryOne } from "./db.ts";
import { touch } from "./idle.ts";
import { createProject, deleteProject, ensureSandbox, type Project } from "./projects.ts";
import { execArgv } from "./sandboxes.ts";

/** Thrown for problems the user caused (bad description, not a template); the API answers with 400. */
export class TemplateError extends Error {}

export interface TemplateView {
	id: string;
	name: string;
	description: string;
}

function view(project: Project): TemplateView {
	return { id: project.id, name: project.name, description: project.template_description };
}

/** Every template, for anyone signed in. Marking an app as a template shares its code, not its data. */
export async function listTemplates(): Promise<TemplateView[]> {
	const rows = await query<Project>("select * from projects where is_template order by name");
	return rows.map(view);
}

export async function getTemplate(id: string): Promise<Project | undefined> {
	return queryOne<Project>("select * from projects where id = $1 and is_template", [id]);
}

/** Turns an app into a template, updates its description, or takes it off the list. Admins only. */
export async function setTemplate(project: Project, body: { template?: boolean; description?: string }): Promise<void> {
	const template = body.template ?? project.is_template;
	const description = (body.description ?? project.template_description).replace(/\s+/g, " ").trim();
	if (description.length > 200) throw new TemplateError("Keep the description under 200 characters");
	await query("update projects set is_template = $2, template_description = $3 where id = $1", [project.id, template, description]);
	project.is_template = template;
	project.template_description = description;
}

// Waits for the new sandbox to finish setting up its workspace (entrypoint.sh), then replaces the
// files with the template's latest version as one commit, so the first version of the new app is the
// template and the agent's next turn builds on it. Only the latest files travel (a tar on stdin): the
// template's history and the files its builders attached to the chat (uploads/) stay behind, since
// either may hold things they didn't mean to share. Packages the template added are installed here.
// "$1" is the commit message, never interpolated.
const COPY_SCRIPT = `set -e
for i in $(seq 1 240); do
	git rev-parse -q --verify HEAD >/dev/null 2>&1 && [ -e node_modules/.package-lock.json ] && break
	sleep 0.5
done
git rev-parse -q --verify HEAD >/dev/null || { echo "The new app's workspace isn't ready" >&2; exit 1; }
git rm -rq --ignore-unmatch .
tar -xf - --exclude=./uploads --exclude=uploads
cmp -s package-lock.json /opt/template/package-lock.json || npm install --no-audit --no-fund >/dev/null
git add -A
git diff --cached --quiet || git commit -q -m "$1"`;

/** Creates an app for `ownerId` from the template's code. Removes the new app again if the copy fails. */
export async function createFromTemplate(template: Project, ownerId: string): Promise<Project> {
	touch(template.id);
	await ensureSandbox(template);
	const files = await execArgv(template, ["git", "archive", "--format=tar", "main"], { timeoutMs: 120_000 });
	if (files.code !== 0 || files.stdout.length === 0) {
		throw new Error(`Couldn't read the template's code: ${files.stderr.trim() || "no files"}`);
	}
	const project = await createProject(template.name, ownerId);
	try {
		const copy = await execArgv(project, ["bash", "-c", COPY_SCRIPT, "copy", `Start from the ${template.name} template`], {
			input: files.stdout,
			timeoutMs: 10 * 60_000,
		});
		if (copy.code !== 0) throw new Error(`Couldn't copy the template: ${copy.stderr.trim() || `exit ${copy.code}`}`);
	} catch (error) {
		await deleteProject(project).catch(() => {});
		throw error;
	}
	return project;
}
