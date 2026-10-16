import type { User } from "./auth.ts";
import { query, queryOne } from "./db.ts";
import type { Project } from "./projects.ts";

/**
 * What someone can do with an app. viewer: open the preview and the published app, read the builder.
 * editor: also prompt the agent, edit code and preview data, publish. owner: also share, change live data
 * and delete. The app's creator and admins are owners.
 */
export type ProjectRole = "viewer" | "editor" | "owner";
export type TeamAccess = "none" | "viewer" | "editor";

const RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };

export class AccessError extends Error {}

export function atLeast(role: ProjectRole | null, needed: ProjectRole): boolean {
	return role !== null && RANK[role] >= RANK[needed];
}

export async function projectRole(user: User, project: Project): Promise<ProjectRole | null> {
	if (user.role === "admin" || user.id === project.owner_id) return "owner";
	const member = await queryOne<{ role: "viewer" | "editor" }>(
		"select role from project_members where project_id = $1 and user_id = $2",
		[project.id, user.id],
	);
	const team = project.team_access === "none" ? null : project.team_access;
	const roles = [member?.role, team].filter((r): r is "viewer" | "editor" => Boolean(r));
	if (roles.length === 0) return null;
	return roles.includes("editor") ? "editor" : "viewer";
}

export async function assertRole(user: User, project: Project, needed: ProjectRole): Promise<ProjectRole> {
	const role = await projectRole(user, project);
	if (!role) throw new AccessError("You don't have access to this app. Ask its owner to share it with you.");
	if (!atLeast(role, needed)) {
		throw new AccessError(
			needed === "owner"
				? "Only the app's owner or an admin can do this"
				: "You can view this app but not change it. Ask its owner for edit access.",
		);
	}
	return role;
}

/** Projects the user can at least view, newest first. */
export async function visibleProjects(user: User): Promise<Project[]> {
	if (user.role === "admin") return query<Project>("select * from projects order by created_at desc");
	return query<Project>(
		`select p.* from projects p
		 where p.owner_id = $1 or p.team_access <> 'none'
		    or exists (select 1 from project_members m where m.project_id = p.id and m.user_id = $1)
		 order by p.created_at desc`,
		[user.id],
	);
}

export interface Sharing {
	owner: { id: string; email: string; name: string };
	teamAccess: TeamAccess;
	members: { userId: string; email: string; name: string; role: "viewer" | "editor" }[];
}

export async function getSharing(project: Project): Promise<Sharing> {
	const [owner, members] = await Promise.all([
		queryOne<{ id: string; email: string; name: string }>("select id, email, name from users where id = $1", [project.owner_id]),
		query<{ userId: string; email: string; name: string; role: "viewer" | "editor" }>(
			`select u.id as "userId", u.email, u.name, m.role from project_members m join users u on u.id = m.user_id
			 where m.project_id = $1 order by u.email`,
			[project.id],
		),
	]);
	return { owner: owner ?? { id: project.owner_id, email: "", name: "" }, teamAccess: project.team_access, members };
}

export async function setTeamAccess(project: Project, access: string): Promise<void> {
	if (!["none", "viewer", "editor"].includes(access)) throw new AccessError("Unknown access level");
	await query("update projects set team_access = $2 where id = $1", [project.id, access]);
}

export async function setMember(project: Project, userId: string, role: string | null): Promise<void> {
	if (role === null) {
		await query("delete from project_members where project_id = $1 and user_id = $2", [project.id, userId]);
		return;
	}
	if (role !== "viewer" && role !== "editor") throw new AccessError("Role must be viewer or editor");
	if (userId === project.owner_id) throw new AccessError("The owner already has full access");
	await query(
		`insert into project_members (project_id, user_id, role) values ($1, $2, $3)
		 on conflict (project_id, user_id) do update set role = excluded.role`,
		[project.id, userId, role],
	);
}

/**
 * Maps a preview or app host name to its project. Slugs never end in "-preview" (see uniqueSlug),
 * so "<slug>-preview.<domain>" is always a preview and "<slug>.<domain>" a published app.
 */
export function slugFromHost(host: string, baseDomain: string): string | undefined {
	const name = host.split(":")[0].toLowerCase();
	const suffix = `.${baseDomain.toLowerCase()}`;
	if (!name.endsWith(suffix)) return undefined;
	const sub = name.slice(0, -suffix.length);
	if (!sub || sub.includes(".")) return undefined;
	return sub.endsWith("-preview") ? sub.slice(0, -"-preview".length) : sub;
}
