# Sandbox image: one container per app. Runs the Next.js dev server and the pi coding agent.
# Build context is the repository root, so pi is built from this fork's own source.

FROM node:22-bookworm AS pi
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY scripts ./scripts
COPY packages ./packages
# PI_BUILD=build:offline skips refreshing model data (needs packages/ai/src/providers/data from `npm run hydrate:model-data`).
ARG PI_BUILD=build
RUN npm ci --ignore-scripts && npm run ${PI_BUILD}

# The full Debian image already has git, curl and procps; pi downloads ripgrep and fd on first use.
FROM node:22-bookworm
COPY --from=pi /src /opt/pi
RUN ln -s /opt/pi/packages/coding-agent/dist/cli.js /usr/local/bin/pi \
	&& git config --global user.name "Agency" \
	&& git config --global user.email "agency@localhost" \
	&& git config --global init.defaultBranch main

COPY agency/sandbox/template /opt/template
RUN cd /opt/template && npm ci --no-audit --no-fund

COPY agency/sandbox/opt /opt/agency
ENV NEXT_TELEMETRY_DISABLED=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0
WORKDIR /workspace
VOLUME /workspace
EXPOSE 3000
ENTRYPOINT ["/opt/agency/entrypoint.sh"]
