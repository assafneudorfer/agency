# Sandbox image: one container per app. Runs the Next.js dev server and the pi coding agent.
# Build context is the repository root.

# The full Debian image already has git, curl and procps; pi downloads ripgrep and fd on first use.
FROM node:22-bookworm

# pi from npm, pinned. Bump PI_VERSION to upgrade.
ARG PI_VERSION=1.3.0
RUN npm install -g --ignore-scripts --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_VERSION}" \
	&& git config --global user.name "Agency" \
	&& git config --global user.email "agency@localhost" \
	&& git config --global init.defaultBranch main

COPY sandbox/template /opt/template
RUN cd /opt/template && npm ci --no-audit --no-fund

COPY sandbox/opt /opt/agency
ENV NEXT_TELEMETRY_DISABLED=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0
WORKDIR /workspace
VOLUME /workspace
EXPOSE 3000
ENTRYPOINT ["/opt/agency/entrypoint.sh"]
