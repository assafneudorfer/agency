# How Agency works

[Back to the README](../README.md)

```
          Cloudflare or Route 53 DNS: agency.example.com and *.agency.example.com -> EC2
                                          |
                                     Traefik (TLS, wildcard cert via a DNS challenge)
            ______________________________|______________________________________
           |                              |                                      |
   agency.example.com            crm-preview.agency.example.com         crm.agency.example.com
   platform (UI + API)           sandbox container per app              published app container
     |  docker exec pi --mode rpc   - Next.js dev server :3000            - production build :3000
     |------------------------->    - pi coding agent edits /workspace    - versioned image per publish
     |
     |  /mcp     <- pi inside the sandbox reads schemas and samples data
     |  /gateway <- apps query data with their project token
     |
   Postgres: platform state + one database per app
   Connections: org databases and MCP servers (credentials encrypted, only the platform holds them)
```

- **Platform** (`platform/`): Node 22 + Hono, TypeScript run directly with Node's type stripping, UI in Preact + htm with no build step; the code editor is CodeMirror 6, served as ES modules straight from `node_modules`. It manages users, projects, connections and deployments, and drives Docker through the socket.
- **Sandbox** (`sandbox/`): one container per app with the Next.js template and pi installed from npm (version pinned by `PI_VERSION` in `sandbox/Dockerfile`). The platform runs `pi --mode rpc` inside it with `docker exec` and streams pi's events to the browser. Every finished agent turn is a git commit, so any version can be restored. The builder's **Code** tab shows the app's files and lets you edit them in the browser; each save writes the file into the sandbox, commits it as a version and reloads the preview.
- **Connectors**: admins add connections once. pi uses the platform's MCP endpoint (`list_connections`, `describe_connection`, `run_query`, `call_connector_tool`) while building; generated code calls `lib/agency.ts`, which posts to `/gateway` with the app's token. Postgres connections run read-only transactions unless an admin allows writes.
- **Publishing**: `next build` in the sandbox, the standalone output is streamed into `docker build`, and the new image replaces the app container. Earlier versions stay as images for rollback.
- **App databases**: every app gets its own Postgres database and login role on the platform's Postgres, so it costs no extra memory. The preview (and the coding agent) use one database and the published app another, created on the first publish: experiments while building never touch live data. A new app's live database starts empty and the app creates its tables from `lib/schema.ts`; an app published before this split starts with a copy of its existing data. The builder's **Data** tab lists both databases' tables, edits rows in place, adds and deletes rows, and runs SQL. Anyone can change preview data; live data takes the app's owner or an admin, and other members get read-only SQL.
- **Who is using an app**: Traefik's forward auth passes the signed-in member to every preview and published app as `X-Agency-User`, `X-Agency-User-Id`, `X-Agency-User-Name` (URL-encoded) and `X-Agency-User-Role`, replacing any the browser sent. Generated apps read them with `currentUser()` from `lib/user.ts`, for "my items" views or recording who changed a row.
- **Usage and budgets**: the cost of every message the agent writes (tokens at the model's list price) is charged to the user who sent the prompt. Each user has a monthly budget in US dollars, or is unlimited; when it is used up, new prompts are refused until an admin raises it or the month resets (the running step still finishes). Everyone sees their spend under **Settings > Usage** and in the sidebar; admins set budgets under **Settings > Team**. New members get `AGENCY_DEFAULT_BUDGET_USD` (20 by default); admins that existed before budgets start unlimited.
- **Access**: previews and published apps sit behind Traefik forward auth, so only signed-in team members can open them, and each app's sharing settings decide who may view or edit it. With single sign-on on, only the organization's people can sign in at all.
