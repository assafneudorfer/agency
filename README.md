<p align="center"><img src="docs/brand/logo.png" width="96" height="96" alt="Agency logo" /></p>

# Agency

A self-hosted app builder for an organization's team, built on the [pi](https://github.com/earendil-works/pi) coding agent. Someone describes an app in plain language, pi builds it as a Next.js project in a sandbox container, the live preview updates beside the chat, and one click publishes it to `https://<app>.<your-domain>`. Apps read the organization's data (Postgres, Supabase, AWS RDS, and MCP connectors such as Google Drive, Monday or Salesforce) through a gateway, so credentials never enter app code.

See [PLAN.md](PLAN.md) for the roadmap.

## How it works

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
- **Models and chat modes**: under **Settings > Organization > Models** an admin sees every Claude model the deploy's provider offers (Claude API or Bedrock), ticks the ones members may use and picks the organization default. Until then only the model the deploy was set up with is allowed. In the builder chat, members pick one of the allowed models and a mode: **Auto** builds right away (the default), **Plan** proposes a plan and waits for "Build this plan", **Chat** answers and discusses without changing files. Plan and Chat give the agent read-only tools (plus the organization data tools).
- **Usage and budgets**: the cost of every message the agent writes (tokens at the model's list price) is charged to the user who sent the prompt. Each user has a monthly budget in US dollars, or is unlimited; when it is used up, new prompts are refused until an admin raises it or the month resets (the running step still finishes). Everyone sees their spend on the **Usage** page and in the sidebar; admins set budgets on the **Team** page. New members get `AGENCY_DEFAULT_BUDGET_USD` (20 by default); admins that existed before budgets start unlimited.
- **Access**: previews and published apps sit behind Traefik forward auth, so only signed-in team members can open them. SSO is the next feature (see the plan).

## Deploy on AWS

The server always runs on AWS. The first run of `./deploy.sh` asks how to set it up:

1. **Cloudflare DNS + Claude API key**: you paste a Cloudflare token and an Anthropic key.
2. **All on AWS**: DNS in Route 53 and Claude on Amazon Bedrock. There are no keys to paste or store: the server's IAM role does everything.

Requirements for both: an AWS account with the AWS CLI signed in, Terraform 1.6+, and a domain.

```bash
cd infra/aws
./deploy.sh
```

It asks for an admin password at a hidden prompt (or reads `ADMIN_PASSWORD`), then the domain, admin email, region and size. Choose `small` (t3.medium) for testing or `standard` (t3.xlarge) for the team. It shows the Terraform plan and applies it after you confirm. The server builds the images and starts the stack on first boot; the script waits until the site answers, then you sign in with the admin email and password.

**Option 1, Cloudflare + Claude API key.** Needs a Cloudflare zone for the domain and a Cloudflare API token with **Zone > DNS > Edit** on it. The script asks for the Claude API key and the token at hidden prompts (or reads `ANTHROPIC_API_KEY` and `CLOUDFLARE_API_TOKEN`), checks both and finds the zone.

**Option 2, all on AWS.** The script finds the domain's public Route 53 hosted zone, or offers to create one (about $0.50 a month). A new zone only works once your domain registrar points the domain's name servers at it: the script prints the four name servers and waits until the change is visible, because Let's Encrypt checks the domain through DNS. Copy any records the domain already has elsewhere (email, other sites) into the zone before switching. It then asks for the Claude model (default: Opus 4.8 through the cross-region profile for the region, for example `amazon-bedrock/us.anthropic.claude-opus-4-8`) and sends it one tiny request with your own AWS sign-in. That first call also turns the model on for the account; if Bedrock refuses, open **Amazon Bedrock > Model catalog** in the console, pick the model, and fill in Anthropic's one-time use case form if it asks.

On the server, two narrow IAM roles do the work: one can only change records in the hosted zone (Traefik's Let's Encrypt DNS challenge), the other can only call Claude models on Bedrock (the coding agent). The host assumes them every 15 minutes and keeps the one-hour credentials under `/var/lib/agency/aws`. pi gets no keys: its AWS profile asks the platform for the current Bedrock credentials with a per-app token only pi holds, so published apps cannot use Bedrock. Usage and budgets work the same, priced at the model's list price. Bedrock usage is billed on your AWS bill.

**Moving a running deployment to all on AWS.** `./deploy.sh use-aws` keeps the server, data, address and certificate. It finds or creates the hosted zone, asks for the Bedrock model, adds the records to Route 53 while Cloudflare keeps serving, waits for the registrar change, then removes the Cloudflare records and redeploys. It asks for the Cloudflare token once more to delete the old records. If you stop it while it waits, run it again.

Secrets never go into files or command lines from the script; they reach the server only through an encrypted SSM SecureString. Terraform state does contain them, so `terraform.tfstate` stays private on your machine (mode 600). `./deploy.sh update` redeploys the latest code on the branch, and `./deploy.sh destroy` removes everything.

Backups: every night at 03:00 UTC the server dumps all databases (platform state and every app's preview and live data) with `pg_dumpall`, keeps the last 7 dumps in `/var/backups/agency`, and uploads each to a private S3 bucket that deletes them after 30 days (`backup_retention_days`). A run missed while the server was stopped happens right after it starts. `./deploy.sh backup` runs one now. To restore, open a shell on the server (`terraform output -raw shell`) and load a dump. This replaces all current data, so the platform and app containers are stopped while it runs:

```bash
cd /opt/agency-src
docker compose stop platform && docker ps -q --filter label=agency.project | xargs -r docker stop
aws s3 cp s3://<backup bucket>/postgres/<file>.sql.gz - | gunzip | docker compose exec -T postgres psql -U agency -d postgres
docker compose start platform && docker ps -aq --filter label=agency.project | xargs -r docker start
```

A few "cannot drop" notices about the current user are expected.

To save money when nobody is using it, `./deploy.sh stop` stops the server and `./deploy.sh start` brings it back with the same address, data and apps (`./deploy.sh status` shows which). Rough on-demand cost in us-east-1 with `small`: about $37 a month running all the time (instance about $30, disk $3.20, public IP $3.65), and about $7 a month while stopped (disk and public IP only). Claude usage is billed separately, by Anthropic or on the AWS bill with Bedrock.

This creates one EC2 instance (`t3.medium` with 40 GB or `t3.xlarge` with 100 GB, encrypted gp3, plus 4 GB swap) with an Elastic IP, a security group for 80/443, an IAM role for Session Manager, a private S3 bucket for backups, the `.env` as a SecureString in SSM Parameter Store, and two A records (`base_domain` and `*.base_domain`) in Cloudflare or Route 53. With the all-AWS setup it also adds the two runtime IAM roles. Cloudflare records are DNS-only by default: Cloudflare's free edge certificate does not cover a second-level wildcard such as `*.agency.example.com`, while Traefik's Let's Encrypt wildcard does. Set `cloudflare_proxied = true` only if the base domain is the zone apex or the zone has Advanced Certificate Manager.


## Run locally

`localtest.me` and all its subdomains resolve to 127.0.0.1, so the full flow works on a laptop over plain HTTP:

```bash
cp .env.example .env   # set AGENCY_BASE_DOMAIN=localtest.me, secrets and an LLM key
docker compose --profile build build sandbox
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
open http://localtest.me
```

## Adding connections

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

## Skills

Skills teach the agent how your organization builds: a design system, a library you use, a checklist. A skill is a folder with a `SKILL.md` in the [Agent Skills](https://agentskills.io/specification) format (frontmatter `name` and `description`, then instructions) plus optional scripts, references and assets. There are two kinds, both under **Settings**:

- **My skills** (Account): each member's own.
- **Skills** (Organization): added by admins and used by every member's builds. Members can see them but not change them.

Add one by:

- **From GitHub**: a link to a repository, a folder, or a `SKILL.md`, for example `https://github.com/anthropics/skills/tree/main/skills/frontend-design`. A link holding several skills imports all of them; importing again (or **Update**) refreshes it. With GitHub connected under Settings, imports use the organization's token, so private repositories in the organization work too.
- **Upload**: a `SKILL.md`, any Markdown file with that frontmatter, or a `.zip`/`.skill` of one or more skill folders.
- **Write**: paste or type a `SKILL.md` in the browser.

When someone sends the agent a message, the platform copies their enabled skills and the organization's enabled skills into the sandbox (`/root/.agency/skills`, outside the app's code) and starts pi with `--skill` for each; a member's own skill replaces an organization skill with the same name. pi lists them to the model by name and description and loads one when the task calls for it. Typing `/skill:name` in the chat forces one. If the next message comes from a member with a different set, the idle agent restarts with theirs, keeping the conversation.

## Settings

Everything that isn't an app lives under **Settings**, grouped like most workspace tools: **Account** (My skills, Usage) and **Organization** (Connections, Skills, and for admins Team, Single sign-on, GitHub). On a phone, Settings opens as a list of sections. Old links such as `#/connections` still work.

## Sharing apps

Every app has an owner (whoever created it); admins can do everything with every app. In the builder's **Share** sheet the owner picks what the rest of the team gets (nothing, view, or edit) and adds people as viewers or editors:

- **Viewer**: opens the preview and the published app, and reads the builder (chat, code, data) without changing anything.
- **Editor**: also chats with the agent, edits code and preview data, restores versions and publishes.
- **Owner and admins**: also change live data, sharing and delete the app.

New apps start as view-only for the team; apps created before sharing existed stay editable by everyone. Traefik's sign-in check enforces the same rules on `<app>.<domain>` and `<app>-preview.<domain>`, and passes the role to apps as `X-Agency-App-Role` (`currentUser().appRole`).

## Single sign-on

Under **Settings**, an admin connects the organization's identity provider over OpenID Connect (Google Workspace, Microsoft Entra ID, Okta, or any other): issuer URL, client ID and secret, and the email domains that may sign in. Register `https://<your-domain>/auth/sso/callback` as the redirect URI. Only people whose verified email is in an allowed domain get in; they join as members on their first sign-in, with the default budget. Password sign-in can stay on for admins only, as a way in if the provider is down. The same session covers previews and published apps.

## GitHub

Under **Settings**, an organization owner enters the organization's name and clicks **Connect GitHub**. Agency sends them to GitHub with a [GitHub App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest); they confirm creating a private app in the organization (permissions: Contents and Administration write, Metadata read), then confirm installing it, and land back in Settings connected. Nothing is copied by hand. The app's private key is stored encrypted, and pushes use installation tokens that expire after an hour; which repositories the app can use is chosen in its installation settings on GitHub. **Disconnect** uninstalls it; an owner can then delete the app on GitHub. GitHub Enterprise Server works with its address. A token (fine-grained, owned by the organization, with Contents and Administration read and write) still works instead, under **Use a token instead**, and is the way to use a personal account.

Once GitHub is connected, every new app gets its own repository in the organization (private, named after the app, with -2, -3, ... when the name is taken) and pushes each version automatically. An admin can turn that off, or make new repositories public, under **Settings**.

In the builder, the **GitHub** button links an app to a new private repository or an existing one and pushes its version history; it can push every new version automatically. Credentials stay in the platform: the app's history is copied out of the sandbox as a git bundle and pushed from the platform container. A branch with commits made outside Agency is not overwritten unless someone chooses **Overwrite**.

## Security notes for this MVP

- The platform container mounts the Docker socket, which is root-equivalent on the host. Keep the host dedicated to Agency.
- LLM keys are passed to pi with `docker exec -e` for each session, so they are visible inside sandboxes while the agent runs, never in published apps.
- All signed-in members see the list of connections (never their credentials).
- The user headers are trustworthy for requests that come through Traefik. Containers on the internal Docker network (sandboxes included) can reach app containers directly and could set them, so don't base admin-only actions in apps on them alone until sandboxes get an egress allowlist.
