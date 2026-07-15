FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS package-manager

ENV COREPACK_HOME=/opt/corepack

RUN corepack install --global pnpm@10.18.2

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS node-with-pnpm

ENV PNPM_HOME=/pnpm \
  PATH=/pnpm/bin:/pnpm:$PATH \
  COREPACK_HOME=/opt/corepack

COPY --from=package-manager /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/corepack
COPY --from=package-manager /opt/corepack /opt/corepack

RUN ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
  && corepack enable --install-directory /usr/local/bin

FROM node-with-pnpm AS build


ARG REVIEWPHIN_BUILD_HOMEPAGE=false
ARG REVIEWPHIN_POSTHOG_KEY=
ARG REVIEWPHIN_POSTHOG_HOST=
ENV REVIEWPHIN_BUILD_HOMEPAGE=${REVIEWPHIN_BUILD_HOMEPAGE} \
  REVIEWPHIN_POSTHOG_KEY=${REVIEWPHIN_POSTHOG_KEY} \
  REVIEWPHIN_POSTHOG_HOST=${REVIEWPHIN_POSTHOG_HOST}

WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY prompts ./prompts
COPY public ./public
COPY docs ./docs
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm docs:build:container \
  && pnpm prune --prod

FROM node-with-pnpm AS runtime

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  SQLITE_DATABASE_PATH=./data/review-worker.sqlite \
  RUN_LOG_DIR=./data/run-logs \
  WORKSPACE_ROOT=./tmp/review-workspaces \
  MAX_JOB_RETRIES=3 \
  RETRY_BACKOFF_MS=5000 \
  COPILOT_TIMEOUT_MS=180000 \
  COPILOT_CLI_PATH=/pnpm/copilot

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && pnpm add --global --global-bin-dir /pnpm @github/copilot@1.0.70 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prompts ./prompts
COPY --from=build /app/public ./public

RUN mkdir -p /app/data /app/tmp \
  && printf '#!/bin/sh\nREVIEWPHIN_CLI_COMMAND=reviewphin exec node /app/dist/cli.js "$@"\n' > /usr/local/bin/reviewphin \
  && chmod +x /usr/local/bin/reviewphin

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "const http = require('node:http'); const req = http.get({ host: '127.0.0.1', port: Number(process.env.PORT ?? '3000'), path: '/healthz', timeout: 4000, agent: false }, (res) => { res.resume(); res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1)); }); req.on('timeout', () => { req.destroy(new Error('timeout')); }); req.on('error', () => process.exit(1));"

CMD ["node", "dist/index.js"]
