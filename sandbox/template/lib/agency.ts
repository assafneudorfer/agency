// Server-side access to the organization's data connections through the Agency gateway.
// Credentials never live in this app: the gateway holds them and checks AGENCY_APP_TOKEN.
// Only import this from Server Components, Route Handlers or Server Actions.

const gatewayUrl = process.env.AGENCY_GATEWAY_URL;
const token = process.env.AGENCY_APP_TOKEN;

async function post<T>(path: string, body: unknown): Promise<T> {
	if (!gatewayUrl || !token) throw new Error("AGENCY_GATEWAY_URL and AGENCY_APP_TOKEN must be set");
	const response = await fetch(`${gatewayUrl}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
		cache: "no-store",
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error ?? `Gateway request failed (${response.status})`);
	return data as T;
}

export interface QueryResult<Row> {
	columns: string[];
	rows: Row[];
	rowCount: number;
	truncated: boolean;
}

/** Runs one parameterized SQL statement on a postgres connection, for example query("crm", "select * from deals where stage = $1", ["open"]). */
export async function query<Row = Record<string, unknown>>(
	connection: string,
	sql: string,
	params: unknown[] = [],
): Promise<Row[]> {
	const result = await post<QueryResult<Row>>("/query", { connection, sql, params });
	return result.rows;
}

export interface ToolResult {
	content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
	structuredContent?: unknown;
	isError?: boolean;
}

/** Calls a tool on an MCP connection (Google Drive, Monday, Salesforce, ...). */
export async function callTool(connection: string, tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
	return post<ToolResult>("/tool", { connection, tool, arguments: args });
}

/** Returns the text of a tool result, parsed as JSON when it is JSON. */
export function toolData<T = unknown>(result: ToolResult): T | string {
	if (result.structuredContent !== undefined) return result.structuredContent as T;
	const text = (result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	try {
		return JSON.parse(text) as T;
	} catch {
		return text;
	}
}
