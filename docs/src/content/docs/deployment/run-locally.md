---
title: Run locally
description: Run the worker from a source checkout.
---

Running from a source checkout is the fastest way to develop or evaluate ReviewPhin. It uses your local Node.js instead of the container image.

## Prerequisites

- Node.js 22.12 or newer.
- pnpm (the repo pins a version through `packageManager`; `corepack enable` picks it up).
- The GitHub Copilot CLI on your `PATH` if you plan to use the default Copilot model path, or a [model profile](../../management/model-profiles/) pointing at another provider.

## 1. Install dependencies

```bash
pnpm install --frozen-lockfile
```

## 2. Configure the environment

Copy the example file and edit it. For local runs the worker reads `.env`:

```bash
cp .env.example .env
```

At minimum, set model authentication. For the Copilot path, set one GitHub token:

```ini title=".env"
GH_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

For a BYOK provider, leave `GH_TOKEN` unset and create a [model profile](../../management/model-profiles/) after startup. See [environment variables](../environment-variables/) for every setting.

## 3. Start the worker

Development mode with reload:

```bash
pnpm dev
```

Or build and run the compiled output:

```bash
pnpm build
pnpm start
```

The worker listens on port `3000` by default.

## 4. Check health

```bash
curl http://localhost:3000/healthz
# {"status":"ok"}
```

## 5. Register a project

Use `pnpm cli` from a local checkout wherever the docs write `reviewphin`:

```bash
pnpm cli platform connection add \
  --name main-gitlab \
  --platform gitlab \
  --base-url https://gitlab.example.com \
  --api-token glpat-xxxxxxxx
```

Continue with [platform connections](../../management/platform-connections/) and [tenants](../../management/tenants/).

## Next steps

- Local instances are not reachable by GitLab or GitHub yet. Expose the worker with a [tunnel](../exposing-webhooks/#tunnels-for-local-and-docker) before configuring webhooks.
- Previewing the GitHub setup screens without starting the App flow? `pnpm dev` logs a `/github/setup/samples` URL with sample data.
