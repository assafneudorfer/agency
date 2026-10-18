# Notes for coding agents

This file is for coding agents (Claude Code and others) working in this repository. The first part covers helping someone self-host Agency. The second is a short map of the code.

## Helping someone self-host Agency

The person wants Agency running for their organization on their own AWS account. Your job is to pick a setup that fits, explain what it will cost, and run `infra/aws/deploy.sh` with them. They make the decisions that cost money or can't be undone.

### 1. Ask about the organization, not the head count

Ask these, a few at a time, in plain words:

- **Building at once:** how many apps do people build at the same time on a busy day? Count apps being built, not people with accounts.
- **Published apps:** how many apps will they publish, and do people depend on them during the workday, or are they occasional internal tools?
- **Idle time:** will the setup sit unused for long stretches, such as nights, weekends or a trial period?
- **AWS and DNS:** do they already use Cloudflare for the domain, or would they rather keep everything on AWS (Route 53 and Claude on Amazon Bedrock, with no keys to paste)?
- **Region:** which AWS region? Prices below are us-east-1; other regions are up to about 30% more.

### 2. Recommend a profile

| Profile | Choose when | Server | Dev environments | Published apps |
|---|---|---|---|---|
| 1. Try it out | A trial, or one or two people building | t3.medium (4 GB) | On the server | On the server |
| 2. Team | Up to about 4 apps built at once, a dozen light published apps, steady daily use | t3.xlarge (16 GB) | On the server | On the server |
| 3. Organization | More than about 4 apps built at once, usage that comes in bursts, or published apps people rely on | t3.medium | AWS Fargate, Spot, sleeping when idle | Shared apps servers (about 14 apps each), another starts when full |
| 4. Custom | Mix and match, for example Team's server with published apps on apps servers | small or standard | docker or fargate | docker, ec2 (apps servers) or fargate |

Rules of thumb:

- A sandbox takes up to 3 GB of memory while someone builds in it. That is what fills a server, not the number of accounts.
- Idle apps sleep in every profile after 30 minutes. On the server that frees memory; on Fargate it also stops the bill for that app.
- Published apps nobody opens for a week (`app_idle_days`) go offline and their owner gets an email; the next visit starts them. That keeps apps servers from filling up with forgotten apps, and the platform drains a server when its apps fit on the others, so the count of apps servers follows the apps that are actually up. Email needs SES (all on AWS; ask them to request SES production access) or an SMTP server in Settings > Email.
- Published apps on the server are free until the server runs out of memory. On apps servers they cost about $36 a month per server of about 14 apps (about $2.60 an app when full), can't affect the builder, and a new server starts when they're full. On Fargate each app costs about $13 a month on its own; suggest it only when apps must be isolated from each other.
- If the person isn't sure, recommend **Try it out**. `./deploy.sh profile` can move to Team or Organization later without losing data. Moving dev environments or published apps from the cluster back to the server isn't supported yet, so don't start on the cluster "just in case".

### 3. Explain the costs

These are on-demand prices in us-east-1. Quote them as estimates, and point to `./deploy.sh costs`, which prints the same model for the deployed settings.

| Item | Price |
|---|---|
| t3.medium server, always on | $30.37 a month |
| t3.xlarge server, always on | $121.47 a month |
| Disk (gp3) | $0.08 per GB a month: 40 GB on small, 100 GB on standard |
| Public IPv4 address (server, each apps server, and each Fargate task) | $3.65 a month each, or $0.005 an hour |
| Backups in S3 and logs | About $1 a month |
| Server stopped (`./deploy.sh stop`) | Disk and IP only: about $7 small, $12 standard. Stop also stops dev environments, published apps and apps servers in the cluster; start brings them back. |
| Dev environment on Fargate Spot (1 vCPU, 3 GB) | About $0.021 an hour while awake. Regular Fargate is about $0.059 an hour (`sandbox_spot = false`). |
| Workspaces on EFS | $0.30 per GB a month; an app is usually under 50 MB |
| Apps server (t3.medium, 30 GB disk, public IP) | About $36.42 a month, holds about 14 small published apps. At least one runs; more start when full (up to 4 by default). |
| Published app on Fargate (0.25 vCPU, 0.5 GB, one task) | About $12.66 a month, more while it scales out (up to 3 tasks by default) |
| Claude | Billed separately: Anthropic API, or Amazon Bedrock on the AWS bill. Each member has a monthly budget in Agency (default $20). |

