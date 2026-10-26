#!/usr/bin/env bash
# Sandbox entrypoint: prepares /workspace from the template, configures pi's MCP access to the
# Agency gateway, and keeps the Next.js dev server running. pi itself is started by the platform
# with `docker exec` when someone chats with the app, or through sandboxd when the sandbox is a task
# on AWS Fargate.
set -uo pipefail

WS=/workspace
if [ ! -f "$WS/package.json" ]; then
	echo "Initializing workspace from template"
	cp -a /opt/template/. "$WS/"
	cd "$WS"
	git init -q -b main
	git add -A
	git commit -q -m "Start from template"
fi
cd "$WS"
# Helpers the platform provides: add any that a workspace made from an older template is missing.
for helper in lib/agency.ts lib/db.ts lib/user.ts instrumentation-client.ts; do
	[ -f "$WS/$helper" ] || { mkdir -p "$(dirname "$WS/$helper")"; cp "/opt/template/$helper" "$WS/$helper"; }
done
# On Fargate, node_modules is an empty directory on the task's own disk at every start: fill it from
# the image, then install whatever the app added on top of the template.
if [ ! -e node_modules/.package-lock.json ]; then
	mkdir -p node_modules
	cp -a /opt/template/node_modules/. node_modules/
	cmp -s package-lock.json /opt/template/package-lock.json || npm install --no-audit --no-fund
fi

mkdir -p /root/.pi/agent
cat > /root/.pi/agent/mcp.json <<JSON
{
	"mcpServers": {
		"agency": {
			"url": "${AGENCY_MCP_URL:-http://platform:8080/mcp}",
			"headers": { "Authorization": "Bearer \${AGENCY_PROJECT_TOKEN}" },
			"exposure": "direct",
			"description": "Organization data connections: list them, inspect schemas and tools, sample data"
		}
	}
}
JSON

touch /tmp/dev.log
if [ -n "${AGENCY_SANDBOXD_TOKEN:-}" ]; then
	(while true; do node /opt/agency/sandboxd.mjs >> /tmp/sandboxd.log 2>&1; sleep 1; done) &
fi
while true; do
	echo "[agency] starting dev server" >> /tmp/dev.log
	npm run dev >> /tmp/dev.log 2>&1
	echo "[agency] dev server exited with $?, restarting" >> /tmp/dev.log
	sleep 2
done
