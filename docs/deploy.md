# Deploying Agency

[Back to the README](../README.md)

Agency runs on an AWS EC2 instance with Docker Compose: Traefik in front, the platform and Postgres. Each app's dev environment (its sandbox) and each published app run either on that server or in an ECS cluster on AWS (dev environments on Fargate, published apps on shared apps servers or Fargate), depending on the profile you choose. `infra/aws` holds the Terraform and a `deploy.sh` that asks a few questions and does the rest. A coding agent can run it with you: [AGENTS.md](../AGENTS.md) tells it how to choose a profile and explain the costs.

## Setups

The server always runs on AWS. The first run of `./deploy.sh` asks how to set it up:

1. **Cloudflare DNS + Claude API key**: you paste a Cloudflare token and an Anthropic key.
2. **All on AWS**: DNS in Route 53 and Claude on Amazon Bedrock. There are no keys to paste or store: the server's IAM role does everything.

## Install

Requirements for both: an AWS account with the AWS CLI signed in, Terraform 1.6+, and a domain.

```bash
cd infra/aws
./deploy.sh
```

It asks for an admin password at a hidden prompt (or reads `ADMIN_PASSWORD`), then the domain, admin email, region and [profile](#profiles). It shows the Terraform plan and applies it after you confirm. The server builds the images and starts the stack on first boot; the script waits until the site answers, then you sign in with the admin email and password.

### Option 1: Cloudflare + Claude API key

Needs a Cloudflare zone for the domain and a Cloudflare API token with **Zone > DNS > Edit** on it. The script asks for the Claude API key and the token at hidden prompts (or reads `ANTHROPIC_API_KEY` and `CLOUDFLARE_API_TOKEN`), checks both and finds the zone.

### Option 2: all on AWS

The script finds the domain's public Route 53 hosted zone, or offers to create one (about $0.50 a month). A new zone only works once your domain registrar points the domain's name servers at it: the script prints the four name servers and waits until the change is visible, because Let's Encrypt checks the domain through DNS. Copy any records the domain already has elsewhere (email, other sites) into the zone before switching. It then asks for the Claude model (default: Opus 4.8 through the cross-region profile for the region, for example `amazon-bedrock/us.anthropic.claude-opus-4-8`) and sends it one tiny request with your own AWS sign-in. That first call also turns the model on for the account; if Bedrock refuses, open **Amazon Bedrock > Model catalog** in the console, pick the model, and fill in Anthropic's one-time use case form if it asks.

On the server, two narrow IAM roles do the work: one can only change records in the hosted zone (Traefik's Let's Encrypt DNS challenge), the other can only call Claude models on Bedrock (the coding agent). The host assumes them every 15 minutes and keeps the one-hour credentials under `/var/lib/agency/aws`. pi gets no keys: its AWS profile asks the platform for the current Bedrock credentials with a per-app token only pi holds, so published apps cannot use Bedrock. Usage and budgets work the same, priced at the model's list price. Bedrock usage is billed on your AWS bill.

## Profiles

Size Agency by how your organization will use it, not by head count: how many apps people build at the same time, and how much the published apps are relied on. A sandbox uses up to 3 GB of memory while someone builds, so that is what fills a server.

| Profile | Runs on | Fits | Cost a month (us-east-1, on demand) |
|---|---|---|---|
| **Try it out** | One t3.medium (4 GB) runs everything | About 2 apps built at the same time and a handful of light published apps | About $37, $7 while stopped |
| **Team** | One t3.xlarge (16 GB) runs everything | About 4 apps built at the same time and a dozen published apps | About $133, $12 while stopped |
| **Organization** | A t3.medium for the platform; dev environments on AWS Fargate; published apps on shared apps servers that scale out | Any number of apps built at once; published apps people depend on | About $37, plus 2 to 6 cents an hour for each app while someone builds it, plus about $36 per apps server (about 14 published apps each) |
| **Custom** | Choose the server size and, separately, where dev environments and published apps run | | |

`./deploy.sh costs` prints the current setup's costs with these numbers. Claude usage is billed separately in every profile.

**Dev environments on Fargate.** Each app's sandbox is an ECS task that runs only while someone builds it: opening the builder or the preview starts it (up to a minute, mostly pulling the image), and it stops after 30 minutes without use, so you pay by the hour. Tasks run on Fargate Spot by default, about 70% cheaper (1 vCPU and 3 GB for about $0.02 an hour, $0.06 on regular Fargate). AWS can take a Spot task back with two minutes' notice; the workspace is safe on EFS and the next request starts a new task, but an agent turn in progress is cut off. Set `sandbox_spot = false` in `agency.auto.tfvars` for regular Fargate. Code, version history and chat sessions live on an EFS file system (one directory per app, cents a month); `node_modules` and the Next.js caches stay on the task's own disk, refilled from the image on every start, because npm and the dev server are slow on a network file system. The platform runs commands in the task through `sandboxd`, a small server only the platform's server can reach, with a per-app token.

**Published apps on shared apps servers** (`app_runtime = "ec2"`, the Organization profile). Each published app is an ECS service, and many of them are packed onto one EC2 instance in the cluster, the way a hosting platform does it. An app reserves 256 MB of memory and a small CPU share (it may use up to 512 MB, and more CPU while the server is quiet), so a t3.medium holds about 14 small apps. When a new app or an extra task doesn't fit, ECS starts another apps server on its own (managed scaling of an Auto Scaling group); when apps are removed, it drains a server that is no longer needed and removes it. There is always at least one, and at most `apps_servers_max` (default 4); `apps_server_type` sets the instance type. A server costs about $36 a month (t3.medium, its 30 GB disk and public IPv4 address), so about $2.60 an app on a full server. Each app still scales from one task up to `app_max_tasks` on CPU, and a new version starts next to the old one before it is stopped. Apps run as containers side by side, as on the Agency server, and can't reach the instance's AWS role (the metadata service is one network hop away from containers).

**Published apps on Fargate** (`app_runtime = "fargate"`, Custom only). Each published app becomes its own ECS service that scales from one task up to `app_max_tasks` (default 3) on CPU, so a busy or broken app can't take memory from the builder. Traefik on the server still handles TLS and sign-in and forwards to the tasks' private addresses, so app URLs and sharing work the same. An app costs about $13 a month: 0.25 vCPU and 0.5 GB ($9) plus $3.65 for the task's public IPv4 address, which it needs to pull its image without a NAT gateway.

Fargate is the most isolated choice and costs the most for many small apps; the shared apps servers cost far less once there are more than three or four apps. Keeping published apps on the Agency server is free until its memory runs out.

**With the server stopped**, published apps on the apps servers or Fargate keep running (and billing), but they can't be reached, since Traefik runs on the server. `./deploy.sh stop` stops all dev environments first, since no platform is left to put them to sleep.

**Changing profile.** `./deploy.sh profile` asks again and applies the change. Moving dev environments to Fargate copies each app's workspace to EFS the first time someone opens it; moving published apps to the cluster moves each one with the version it had, and removes the old container once the new task answers. Moving either back to the server, or published apps between the apps servers and Fargate, isn't supported yet. A bigger server keeps its address and data; a smaller one keeps its larger disk, since disks can't shrink.

### Moving a running deployment to all on AWS

`./deploy.sh use-aws` keeps the server, data, address and certificate. It finds or creates the hosted zone, asks for the Bedrock model, adds the records to Route 53 while Cloudflare keeps serving, waits for the registrar change, then removes the Cloudflare records and redeploys. It asks for the Cloudflare token once more to delete the old records. If you stop it while it waits, run it again.

## Day-to-day commands

| Command | What it does |
|---|---|
| `./deploy.sh` | First setup, or apply infrastructure changes |
| `./deploy.sh update` | Redeploy the latest code on the branch |
| `./deploy.sh use-aws` | Move a Cloudflare + API key server to the all-AWS setup |
| `./deploy.sh profile` | Change the profile: server size, and where dev environments and published apps run |
| `./deploy.sh costs` | What the current setup costs a month |
| `./deploy.sh stop` / `start` / `status` | Stop the server to save money, start it again, show which |
| `./deploy.sh backup` | Run a database backup now |
| `./deploy.sh destroy` | Remove everything |

Secrets never go into files or command lines from the script; they reach the server only through an encrypted SSM SecureString. Terraform state does contain them, so `terraform.tfstate` stays private on your machine (mode 600). `./deploy.sh update` redeploys the latest code on the branch, and `./deploy.sh destroy` removes everything.

## Backups

Every night at 03:00 UTC the server dumps all databases (platform state and every app's preview and live data) with `pg_dumpall`, keeps the last 7 dumps in `/var/backups/agency`, and uploads each to a private S3 bucket that deletes them after 30 days (`backup_retention_days`). A run missed while the server was stopped happens right after it starts. `./deploy.sh backup` runs one now. To restore, open a shell on the server (`terraform output -raw shell`) and load a dump. This replaces all current data, so the platform and app containers are stopped while it runs:

```bash
cd /opt/agency-src
docker compose stop platform && docker ps -q --filter label=agency.project | xargs -r docker stop
aws s3 cp s3://<backup bucket>/postgres/<file>.sql.gz - | gunzip | docker compose exec -T postgres psql -U agency -d postgres
docker compose start platform && docker ps -aq --filter label=agency.project | xargs -r docker start
```

A few "cannot drop" notices about the current user are expected.

## Stop it when nobody uses it

To save money when nobody is using it, `./deploy.sh stop` stops the server and `./deploy.sh start` brings it back with the same address, data and apps (`./deploy.sh status` shows which). Rough on-demand cost in us-east-1 for the Try it out profile: about $37 a month running all the time (instance about $30, disk $3.20, public IP $3.65), and about $7 a month while stopped (disk and public IP only). Claude usage is billed separately, by Anthropic or on the AWS bill with Bedrock.

## What gets created

This creates one EC2 instance (`t3.medium` with 40 GB or `t3.xlarge` with 100 GB, encrypted gp3, plus 4 GB swap) with an Elastic IP, a security group for 80/443, an IAM role for Session Manager, a private S3 bucket for backups, the `.env` as a SecureString in SSM Parameter Store, and two A records (`base_domain` and `*.base_domain`) in Cloudflare or Route 53. With the all-AWS setup it also adds the two runtime IAM roles. With dev environments or published apps in the cluster it adds an ECS cluster, a log group (`/agency/cluster`, 14 days), an execution role that pulls images and writes logs (the tasks themselves get no IAM role), and a role the server assumes to push images and run tasks and services in that cluster only. Published apps add an ECR repository and a security group that lets only the server reach them (port 3000 on Fargate, the ports ECS hands out on apps servers). Apps servers add a launch template with the ECS-optimized Amazon Linux 2023 image, an Auto Scaling group (1 to `apps_servers_max`), an ECS capacity provider with managed scaling, and an instance role for the ECS agent and Session Manager. Dev environments add an ECR repository for the sandbox image (the last three kept), an encrypted EFS file system with a mount target in each availability zone (mounted on the server at `/mnt/agency-efs`), and a security group that lets only the server reach the preview (3000) and `sandboxd` (7070). Tasks reach Postgres on the server's private address, allowed only from their security groups. `./deploy.sh destroy` deletes the services and stops the tasks first. Cloudflare records are DNS-only by default: Cloudflare's free edge certificate does not cover a second-level wildcard such as `*.agency.example.com`, while Traefik's Let's Encrypt wildcard does. Set `cloudflare_proxied = true` only if the base domain is the zone apex or the zone has Advanced Certificate Manager.

## Run locally

`localtest.me` and all its subdomains resolve to 127.0.0.1, so the full flow works on a laptop over plain HTTP:

```bash
cp .env.example .env   # set AGENCY_BASE_DOMAIN=localtest.me, secrets and an LLM key
docker compose --profile build build sandbox
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
open http://localtest.me
```