A worked example for the Organization profile: 10 people each building about 3 hours a day for 21 working days, with 8 published apps. That comes to $38 for the server, plus 10 × 3 × 21 × $0.021 ≈ $13 for dev environments, plus one apps server for the 8 published apps, $36, about $87 a month before Claude usage (20 published apps would need a second server, about $124). The Team profile would run the same load for about $134, but only if no more than about 4 apps are built at the same time.

### 4. Run the deployment with them

You need the AWS CLI signed in to their account (check `aws sts get-caller-identity`), Terraform 1.6+, and a domain they control.

```bash
cd infra/aws
./deploy.sh
```

- `deploy.sh` asks its questions at the terminal. Any answer can be given in advance as an environment variable: `MODE` (1 Cloudflare + Claude key, 2 all on AWS), `BASE_DOMAIN`, `ADMIN_EMAIL`, `AWS_REGION_CHOICE`, `REPO_REF`, `PROFILE` (1-4), and for Custom `SIZE`, `SANDBOX_RUNTIME` (docker or fargate) and `APP_RUNTIME` (docker, ec2 or fargate). With all on AWS it also takes `MODEL`.
- **Secrets:** the admin password, the Claude API key and the Cloudflare token are read at hidden prompts, or from `ADMIN_PASSWORD`, `ANTHROPIC_API_KEY` and `CLOUDFLARE_API_TOKEN`. Never ask the person to paste a secret into the chat. Let them type it at the prompt, or export it in their own shell.
- The script shows the Terraform plan and asks `Apply this plan?`. Summarize the plan for the person and confirm only once they say yes.
- With all on AWS and a new Route 53 zone, the script prints four name servers and waits until the registrar points the domain at them. That step is theirs to do; tell them to copy any existing records (email, other sites) into the zone first.
- Afterwards: sign in at `https://<domain>` with the admin email and password. `./deploy.sh status` checks the server, and `./deploy.sh stop` / `start` save money when nobody uses it.

Don't run `./deploy.sh destroy`, `stop`, `profile` or `use-aws` unless the person asks for that specific step. `destroy` deletes the data and backups.

The full guide is [docs/deploy.md](docs/deploy.md).

## Code map

- `platform/`: Node 22 + Hono, TypeScript run directly by Node's type stripping (no build step), Preact UI in `platform/web`. Check it with `cd platform && npm run typecheck`.
  - `sandboxes.ts`: where sandboxes run, on the server through Docker or as Fargate tasks (`sandbox-fargate.ts`). All commands in a sandbox go through `sandboxes.spawn`, `execIn` and `execArgv`.
  - `apps.ts`: where published apps run, as containers on the server or as ECS services on shared apps servers or Fargate (`fargate.ts`). `ecs.ts` holds what the cluster runtimes share.
  - `agent.ts`: the pi RPC bridge. `idle.ts`: putting apps to sleep. `app-idle.ts`: taking down published apps without visits. `mail.ts`: email (SMTP or SES). `publish.ts`: builds and versions.
- `sandbox/`: the sandbox image, with the Next.js template, the entrypoint and `sandboxd.mjs`.
- `infra/aws/`: Terraform and `deploy.sh`. `cluster.tf` covers everything on ECS.
- `docs/`: guides for users and admins. New features get a line in the README features table and details in the matching guide.

The repository has no CI. Before pushing, run the typecheck, `bash -n` on the shell scripts you changed, and `terraform fmt -check` in `infra/aws`.
