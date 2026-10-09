import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { callTool, describeConnection, listConnections, runSql } from "./connectors.ts";
import { type Project, projectByToken } from "./projects.ts";

type GatewayEnv = { Variables: { project: Project } };

const requireProjectToken: MiddlewareHandler<GatewayEnv> = async (c, next) => {
	const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
	const project = await projectByToken(token);
	if (!project) return c.json({ error: "Invalid project token" }, 401);
	c.set("project", project);
	await next();
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The data gateway. Generated apps (preview and published) call it with their project token,
 * so organization credentials stay in the platform and never enter app code or containers.
 */
export const gateway = new Hono<GatewayEnv>();
gateway.use("*", requireProjectToken);

gateway.get("/connections", async (c) => c.json(await listConnections()));

gateway.post("/query", async (c) => {
	const body = await c.req.json<{ connection: string; sql: string; params?: unknown[] }>();
	try {
		return c.json(await runSql(body.connection, body.sql, body.params ?? []));
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 400);
	}
});

gateway.post("/tool", async (c) => {
	const body = await c.req.json<{ connection: string; tool: string; arguments?: Record<string, unknown> }>();
	try {
		return c.json(await callTool(body.connection, body.tool, body.arguments ?? {}));
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 400);
	}
});

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }] };
}

function failure(error: unknown) {
	return { content: [{ type: "text" as const, text: errorMessage(error) }], isError: true };
}

function buildMcpServer(): McpServer {
	const server = new McpServer(
		{ name: "agency", version: "0.1.0" },
		{
			instructions:
				"Organization data connectors. Use list_connections, then describe_connection to learn a source's schema or tools before building UI on it. Generated app code reaches the same data through lib/agency.ts.",
		},
	);
	server.registerTool(
		"list_connections",
		{ description: "List the organization's data connections (databases and MCP connectors)." },
		async () => {
			const connections = await listConnections();
			if (connections.length === 0) return text("No connections yet. An admin adds them under Connections.");
			return text(
				connections
					.map(
						(conn) =>
							`- ${conn.name} [${conn.kind}${conn.allowWrite ? ", writes allowed" : ", read-only"}] ${conn.description}`,
					)
					.join("\n"),
			);
		},
	);
	server.registerTool(
		"describe_connection",
		{
			description: "Show a connection's tables and columns (SQL) or its tools and input schemas (MCP).",
			inputSchema: { connection: z.string() },
		},
		async ({ connection }) => {
			try {
				return text(await describeConnection(connection));
			} catch (error) {
				return failure(error);
			}
		},
	);
	server.registerTool(
		"run_query",
		{
			description:
				"Run one SQL statement on a postgres connection to explore data. Read-only unless the connection allows writes. Returns at most 100 rows.",
			inputSchema: { connection: z.string(), sql: z.string(), params: z.array(z.unknown()).optional() },
		},
		async ({ connection, sql, params }) => {
			try {
				const result = await runSql(connection, sql, params ?? [], 100);
				return text(JSON.stringify(result, null, 2));
			} catch (error) {
				return failure(error);
			}
		},
	);
	server.registerTool(
		"call_connector_tool",
		{
			description: "Call a tool on an MCP connection, for example to sample data while building.",
			inputSchema: { connection: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()).optional() },
		},
		async ({ connection, tool, arguments: args }) => {
			try {
				return text(JSON.stringify(await callTool(connection, tool, args ?? {}), null, 2));
			} catch (error) {
				return failure(error);
			}
		},
	);
	return server;
}

/** The MCP endpoint pi connects to from inside a sandbox. Stateless: one server per request. */
export const mcpApp = new Hono<GatewayEnv>();
mcpApp.use("*", requireProjectToken);
mcpApp.all("/", async (c) => {
	const server = buildMcpServer();
	const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
	await server.connect(transport);
	return transport.handleRequest(c.req.raw);
});
