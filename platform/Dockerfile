FROM docker:29.8.2-cli AS docker-cli

FROM node:22-bookworm-slim
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
# git pushes apps' code to GitHub.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY web ./web
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "src/main.ts"]
