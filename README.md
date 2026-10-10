# Agency

A self-hosted app builder for an organization's team, built on the pi coding agent in this repository. Someone describes an app in plain language, pi builds it as a Next.js project in a sandbox container, the live preview updates beside the chat, and one click publishes it to `https://<app>.<your-domain>`. Apps read the organization's data (Postgres, Supabase, AWS RDS, and MCP connectors such as Google Drive, Monday or Salesforce) through a gateway, so credentials never enter app code.

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

- **Platform** (`platform/`): Node 22 + Hono, TypeScript run directly with Node's type stripping, UI in Preact + htm with no build step. It manages users, projects, connections and deployments, and drives Docker through the socket.
- **Sandbox** (`sandbox/`): one container per app with the Next.js template and pi built from this repository. The platform runs `pi --mode rpc` inside it with `docker exec` and streams pi's events to the browser. Every finished agent turn is a git commit, so any version can be restored.
- **Connectors**: admins add connections once. pi uses the platform's MCP endpoint (`list_connections`, `describe_connection`, `run_query`, `call_connector_tool`) while building; generated code calls `lib/agency.ts`, which posts to `/gateway` with the app's token. Postgres connections run read-only transactions unless an admin allows writes.
- **Publishing**: `next build` in the sandbox, the standalone output is streamed into `docker build`, and the new image replaces the app container. Earlier versions stay as images for rollback.
- **Access**: previews and published apps sit behind Traefik forward auth, so only signed-in team members can open them. SSO is the next feature (see the plan).

## Deploy on AWS with Cloudflare DNS

Requirements: an AWS account with the AWS CLI signed in, a Cloudflare zone for your domain, Terraform 1.6+, and a Claude API key.

1. Create a Cloudflare API token with **Zone > DNS > Edit** on the zone.
2. Run the deploy script and answer its questions:

   ```bash
   cd agency/infra/aws
   ./deploy.sh
   ```

   It asks for the Claude API key, the Cloudflare token and an admin password at hidden prompts (or reads `ANTHROPIC_API_KEY`, `CLOUDFLARE_API_TOKEN` and `ADMIN_PASSWORD` from the environment), checks both keys, finds the Cloudflare zone, shows the Terraform plan and applies it after you confirm. Choose `small` (t3.medium) for testing or `standard` (t3.xlarge) for the team.
3. The server builds the images and starts the stack on first boot. The script waits until the site answers, then you sign in with the admin email and password.

Secrets never go into files or command lines from the script; they reach the server only through an encrypted SSM SecureString. Terraform state does contain them, so `terraform.tfstate` stays private on your machine (mode 600). `./deploy.sh update` redeploys the latest code on the branch, and `./deploy.sh destroy` removes everything.

This creates one EC2 instance (`t3.medium` with 40 GB or `t3.xlarge` with 100 GB, encrypted gp3, plus 4 GB swap) with an Elastic IP, a security group for 80/443, an IAM role for Session Manager, the `.env` as a SecureString in SSM Parameter Store, and two Cloudflare A records (`base_domain` and `*.base_domain`). Records are DNS-only by default: Cloudflare's free edge certificate does not cover a second-level wildcard such as `*.agency.example.com`, while Traefik's Let's Encrypt wildcard does. Set `cloudflare_proxied = true` only if the base domain is the zone apex or the zone has Advanced Certificate Manager.


## Run locally

`localtest.me` and all its subdomains resolve to 127.0.0.1, so the full flow works on a laptop over plain HTTP:

```bash
cd agency
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
