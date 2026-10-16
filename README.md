<p align="center"><img src="docs/brand/logo.png" width="96" height="96" alt="Agency logo" /></p>

# Agency

A self-hosted app builder for an organization's team, built on the [pi](https://github.com/earendil-works/pi) coding agent. Someone describes an app in plain language, pi builds it as a Next.js project in a sandbox container, the live preview updates beside the chat, and one click publishes it to `https://<app>.<your-domain>`. Apps read the organization's data (Postgres, Supabase, AWS RDS, and MCP connectors such as Google Drive, Monday or Salesforce) through a gateway, so credentials never enter app code.

See [PLAN.md](PLAN.md) for the roadmap.

## How it works

```
                 Cloudflare DNS: agency.example.com and *.agency.example.com -> EC2
                                          |
                                     Traefik (TLS, wildcard cert via Cloudflare DNS challenge)
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
- **Usage and budgets**: the cost of every message the agent writes (tokens at the model's list price) is charged to the user who sent the prompt. Each user has a monthly budget in US dollars, or is unlimited; when it is used up, new prompts are refused until an admin raises it or the month resets (the running step still finishes). Everyone sees their spend on the **Usage** page and in the sidebar; admins set budgets on the **Team** page. New members get `AGENCY_DEFAULT_BUDGET_USD` (20 by default); admins that existed before budgets start unlimited.
- **Access**: previews and published apps sit behind Traefik forward auth, so only signed-in team members can open them. SSO is the next feature (see the plan).

## Deploy on AWS with Cloudflare DNS

Requirements: an AWS account with the AWS CLI signed in, a Cloudflare zone for your domain, Terraform 1.6+, and a Claude API key.

1. Create a Cloudflare API token with **Zone > DNS > Edit** on the zone.
2. Run the deploy script and answer its questions:

   ```bash
   cd infra/aws
   ./deploy.sh
   ```

   It asks for the Claude API key, the Cloudflare token and an admin password at hidden prompts (or reads `ANTHROPIC_API_KEY`, `CLOUDFLARE_API_TOKEN` and `ADMIN_PASSWORD` from the environment), checks both keys, finds the Cloudflare zone, shows the Terraform plan and applies it after you confirm. Choose `small` (t3.medium) for testing or `standard` (t3.xlarge) for the team.
3. The server builds the images and starts the stack on first boot. The script waits until the site answers, then you sign in with the admin email and password.

Secrets never go into files or command lines from the script; they reach the server only through an encrypted SSM SecureString. Terraform state does contain them, so `terraform.tfstate` stays private on your machine (mode 600). `./deploy.sh update` redeploys the latest code on the branch, and `./deploy.sh destroy` removes everything.

Backups: every night at 03:00 UTC the server dumps all databases (platform state and every app's preview and live data) with `pg_dumpall`, keeps the last 7 dumps in `/var/backups/agency`, and uploads each to a private S3 bucket that deletes them after 30 days (`backup_retention_days`). A run missed while the server was stopped happens right after it starts. `./deploy.sh backup` runs one now. To restore, open a shell on the server (`terraform output -raw shell`) and load a dump. This replaces all current data, so the platform and app containers are stopped while it runs:

```bash
cd /opt/agency-src
docker compose stop platform && docker ps -q --filter label=agency.project | xargs -r docker stop
aws s3 cp s3://<backup bucket>/postgres/<file>.sql.gz - | gunzip | docker compose exec -T postgres psql -U agency -d postgres
docker compose start platform && docker ps -aq --filter label=agency.project | xargs -r docker start
```

A few "cannot drop" notices about the current user are expected.

To save money when nobody is using it, `./deploy.sh stop` stops the server and `./deploy.sh start` brings it back with the same address, data and apps (`./deploy.sh status` shows which). Rough on-demand cost in us-east-1 with `small`: about $37 a month running all the time (instance about $30, disk $3.20, public IP $3.65), and about $7 a month while stopped (disk and public IP only). Claude API usage is billed separately by Anthropic.

This creates one EC2 instance (`t3.medium` with 40 GB or `t3.xlarge` with 100 GB, encrypted gp3, plus 4 GB swap) with an Elastic IP, a security group for 80/443, an IAM role for Session Manager, a private S3 bucket for backups, the `.env` as a SecureString in SSM Parameter Store, and two Cloudflare A records (`base_domain` and `*.base_domain`). Records are DNS-only by default: Cloudflare's free edge certificate does not cover a second-level wildcard such as `*.agency.example.com`, while Traefik's Let's Encrypt wildcard does. Set `cloudflare_proxied = true` only if the base domain is the zone apex or the zone has Advanced Certificate Manager.


## Run locally

`localtest.me` and all its subdomains resolve to 127.0.0.1, so the full flow works on a laptop over plain HTTP:

```bash
cp .env.example .env   # set AGENCY_BASE_DOMAIN=localtest.me, secrets and an LLM key
docker compose --profile build build sandbox
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
open http://localtest.me
```

## Adding connections

Under **Connections**, an admin picks a type and gives it a short name that code uses (`crm`, `drive`, ...):

| Source | Type | What to enter |
|---|---|---|
| Postgres | Postgres | Connection string; use a read-only database role |
| Supabase | Supabase | Session pooler connection string from Project Settings > Database |
| AWS RDS / Aurora Postgres | AWS RDS | Endpoint connection string; allow the EC2 security group in the RDS security group |
| Monday, Salesforce, Google Drive, other SaaS | MCP server (URL) | The vendor's streamable HTTP MCP endpoint and an `Authorization` header |
| Any MCP server published on npm | MCP server (command) | For example `npx -y <package>` plus its environment variables |

Connections are read-only by default. For MCP connectors, tools whose names start with create, update, delete, send and similar verbs are refused unless writes are allowed.

## Security notes for this MVP

- The platform container mounts the Docker socket, which is root-equivalent on the host. Keep the host dedicated to Agency.
- LLM keys are passed to pi with `docker exec -e` for each session, so they are visible inside sandboxes while the agent runs, never in published apps.
- All signed-in members see all apps and connections. Per-project connection access and SSO are planned.
- The user headers are trustworthy for requests that come through Traefik. Containers on the internal Docker network (sandboxes included) can reach app containers directly and could set them, so don't base admin-only actions in apps on them alone until sandboxes get an egress allowlist.
