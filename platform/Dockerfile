FROM docker:29.8.2-cli AS docker-cli

FROM node:22-bookworm-slim
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY web ./web
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "src/main.ts"]
