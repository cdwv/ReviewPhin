---
title: Environment variables
description: Full runtime configuration reference.
---

ReviewPhin reads runtime configuration from environment variables. For local runs put them in `.env`; for Docker Compose put them in `.env.docker`; for Kubernetes put them in the env secret referenced by `application.envSecret`. All variables are optional unless noted.

## Core

| Variable     | Default                   | Purpose                                                                                                                 |
| ------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PORT`       | `3000`                    | HTTP port.                                                                                                              |
| `HOST`       | `0.0.0.0`                 | Bind address.                                                                                                           |
| `PUBLIC_URL` | `http://localhost:<PORT>` | External base URL for setup pages, callbacks, and webhook instructions. See [exposing webhooks](../exposing-webhooks/). |
| `LOG_LEVEL`  | `info`                    | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`.                                                        |

## Crawler indexing

| Variable                                | Default | Purpose                                                                         |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `REVIEWPHIN_ALLOW_BOT_INDEXING`         | `false` | Allow crawler indexing for docs paths only (`/docs/*`) when `true`.             |
| `REVIEWPHIN_BOT_INDEXING_ALLOWED_HOSTS` | unset   | Comma-separated host allowlist for docs indexing; non-docs stay blocked always. |

## Storage and paths

| Variable                  | Default                       | Purpose                                                                                          |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `STORAGE_PROVIDER_MODULE` | built-in SQLite when unset    | Storage adapter module or shorthand. See [storage](../storage/).                                 |
| `SQLITE_DATABASE_PATH`    | `./data/review-worker.sqlite` | SQLite database path (ignored when a custom storage module is set).                              |
| `FLOTIQ_API_KEY`          | required for Flotiq           | Flotiq API key used when `STORAGE_PROVIDER_MODULE=flotiq`.                                       |
| `RUN_LOG_DIR`             | `./data/run-logs`             | Root directory for per-review run logs.                                                          |
| `WORKSPACE_ROOT`          | `./tmp/review-workspaces`     | Scratch directory for hydrated repositories.                                                     |
| `MAX_JOB_RETRIES`         | `3`                           | Retry attempts for failed review jobs.                                                           |
| `RETRY_BACKOFF_MS`        | `5000`                        | Delay between retry attempts, in milliseconds. Preserved across restarts by the persisted queue. |

## Job queue

Persisted interaction jobs are the queue source of truth. Enabled runner processes poll storage, which permits one active review; leases recover work after a crash. See [review flow](../../development/review-flow/) for the full lifecycle.

| Variable                           | Default    | Purpose                                                                                                                                                                                 |
| ---------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REVIEWPHIN_JOB_POLL_INTERVAL_MS`  | `2000`     | How often the runner polls storage for a claimable job. Must be a positive integer.                                                                                                     |
| `REVIEWPHIN_MAX_QUEUED_JOB_AGE_MS` | `21600000` | Maximum age (6 hours) a job may stay queued before it is expired, measured from its original enqueue time. Must be a positive integer.                                                  |
| `REVIEWPHIN_JOB_LEASE_MS`          | `120000`   | Claim lease duration. The runner renews the lease on a heartbeat derived internally as one third of this value. Minimum `1000`.                                                         |
| `REVIEWPHIN_JOB_RUNNER_ENABLED`    | `true`     | Set to `false` to run an HTTP-only replica that accepts webhooks but never claims or executes jobs. Required for extra replicas on `single-worker` storage; see [storage](../storage/). |

## Model runtime

| Variable                                             | Default                             | Purpose                                                                        |
| ---------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| `GH_TOKEN` / `GITHUB_TOKEN` / `COPILOT_GITHUB_TOKEN` | required for Copilot mode           | GitHub PAT with **Copilot Requests** permission, used by the Copilot CLI path. |
| `COPILOT_TIMEOUT_MS`                                 | `180000`                            | Model session timeout in milliseconds.                                         |
| `COPILOT_SDK_LOG_LEVEL`                              | unset                               | SDK log verbosity: `none`, `error`, `warning`, `info`, `debug`, or `all`.      |
| `COPILOT_CLI_PATH`                                   | image sets `/usr/local/bin/copilot` | Path to the Copilot CLI binary.                                                |
| `REVIEWPHIN_MEMORY_ENABLED`                          | `true`                              | Enable per-project memory.                                                     |
| `REVIEWPHIN_MAX_PROMPT_MEMORY_CHARS`                 | `5000`                              | Character budget for injected project memory.                                  |

BYOK providers (OpenAI-compatible, Azure, Anthropic) are configured through [model profiles](../../management/model-profiles/), not environment variables.

## Platform modules

`PLATFORM_MODULES` is a comma-separated list. If unset, ReviewPhin loads the built-in `gitlab` and `github` providers.

```ini
PLATFORM_MODULES=gitlab,github,./providers/internal-platform.js
```

The CLI reads the same list, so set it in the environment before running `tenant add` for a custom platform. See [custom platform providers](../../development/custom-platforms/).
