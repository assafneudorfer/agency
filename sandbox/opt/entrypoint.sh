#!/usr/bin/env bash
# Sandbox entrypoint: prepares /workspace from the template, configures pi's MCP access to the
# Agency gateway, and keeps the Next.js dev server running. pi itself is started by the platform
# with `docker exec` when someone chats with the app.
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
[ -d node_modules ] || npm install --no-audit --no-fund

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
while true; do
	echo "[agency] starting dev server" >> /tmp/dev.log
	npm run dev >> /tmp/dev.log 2>&1
	echo "[agency] dev server exited with $?, restarting" >> /tmp/dev.log
	sleep 2
done
