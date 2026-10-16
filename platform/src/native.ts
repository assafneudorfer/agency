// Built-in connectors for services without a dependable MCP server: Google Drive (with Sheets) and Salesforce.
// They sign in with plain OAuth 2.0 and expose MCP-shaped tools, so the agent and apps use them exactly like an MCP connection.

import { loadOAuth, type OAuthClient, refreshTokens, saveOAuth, type StoredTokens } from "./oauth.ts";

export type NativeKind = "google_drive" | "salesforce";

export interface GoogleDriveConfig {
	clientId: string;
	clientSecret: string;
}

export interface SalesforceConfig {
	clientId: string;
	clientSecret?: string;
	/** https://login.salesforce.com, https://test.salesforce.com for a sandbox, or the org's My Domain URL. */
	loginUrl?: string;
}

export type NativeConfig = GoogleDriveConfig | SalesforceConfig;

export interface NativeConnection {
	id: string;
	name: string;
	kind: NativeKind;
	allowWrite: boolean;
	config: NativeConfig;
}

type Json = Record<string, unknown>;

interface Api {
	/** Fetches a URL with the connection's access token, refreshing it once when it has expired. */
	request(url: string, init?: RequestInit): Promise<Response>;
	json<T = Json>(url: string, init?: RequestInit): Promise<T>;
	tokens: StoredTokens;
}

interface NativeTool {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
	write?: boolean;
	run(api: Api, args: Json): Promise<unknown>;
}

interface Provider {
	oauthClient(config: NativeConfig, allowWrite: boolean): OAuthClient;
	/** A label for the signed-in account, shown on the Connections page. */
	account(api: Api, tokenResponse: Json): Promise<string>;
	tools: NativeTool[];
}

class ApiError extends Error {}

function str(args: Json, key: string, required = true): string {
	const value = args[key];
	if (typeof value === "string" && value.trim()) return value.trim();
	if (required) throw new ApiError(`"${key}" is required`);
	return "";
}

function num(args: Json, key: string, fallback: number, max: number): number {
	const value = Number(args[key]);
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(Math.floor(value), max);
}

function rows(args: Json, key: string): unknown[][] {
	const value = args[key];
	if (!Array.isArray(value) || !value.every(Array.isArray)) throw new ApiError(`"${key}" must be a list of rows, each a list of cell values`);
	return value as unknown[][];
}

async function failure(response: Response): Promise<never> {
	const text = await response.text();
	let message = text.slice(0, 500);
	try {
		const data = JSON.parse(text);
		const first = Array.isArray(data) ? data[0] : data;
		message = first?.error?.message ?? first?.message ?? first?.error_description ?? message;
	} catch {}
	throw new ApiError(`${response.status}: ${message}`);
}

// ---------------------------------------------------------------------------
// Google Drive and Sheets

const DRIVE = "https://www.googleapis.com/drive/v3";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const EXPORTS: Record<string, string> = {
	"application/vnd.google-apps.document": "text/plain",
	"application/vnd.google-apps.spreadsheet": "text/csv",
	"application/vnd.google-apps.presentation": "text/plain",
};

