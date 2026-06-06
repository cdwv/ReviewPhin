# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY prompts ./prompts

RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

ARG COPILOT_CLI_VERSION=1.0.36

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  DATABASE_PATH=./data/review-worker.sqlite \
  RUN_LOG_DIR=./data/run-logs \
  WORKSPACE_ROOT=./tmp/review-workspaces \
  MAX_JOB_RETRIES=3 \
  RETRY_BACKOFF_MS=5000 \
  COPILOT_TIMEOUT_MS=180000 \
  COPILOT_CLI_PATH=/usr/local/bin/copilot

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && npm install --global @github/copilot@${COPILOT_CLI_VERSION} \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prompts ./prompts

RUN mkdir -p /app/data /app/tmp \
  && printf '#!/bin/sh\nREVIEWPHIN_CLI_COMMAND=reviewphin exec node /app/dist/cli.js "$@"\n' > /usr/local/bin/reviewphin \
  && chmod +x /usr/local/bin/reviewphin

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "const http = require('node:http'); const req = http.get({ host: '127.0.0.1', port: Number(process.env.PORT ?? '3000'), path: '/healthz', timeout: 4000, agent: false }, (res) => { res.resume(); res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1)); }); req.on('timeout', () => { req.destroy(new Error('timeout')); }); req.on('error', () => process.exit(1));"

CMD ["node", "dist/index.js"]
