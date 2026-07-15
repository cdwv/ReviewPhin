---
title: Run with Docker
description: Run the worker with Docker Compose.
---

Docker Compose is the simplest production-adjacent way to run ReviewPhin on a single host. The published image is `cdwv/reviewphin`; it bundles the GitHub Copilot CLI and exposes the `reviewphin` CLI entrypoint.

:::note[Media placeholder — first Docker boot]
**Suggested clip (~20s):** `docker compose up -d`, then `curl .../healthz` returning `{"status":"ok"}`, then a `docker compose run --rm worker reviewphin tenant list`.
:::

## 1. Configure the worker

Copy the example environment file. Docker Compose reads `.env.docker`:

```bash
cp .env.example .env.docker
```

Set at least the public URL and model authentication:

```ini title=".env.docker"
PUBLIC_URL=https://reviewphin.example.com
GH_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

`PUBLIC_URL` must be reachable by GitLab or GitHub. GitLab webhook secrets are configured per tenant with `--webhook-secret`, not through an environment variable. See [environment variables](../environment-variables/) for the full list.

## 2. Start the container

```bash
docker compose up -d
```

The compose file mounts `./data` to `/app/data` (SQLite database and run logs) and `./tmp` to `/app/tmp` (hydrated workspaces). Both directories are created automatically and must persist across container replacement.

## 3. Confirm it is running

```bash
curl http://localhost:3000/healthz
# {"status":"ok"}
```

## 4. Run the CLI

The image registers `reviewphin`. Run CLI commands through the worker service:

```bash
docker compose run --rm worker reviewphin tenant list
```

Continue with [platform connections](../../management/platform-connections/) and [tenants](../../management/tenants/).

## 5. Expose it

A local Docker host is not reachable by your platform yet. For a quick trial, open a [tunnel](../exposing-webhooks/#tunnels-for-local-and-docker). For durable production, place ReviewPhin behind a TLS-terminating reverse proxy or use the [Helm chart](../kubernetes/).

## Build the image yourself

The repository ships a multi-stage `Dockerfile`. The compose file builds it locally as `reviewphin:local`; `docker compose up --build` rebuilds after source changes.

The runtime stage pins the bundled Copilot CLI to a fixed version for reproducible images. It defaults to `1.0.70` and can be overridden at build time:

```bash
docker build --build-arg COPILOT_CLI_VERSION=1.0.70 -t reviewphin:local .
```

The image installs `@github/copilot` at that version and points `COPILOT_CLI_PATH` at `/usr/local/bin/copilot`. CLI `1.0.70` is the dependency resolved for the bundled `@github/copilot-sdk` `1.0.6`.
