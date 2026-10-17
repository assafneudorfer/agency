# Deploying Agency

[Back to the README](../README.md)

Agency runs on one AWS EC2 instance with Docker Compose: Traefik in front, the platform, Postgres, and a container per sandbox and per published app. `infra/aws` holds the Terraform and a `deploy.sh` that asks a few questions and does the rest.

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

It asks for an admin password at a hidden prompt (or reads `ADMIN_PASSWORD`), then the domain, admin email, region and size. Choose `small` (t3.medium) for testing or `standard` (t3.xlarge) for the team. It shows the Terraform plan and applies it after you confirm. The server builds the images and starts the stack on first boot; the script waits until the site answers, then you sign in with the admin email and password.

### Option 1: Cloudflare + Claude API key

Needs a Cloudflare zone for the domain and a Cloudflare API token with **Zone > DNS > Edit** on it. The script asks for the Claude API key and the token at hidden prompts (or reads `ANTHROPIC_API_KEY` and `CLOUDFLARE_API_TOKEN`), checks both and finds the zone.

### Option 2: all on AWS

The script finds the domain's public Route 53 hosted zone, or offers to create one (about $0.50 a month). A new zone only works once your domain registrar points the domain's name servers at it: the script prints the four name servers and waits until the change is visible, because Let's Encrypt checks the domain through DNS. Copy any records the domain already has elsewhere (email, other sites) into the zone before switching. It then asks for the Claude model (default: Opus 4.8 through the cross-region profile for the region, for example `amazon-bedrock/us.anthropic.claude-opus-4-8`) and sends it one tiny request with your own AWS sign-in. That first call also turns the model on for the account; if Bedrock refuses, open **Amazon Bedrock > Model catalog** in the console, pick the model, and fill in Anthropic's one-time use case form if it asks.

On the server, two narrow IAM roles do the work: one can only change records in the hosted zone (Traefik's Let's Encrypt DNS challenge), the other can only call Claude models on Bedrock (the coding agent). The host assumes them every 15 minutes and keeps the one-hour credentials under `/var/lib/agency/aws`. pi gets no keys: its AWS profile asks the platform for the current Bedrock credentials with a per-app token only pi holds, so published apps cannot use Bedrock. Usage and budgets work the same, priced at the model's list price. Bedrock usage is billed on your AWS bill.

### Moving a running deployment to all on AWS

`./deploy.sh use-aws` keeps the server, data, address and certificate. It finds or creates the hosted zone, asks for the Bedrock model, adds the records to Route 53 while Cloudflare keeps serving, waits for the registrar change, then removes the Cloudflare records and redeploys. It asks for the Cloudflare token once more to delete the old records. If you stop it while it waits, run it again.

## Day-to-day commands

| Command | What it does |
|---|---|
| `./deploy.sh` | First setup, or apply infrastructure changes |
| `./deploy.sh update` | Redeploy the latest code on the branch |
| `./deploy.sh use-aws` | Move a Cloudflare + API key server to the all-AWS setup |
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

To save money when nobody is using it, `./deploy.sh stop` stops the server and `./deploy.sh start` brings it back with the same address, data and apps (`./deploy.sh status` shows which). Rough on-demand cost in us-east-1 with `small`: about $37 a month running all the time (instance about $30, disk $3.20, public IP $3.65), and about $7 a month while stopped (disk and public IP only). Claude usage is billed separately, by Anthropic or on the AWS bill with Bedrock.

## What gets created

This creates one EC2 instance (`t3.medium` with 40 GB or `t3.xlarge` with 100 GB, encrypted gp3, plus 4 GB swap) with an Elastic IP, a security group for 80/443, an IAM role for Session Manager, a private S3 bucket for backups, the `.env` as a SecureString in SSM Parameter Store, and two A records (`base_domain` and `*.base_domain`) in Cloudflare or Route 53. With the all-AWS setup it also adds the two runtime IAM roles. Cloudflare records are DNS-only by default: Cloudflare's free edge certificate does not cover a second-level wildcard such as `*.agency.example.com`, while Traefik's Let's Encrypt wildcard does. Set `cloudflare_proxied = true` only if the base domain is the zone apex or the zone has Advanced Certificate Manager.

## Run locally

`localtest.me` and all its subdomains resolve to 127.0.0.1, so the full flow works on a laptop over plain HTTP:

```bash
cp .env.example .env   # set AGENCY_BASE_DOMAIN=localtest.me, secrets and an LLM key
docker compose --profile build build sandbox
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
open http://localtest.me
```