function driveQuote(value: string): string {
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function isText(mimeType: string): boolean {
	return /^text\/|json|csv|xml|javascript|yaml/.test(mimeType);
}

const googleDrive: Provider = {
	oauthClient(config, allowWrite) {
		const cfg = config as GoogleDriveConfig;
		const scopes = allowWrite
			? ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets"]
			: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/spreadsheets.readonly"];
		return {
			authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			clientId: cfg.clientId,
			clientSecret: cfg.clientSecret,
			scope: ["openid", "email", ...scopes].join(" "),
			// offline + consent: Google only returns a refresh token on a fresh consent.
			extraParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
		};
	},
	async account(api) {
		const about = await api.json<{ user?: { emailAddress?: string; displayName?: string } }>(`${DRIVE}/about?fields=user`);
		return about.user?.emailAddress ?? about.user?.displayName ?? "";
	},
	tools: [
		{
			name: "search_files",
			description:
				"Find files in Google Drive (including shared drives), newest first. Matches names and file contents. Returns id, name, mimeType, modifiedTime, owners and webViewLink.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "Words to look for in file names and contents" },
					mimeType: {
						type: "string",
						description:
							"Only this type, e.g. application/vnd.google-apps.spreadsheet, application/vnd.google-apps.document, application/vnd.google-apps.folder, application/pdf",
					},
					folderId: { type: "string", description: "Only files directly inside this folder" },
					limit: { type: "number", description: "At most this many files (default 25, max 100)" },
				},
			},
			async run(api, args) {
				const terms = ["trashed = false"];
				const text = str(args, "query", false);
				if (text) terms.push(`(name contains ${driveQuote(text)} or fullText contains ${driveQuote(text)})`);
				const mimeType = str(args, "mimeType", false);
				if (mimeType) terms.push(`mimeType = ${driveQuote(mimeType)}`);
				const folderId = str(args, "folderId", false);
				if (folderId) terms.push(`${driveQuote(folderId)} in parents`);
				const url = new URL(`${DRIVE}/files`);
				url.searchParams.set("q", terms.join(" and "));
				url.searchParams.set("pageSize", String(num(args, "limit", 25, 100)));
				url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,size,webViewLink,parents,owners(displayName,emailAddress))");
				url.searchParams.set("supportsAllDrives", "true");
				url.searchParams.set("includeItemsFromAllDrives", "true");
				url.searchParams.set("corpora", "allDrives");
				// Drive cannot sort full-text searches.
				if (!text) url.searchParams.set("orderBy", "modifiedTime desc");
				const data = await api.json<{ files: unknown[] }>(url.toString());
				return { files: data.files ?? [] };
			},
		},
		{
			name: "read_file",
			description:
				"Read a Drive file as text: Google Docs and Slides as plain text, the first tab of a Google Sheet as CSV (use read_sheet for other tabs), and text, CSV or JSON files as they are. Other files return their details only.",
			inputSchema: {
				type: "object",
				properties: {
					fileId: { type: "string" },
					maxChars: { type: "number", description: "Cut the text after this many characters (default 100000)" },
				},
				required: ["fileId"],
			},
			async run(api, args) {
				const id = encodeURIComponent(str(args, "fileId"));
				const maxChars = num(args, "maxChars", 100_000, 1_000_000);
				const meta = await api.json<{ id: string; name: string; mimeType: string; size?: string; webViewLink?: string }>(
					`${DRIVE}/files/${id}?fields=id,name,mimeType,size,modifiedTime,webViewLink&supportsAllDrives=true`,
				);
				const exportAs = EXPORTS[meta.mimeType];
				let url: string | undefined;
				if (exportAs) url = `${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`;
				else if (isText(meta.mimeType)) url = `${DRIVE}/files/${id}?alt=media&supportsAllDrives=true`;
				if (!url) return { ...meta, text: null, note: "This file type can't be read as text." };
				const response = await api.request(url);
				if (!response.ok) await failure(response);
				const text = await response.text();
				return { ...meta, text: text.slice(0, maxChars), truncated: text.length > maxChars };
			},
		},
		{
			name: "read_sheet",
			description:
				"Read cell values from a Google Sheet. Without a range, returns the tab names and the first tab's values. The first row is usually the header.",
			inputSchema: {
				type: "object",
				properties: {
					spreadsheetId: { type: "string", description: "The file id from search_files" },
					range: { type: "string", description: "A1 range such as 'Deals'!A1:F500 or a tab name. Optional." },
				},
				required: ["spreadsheetId"],
			},
			async run(api, args) {
				const id = encodeURIComponent(str(args, "spreadsheetId"));
				const meta = await api.json<{ properties: { title: string }; sheets: { properties: { title: string } }[] }>(
					`${SHEETS}/${id}?fields=properties.title,sheets.properties.title`,
				);
				const tabs = meta.sheets.map((s) => s.properties.title);
				const range = str(args, "range", false) || `'${(tabs[0] ?? "Sheet1").replace(/'/g, "''")}'`;
				const values = await api.json<{ range: string; values?: unknown[][] }>(
					`${SHEETS}/${id}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`,
				);
				return { title: meta.properties.title, tabs, range: values.range, values: values.values ?? [] };
			},
		},
		{
			name: "append_sheet_rows",
			description: "Add rows after the last row of a table in a Google Sheet. Values are entered as if typed (formulas and dates work).",
			write: true,
			inputSchema: {
				type: "object",
				properties: {
					spreadsheetId: { type: "string" },
					range: { type: "string", description: "The table's tab or range, e.g. 'Leads'!A:F" },
					rows: { type: "array", items: { type: "array" }, description: "Rows to add, each a list of cell values" },
				},
				required: ["spreadsheetId", "range", "rows"],
			},
			async run(api, args) {
				const url = `${SHEETS}/${encodeURIComponent(str(args, "spreadsheetId"))}/values/${encodeURIComponent(str(args, "range"))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
				return api.json(url, { method: "POST", body: JSON.stringify({ values: rows(args, "rows") }) });
			},
		},
		{
			name: "update_sheet_range",
			description: "Overwrite the cells of a range in a Google Sheet. Values are entered as if typed.",
			write: true,
			inputSchema: {
				type: "object",
				properties: {
					spreadsheetId: { type: "string" },
					range: { type: "string", description: "A1 range such as 'Leads'!B7:D7" },
					rows: { type: "array", items: { type: "array" } },
				},
				required: ["spreadsheetId", "range", "rows"],
			},
			async run(api, args) {
				const url = `${SHEETS}/${encodeURIComponent(str(args, "spreadsheetId"))}/values/${encodeURIComponent(str(args, "range"))}?valueInputOption=USER_ENTERED`;
				return api.json(url, { method: "PUT", body: JSON.stringify({ values: rows(args, "rows") }) });
			},
		},
	],
};

// ---------------------------------------------------------------------------
// Salesforce

const SF_VERSION = "v62.0";
const SOBJECT = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const RECORD_ID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;

function loginUrl(config: NativeConfig): string {
	return ((config as SalesforceConfig).loginUrl || "https://login.salesforce.com").replace(/\/+$/, "");
}

function sfBase(api: Api): string {
	if (!api.tokens.instance_url) throw new ApiError("Salesforce did not return the org's address. Sign in again.");
	return `${api.tokens.instance_url}/services/data/${SF_VERSION}`;
}

function sobject(args: Json): string {
	const name = str(args, "object");
	if (!SOBJECT.test(name)) throw new ApiError(`"${name}" is not an object API name`);
	return name;
}

/** Drops the "attributes" Salesforce adds to every record, at every nesting level. */
function clean(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(clean);
	if (value && typeof value === "object") {
		const out: Json = {};
		for (const [key, inner] of Object.entries(value)) if (key !== "attributes") out[key] = clean(inner);
		return out;
	}
	return value;
}

const salesforce: Provider = {
	oauthClient(config) {
		const cfg = config as SalesforceConfig;
		return {
			authUrl: `${loginUrl(cfg)}/services/oauth2/authorize`,
			tokenUrl: `${loginUrl(cfg)}/services/oauth2/token`,
			clientId: cfg.clientId,
			clientSecret: cfg.clientSecret || undefined,
			scope: "api refresh_token",
		};
	},
	async account(api) {
		const info = await api.json<{ preferred_username?: string; email?: string }>(`${api.tokens.instance_url}/services/oauth2/userinfo`);
		return info.preferred_username ?? info.email ?? "";
	},
	tools: [
		{
			name: "list_objects",
			description: "List the Salesforce objects that can be queried (Account, Opportunity, custom objects ending in __c, ...).",
			inputSchema: { type: "object", properties: { search: { type: "string", description: "Only names or labels containing this" } } },
			async run(api, args) {
				const data = await api.json<{ sobjects: { name: string; label: string; custom: boolean; queryable: boolean }[] }>(
					`${sfBase(api)}/sobjects`,
				);
				const search = str(args, "search", false).toLowerCase();
				const objects = data.sobjects
					.filter((o) => o.queryable)
					.filter((o) => !search || o.name.toLowerCase().includes(search) || o.label.toLowerCase().includes(search))
					.map(({ name, label, custom }) => ({ name, label, custom }));
				return { objects };
			},
		},
		{
			name: "describe_object",
			description: "Show an object's fields: API name, label, type, related objects and picklist values. Use before writing SOQL.",
			inputSchema: { type: "object", properties: { object: { type: "string", description: "API name, e.g. Opportunity" } }, required: ["object"] },
			async run(api, args) {
				const data = await api.json<{
					name: string;
					label: string;
					fields: {
						name: string;
						label: string;
						type: string;
						referenceTo: string[];
						relationshipName: string | null;
						nillable: boolean;
						picklistValues: { value: string; active: boolean }[];
					}[];
				}>(`${sfBase(api)}/sobjects/${sobject(args)}/describe`);
				return {
					name: data.name,
					label: data.label,
					fields: data.fields.map((f) => ({
						name: f.name,
						label: f.label,
						type: f.type,
						...(f.referenceTo.length ? { referenceTo: f.referenceTo, relationshipName: f.relationshipName } : {}),
						...(f.picklistValues.length
							? { picklistValues: f.picklistValues.filter((p) => p.active).map((p) => p.value).slice(0, 50) }
							: {}),
					})),
				};
			},
		},
		{
			name: "query",
			description:
				"Run a SOQL query, e.g. SELECT Id, Name, Amount, StageName, CloseDate, Account.Name FROM Opportunity WHERE IsClosed = false ORDER BY CloseDate. Follows pages up to the limit.",
			inputSchema: {
				type: "object",
				properties: { soql: { type: "string" }, limit: { type: "number", description: "At most this many records (default 2000, max 10000)" } },
				required: ["soql"],
			},
			async run(api, args) {
				const limit = num(args, "limit", 2000, 10_000);
				let page = await api.json<{ totalSize: number; done: boolean; records: unknown[]; nextRecordsUrl?: string }>(
					`${sfBase(api)}/query?q=${encodeURIComponent(str(args, "soql"))}`,
				);
				const records = [...page.records];
				while (!page.done && page.nextRecordsUrl && records.length < limit) {
					page = await api.json(`${api.tokens.instance_url}${page.nextRecordsUrl}`);
					records.push(...page.records);
				}
				return { totalSize: page.totalSize, records: clean(records.slice(0, limit)), truncated: records.length > limit || !page.done };
			},
		},
		{
			name: "search",
			description: "Full-text search across objects with SOSL, e.g. FIND {Acme} IN ALL FIELDS RETURNING Account(Id, Name), Contact(Id, Name, Email).",
			inputSchema: { type: "object", properties: { sosl: { type: "string" } }, required: ["sosl"] },
			async run(api, args) {
				const data = await api.json<{ searchRecords: unknown[] }>(`${sfBase(api)}/search?q=${encodeURIComponent(str(args, "sosl"))}`);
				return { records: clean(data.searchRecords ?? []) };
			},
		},
		{
			name: "create_record",
			description: "Create a record, e.g. object Task with fields { Subject, WhatId, ActivityDate }. Returns the new id.",
			write: true,
			inputSchema: {
				type: "object",
				properties: { object: { type: "string" }, fields: { type: "object" } },
				required: ["object", "fields"],
			},
			async run(api, args) {
				return api.json(`${sfBase(api)}/sobjects/${sobject(args)}`, { method: "POST", body: JSON.stringify(args.fields ?? {}) });
			},
		},
		{
			name: "update_record",
			description: "Change fields of an existing record.",
			write: true,
			inputSchema: {
				type: "object",
				properties: { object: { type: "string" }, id: { type: "string" }, fields: { type: "object" } },
				required: ["object", "id", "fields"],
			},
			async run(api, args) {
				const id = str(args, "id");
				if (!RECORD_ID.test(id)) throw new ApiError(`"${id}" is not a record id`);
				const response = await api.request(`${sfBase(api)}/sobjects/${sobject(args)}/${id}`, {
					method: "PATCH",
					body: JSON.stringify(args.fields ?? {}),
				});
				if (!response.ok) await failure(response);
				return { id, updated: true };
			},
		},
	],
};

const PROVIDERS: Record<NativeKind, Provider> = { google_drive: googleDrive, salesforce };

export function isNativeKind(kind: string): kind is NativeKind {
	return kind in PROVIDERS;
}

export function nativeOAuthClient(conn: NativeConnection): OAuthClient {
	return PROVIDERS[conn.kind].oauthClient(conn.config, conn.allowWrite);
}

function apiFor(conn: NativeConnection, initial: StoredTokens): Api {
	let tokens = initial;
	const client = nativeOAuthClient(conn);
	const refresh = async () => {
		tokens = await refreshTokens(client, tokens);
		api.tokens = tokens;
		await saveOAuth(conn.id, { tokens });
	};
	const api: Api = {
		tokens,
		async request(url, init = {}) {
			if (tokens.expires_at && tokens.expires_at < Date.now() + 60_000) await refresh();
			const send = () =>
				fetch(url, {
					...init,
					headers: {
						Accept: "application/json",
						...(init.body ? { "Content-Type": "application/json" } : {}),
						...(init.headers as Record<string, string>),
						Authorization: `Bearer ${tokens.access_token}`,
					},
				});
			let response = await send();
			if (response.status === 401 && tokens.refresh_token) {
				await refresh();
				response = await send();
			}
			return response;
		},
		async json(url, init) {
			const response = await api.request(url, init);
			if (!response.ok) await failure(response);
			if (response.status === 204) return {} as never;
			return response.json();
		},
	};
	return api;
}

async function signedInApi(conn: NativeConnection): Promise<Api> {
	const { tokens } = await loadOAuth(conn.id);
	if (!tokens) throw new Error(`Connection "${conn.name}" is not signed in yet. An admin clicks Connect on the Connections page.`);
	return apiFor(conn, tokens);
}

/** Called after the OAuth callback stored new tokens: returns the account label. */
export async function nativeAccount(conn: NativeConnection, tokens: StoredTokens, raw: Json): Promise<string> {
	try {
		return await PROVIDERS[conn.kind].account(apiFor(conn, tokens), raw);
	} catch {
		return "";
	}
}

export function nativeTools(kind: NativeKind) {
	return PROVIDERS[kind].tools.map(({ name, description, inputSchema, write }) => ({
		name,
		description: write ? `${description} (Changes data: needs a connection that allows writes.)` : description,
		inputSchema,
	}));
}

export function nativeToolWrites(kind: NativeKind, tool: string): boolean {
	return Boolean(PROVIDERS[kind].tools.find((t) => t.name === tool)?.write);
}

/** Runs a tool and returns an MCP-style result, so callers handle built-in and MCP connectors the same way. */
export async function callNativeTool(conn: NativeConnection, tool: string, args: Json) {
	const def = PROVIDERS[conn.kind].tools.find((t) => t.name === tool);
	if (!def) throw new Error(`Connection "${conn.name}" has no tool "${tool}"`);
	const api = await signedInApi(conn);
	try {
		const result = await def.run(api, args ?? {});
		return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Json };
	} catch (error) {
		if (error instanceof ApiError) return { content: [{ type: "text" as const, text: error.message }], isError: true };
		throw error;
	}
}

export async function testNative(conn: NativeConnection): Promise<string> {
	const api = await signedInApi(conn);
	const account = await PROVIDERS[conn.kind].account(api, {});
	return `Connected${account ? ` as ${account}` : ""}. ${PROVIDERS[conn.kind].tools.length} tools available.`;
}
