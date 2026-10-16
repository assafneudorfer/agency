import { decryptJson, encryptJson } from "./crypto.ts";
import { query, queryOne } from "./db.ts";

/** Organization-wide settings an admin changes in the UI (SSO, GitHub). Values are encrypted: they hold secrets. */
export async function getSetting<T>(key: string): Promise<T | undefined> {
	const row = await queryOne<{ value_enc: string }>("select value_enc from settings where key = $1", [key]);
	return row ? decryptJson<T>(row.value_enc) : undefined;
}

export async function putSetting(key: string, value: unknown): Promise<void> {
	await query(
		"insert into settings (key, value_enc) values ($1, $2) on conflict (key) do update set value_enc = excluded.value_enc, updated_at = now()",
		[key, encryptJson(value)],
	);
}

export async function deleteSetting(key: string): Promise<void> {
	await query("delete from settings where key = $1", [key]);
}
