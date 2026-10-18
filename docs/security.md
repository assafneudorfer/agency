# Security notes

[Back to the README](../README.md)

Agency is an MVP meant for one organization on a dedicated host. These are the trade-offs to know about.

- The platform container mounts the Docker socket, which is root-equivalent on the host. Keep the host dedicated to Agency.
- LLM keys are passed to pi with `docker exec -e` for each session, so they are visible inside sandboxes while the agent runs, never in published apps.
- All signed-in members see the list of connections (never their credentials).
- The user headers are trustworthy for requests that come through Traefik. Containers on the internal Docker network (sandboxes included) can reach app containers directly and could set them, so don't base admin-only actions in apps on them alone until sandboxes get an egress allowlist. With published apps on Fargate this holds only for their port 3000 from the server; sandboxes on the server can still reach them through it.
- Sandboxes on Fargate: `sandboxd` runs any command it is asked to, as the sandbox already lets the agent do. Only the server's security group reaches its port, and each request needs a per-app HMAC token, so one sandbox can't drive another. The task's environment, the token included, is visible to anyone in the AWS account who can describe ECS tasks. Tasks mount EFS with TLS; the server mounts it over plain NFS inside the VPC.
- On Fargate, an app's environment (its live database URL and gateway token) is stored in its ECS task definition, readable by anyone in the AWS account who can describe task definitions. The apps' security group allows Postgres on the server, so a published app could try other apps' databases; each database has its own login, as on the server.
