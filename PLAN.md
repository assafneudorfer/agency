# Agency plan

Agreed in the project thread on 2026-10-09. Target: Assaf's team, self-hosted on one AWS EC2 instance with Cloudflare DNS.

## 1. Builder core (MVP, implemented)

A chat beside a live preview. Each app is a Docker sandbox from a Next.js + Postgres template; the pi coding agent from this repository edits it in RPC mode. Every agent turn is a git commit with restore.

## 2. Data connectors (MVP, implemented)

Admins register Postgres, Supabase, AWS RDS and MCP connections (Google Drive, Monday, Salesforce, AWS and other MCP servers). pi inspects schemas and samples data through the platform's MCP endpoint; apps read data through the gateway with a per-app token. Credentials stay encrypted in the platform. Done when "a dashboard of open deals from our CRM" works end to end.

## 3. Deploy and team (implemented)

One-click publish to `<app>.<domain>` with versioned images and rollback, team login with admin-managed members, previews and apps restricted to signed-in members through Traefik forward auth, and `terraform apply` for EC2 + Cloudflare DNS + wildcard TLS.

## 4. Brand

Name, logo, landing page and a template gallery, with assets made in Higgsfield.

## Next feature: SSO restricted to the organization

Replace email and password sign-in with the organization's identity provider so only the organization's people can reach the platform, previews and published apps.

- OIDC sign-in (Google Workspace, Microsoft Entra ID, Okta) configured with issuer, client id and secret.
- Allow only the organization's verified email domains (and optionally an IdP group); create users on first sign-in with the member role, admins from a configured group.
- Keep the shared session cookie and Traefik forward auth, so previews and published apps are covered by the same check.
- Optional SAML through the same flow later; keep a break-glass local admin.

## Later

- Per-project connection access and roles (viewer, builder, admin).
- Separate app databases for preview and production, with migrations on publish.
- Sandbox hardening: gVisor or Firecracker runtime, egress allowlist, idle sandbox shutdown.
- Multiple hosts (ECS or Kubernetes) when one instance is not enough.
