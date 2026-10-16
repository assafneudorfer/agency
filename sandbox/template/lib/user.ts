// The signed-in team member who is using the app. Every request reaches the app through the platform's
// sign-in check, which sets these headers (and drops any the browser tried to send).
// Only call this from Server Components, Route Handlers or Server Actions.
import { headers } from "next/headers";

export interface AppUser {
	id: string;
	email: string;
	name: string;
	role: "admin" | "member";
}

/** Returns the signed-in user, or null when the request did not come through the platform (for example a build step). */
export async function currentUser(): Promise<AppUser | null> {
	const h = await headers();
	const email = h.get("x-agency-user");
	if (!email) return null;
	let name = email;
	try {
		name = decodeURIComponent(h.get("x-agency-user-name") ?? "") || email;
	} catch {}
	return {
		id: h.get("x-agency-user-id") ?? email,
		email,
		name,
		role: h.get("x-agency-user-role") === "admin" ? "admin" : "member",
	};
}

/** Like currentUser, but throws when nobody is signed in. */
export async function requireUser(): Promise<AppUser> {
	const user = await currentUser();
	if (!user) throw new Error("Not signed in");
	return user;
}
