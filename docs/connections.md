# Connecting your data

[Back to the README](../README.md)

Under **Settings > Connections**, an admin picks a type and gives it a short name that code uses (`crm`, `drive`, ...):

| Source | Type | What to enter |
|---|---|---|
| Postgres | Postgres | Connection string; use a read-only database role |
| Supabase | Supabase | Session pooler connection string from Project Settings > Database |
| AWS RDS / Aurora Postgres | AWS RDS | Endpoint connection string; allow the EC2 security group in the RDS security group |
| Google Drive and Sheets | Google Drive and Sheets (built in) | Client ID and secret of a Google Cloud OAuth client (Web application), then **Connect** |
| Salesforce | Salesforce (built in) | Consumer key (and secret) of an External Client App or Connected App, then **Connect** |
| monday.com, Notion, Linear | Their template | Nothing: **Connect** signs in to the vendor's MCP server (monday.com also takes an API token) |
| Other SaaS with an MCP server | Other MCP server (URL) | The streamable HTTP MCP endpoint, then either OAuth sign-in or an `Authorization` header |
| Any MCP server published on npm | MCP server (command) | For example `npx -y <package>` plus its environment variables |

Connections that sign in show the redirect URI to register with the provider: `https://<your-domain>/oauth/callback`. The admin who clicks **Connect** signs in once for the whole organization, so use an account (ideally a read-only integration user) whose data every app may see. Tokens are stored encrypted and refreshed automatically. For MCP servers the platform follows the MCP authorization spec: it discovers the authorization server and registers itself, so a client ID is only needed for servers that don't allow dynamic registration.

Connections are read-only by default. Built-in connectors mark which tools change data; for MCP connectors, tools whose names start with create, update, delete, send, append and similar verbs are refused unless writes are allowed. For Google Drive the choice also decides the scopes requested at sign-in.

Each connection is available to all apps, or only to the apps an admin picks (the link under the connection). The agent and the gateway only see the connections shared with their app.
