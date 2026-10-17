# Security notes

[Back to the README](../README.md)

Agency is an MVP meant for one organization on a dedicated host. These are the trade-offs to know about.

- The platform container mounts the Docker socket, which is root-equivalent on the host. Keep the host dedicated to Agency.
- LLM keys are passed to pi with `docker exec -e` for each session, so they are visible inside sandboxes while the agent runs, never in published apps.
- All signed-in members see the list of connections (never their credentials).
- The user headers are trustworthy for requests that come through Traefik. Containers on the internal Docker network (sandboxes included) can reach app containers directly and could set them, so don't base admin-only actions in apps on them alone until sandboxes get an egress allowlist.
