<div align="center">
  <img src="./public/favicon.png" alt="ReviewPhin" width="120" />

# ReviewPhin

**Self-hosted AI code review for GitLab and GitHub.**
Run on your own infrastructure. Bring your own model. Use your own agent subscription to pay per review, not per developer.

[![Docker Image](https://img.shields.io/badge/docker-cdwv%2Freviewphin-blue?logo=docker)](https://hub.docker.com/r/cdwv/reviewphin)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](LICENSE)
[![Quality Gates](https://github.com/cdwv/ReviewPhin/actions/workflows/quality-gates.yml/badge.svg)](https://github.com/cdwv/ReviewPhin/actions/workflows/quality-gates.yml)

[Security policy](SECURITY.md)

</div>

---

ReviewPhin listens for GitLab and GitHub code review events, runs a multi-agent AI review, and publishes findings through each provider's native review model while only modifying content it created itself.

All model calls go through a configured harness (currently Copilot CLI, but more may come) so you can plug in either a subscription model or an [OpenAI-compatible API](https://reviewphin.com/docs/management/model-profiles/).

Internally, code-review operations flow through a platform adapter layer with built-in GitLab and GitHub implementations.

The container image serves the documentation hub at `/docs/`. During local Docker runs, open `http://localhost:3000/docs/`. The docs source lives in `docs/`; the homepage is built only for static-site hosts when explicitly enabled.

_Created by [@rgembalik](https://github.com/rgembalik) with support from [CodeWave](https://codewave.eu)_

## Table of Contents

- [Official docs](https://reviewphin.com/docs/)
- [Quickstart with Docker](#quickstart-with-docker)
- [Kubernetes / Helm](#kubernetes--helm)
- [Adding tenants](#adding-tenants)
- [Using ReviewPhin](#using-reviewphin)
- [How it works](#how-it-works)
- [Review pipeline](#review-pipeline)
- [Environment variables](#environment-variables)
- [Inspiration & motivation](#inspiration--motivation)
- [CLI reference](https://reviewphin.com/docs/management/cli-reference/)
- [Model providers](https://reviewphin.com/docs/management/model-profiles/)
- [Code review platform providers](https://reviewphin.com/docs/development/providers/)
- [Storage providers](https://reviewphin.com/docs/deployment/storage/)

---

## Quickstart with Docker

The published image is `cdwv/reviewphin`. It bundles the GitHub Copilot CLI for default-mode operation and exposes the `reviewphin` CLI entrypoint.

### 1. Configure the worker

Copy the example environment file and fill in your settings:

```bash
cp .env.example .env.docker
```

At minimum, set one GitHub token (for Copilot CLI mode):

```env
GH_TOKEN=<your-github-token>
```

If you prefer to configure separate GitHub API tokens for different projects, you can skip this environment variable and configure [model profiles](https://reviewphin.com/docs/management/model-profiles/).

See [Environment variables](#environment-variables) and [Model providers](https://reviewphin.com/docs/management/model-profiles/) for full options.

### 2. Start the container

```bash
docker compose up -d
```

The compose file mounts `./data` to `/app/data` (SQLite database + run logs) and `./tmp` to `/app/tmp` (hydrated workspaces). Both directories are created automatically.

> **Using GitHub?** Continue with the canonical [GitHub App setup instructions](https://reviewphin.com/docs/management/platform-connections/#github). The walkthrough below remains GitLab-first.

### 3. Expose the worker to GitLab

ReviewPhin receives GitLab webhooks over HTTPS. If your GitLab instance cannot reach your host directly, create a temporary tunnel:

```bash
# Using cloudflared (no account needed for one-off tunnels)
cloudflared tunnel --url http://localhost:3000

# Or using ngrok
ngrok http 3000
```

Note the public HTTPS URL; you will use it in the webhook settings.

For production, place ReviewPhin behind a TLS-terminating reverse proxy or use the [Helm chart](#kubernetes--helm).

### 4. Confirm it is running

```bash
curl http://localhost:3000/healthz
# {"status":"ok"}
```

---

## Kubernetes / Helm

A Helm chart is published to GHCR as `oci://ghcr.io/cdwv/charts/reviewphin`. Local checkouts can also install the chart from `.chart/`. It deploys one `Deployment`, one `Service` on port `3000`, and one `PersistentVolumeClaim` for `/app/data` and `/app/tmp`.

```bash
REVIEWPHIN_VERSION=1.4.0
REVIEWPHIN_CHART=oci://ghcr.io/cdwv/charts/reviewphin

kubectl create namespace reviewphin
kubectl create secret generic reviewphin-env \
  --namespace reviewphin \
  --from-env-file=.env.production
helm upgrade --install reviewphin "${REVIEWPHIN_CHART}" \
  --namespace reviewphin --create-namespace \
  --version "${REVIEWPHIN_VERSION}" \
  --set application.envSecret=reviewphin-env \
  --set persistence.size=1Gi
```

The chart defaults to `cdwv/reviewphin` with a tag matching the chart `appVersion`. It requires `application.envSecret`; put `PUBLIC_URL`, model authentication such as `GH_TOKEN` or `COPILOT_GITHUB_TOKEN`, and any storage settings in `.env.production` before creating the secret. If you prefer to configure separate GitHub API tokens for different projects, omit the token from this secret and configure [model profiles](https://reviewphin.com/docs/management/model-profiles/).

Ingress and Gateway API `HTTPRoute` resources are available as opt-in chart features and are disabled by default.

```bash
helm upgrade --install reviewphin "${REVIEWPHIN_CHART}" \
  --namespace reviewphin --create-namespace \
  --version "${REVIEWPHIN_VERSION}" \
  --set application.envSecret=reviewphin-env \
  --set persistence.size=1Gi \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=reviewphin.example.com
```

```bash
helm upgrade --install reviewphin "${REVIEWPHIN_CHART}" \
  --namespace reviewphin --create-namespace \
  --version "${REVIEWPHIN_VERSION}" \
  --set application.envSecret=reviewphin-env \
  --set persistence.size=1Gi \
  --set httpRoute.enabled=true \
  --set httpRoute.parentRefs[0].name=main-gateway \
  --set httpRoute.hostnames[0]=reviewphin.example.com
```

---

## Adding tenants

A **tenant** is a single project on a connected code review platform. One ReviewPhin instance can serve multiple tenants, but each tenant is configured only for one project or repository.

### 1. Create a bot identity in GitLab

Use one of:

- a **project access token** (scoped to one project)
- a **group access token** (scoped to a group)
- a **personal access token** belonging to a dedicated bot user (you must add it to project with at least Developer role)

Required scope: **`api`** - the only scope ReviewPhin uses on the token. It is needed to read code review data, create/update/resolve bot-owned discussions, and to clone the repository over Git-over-HTTPS during workspace hydration. ReviewPhin never touches content it did not author itself; the `api` scope is used solely for the read/write actions described in [Review pipeline](#review-pipeline).

Required project membership: **Developer or higher** (needed to resolve code review discussions and read repository contents).

### 2. Find the project ID and bot identity

Use the GitLab UI or API to collect the project's `id`.

### 3. Register the platform connection and tenant

The examples below use the image-provided `reviewphin` CLI for readability. With Docker Compose, run them as `docker compose run --rm worker reviewphin ...`; from a local checkout, replace `reviewphin` with `pnpm cli`. See the [CLI reference](https://reviewphin.com/docs/management/cli-reference/) for full invocation details.

```bash
reviewphin platform connection add \
  --name main-gitlab \
  --platform gitlab \
  --base-url https://gitlab.example.com \
  --api-token <your-gitlab-token>

reviewphin tenant add \
  --connection main-gitlab \
  --project-id 123 \
  --webhook-secret <your-webhook-secret>
```

`--platform` currently defaults to `gitlab`, so the flag is optional. To assign a specific model profile at registration time, add `--model-profile <name>`. See [Model providers](https://reviewphin.com/docs/management/model-profiles/) for profile setup.

For GitHub, register a GitHub App connection first. The command prints an expiring setup URL for the App Manifest flow:

```bash
reviewphin platform connection add \
  --platform github \
  --name main-github \
  --owner example-org
```

Set `PUBLIC_URL` in the worker environment before running this command.

Open the printed setup URL, complete registration and installation on GitHub, then add a repository tenant:

```bash
reviewphin tenant add \
  --platform github \
  --connection main-github \
  --repository example-org/example-repository
```

See [GitHub platform provider](https://reviewphin.com/docs/management/platform-connections/) for the full GitHub connection lifecycle.

During local development, `pnpm dev` logs a
`http://localhost:<PORT>/github/setup/samples` URL for previewing the GitHub
setup screens without creating a setup token or starting the GitHub App flow.
The sample pages use example data and are served outside `/setup/github`, so
they do not touch storage, call GitHub, or complete any setup step. These
sample routes are not mounted by the production server.

### 4. Configure platform webhooks

For GitLab, add the webhook manually.

In the project's **Settings → Webhooks**:

| Field        | Value                                           |
| ------------ | ----------------------------------------------- |
| URL          | `https://your-host/webhooks/gitlab`             |
| Secret token | the same value you passed as `--webhook-secret` |
| Trigger      | **Note events** only                            |

`/webhooks/gitlab/note` is still accepted as a backward-compatible legacy alias, but `/webhooks/gitlab` is the canonical route for new setups.

Save, then use the **Test** button (select _Note events_) to verify ReviewPhin receives the delivery and returns `202 Accepted`.

For GitHub, the App Manifest setup configures the webhook URL as
`https://your-host/webhooks/github`. The generated App must stay installed on
the repositories you register as tenants.

### 5. Verify the tenant is registered

```bash
reviewphin tenant list
```

The default table includes each tenant's platform connection name. Use `--output json` for a stable machine-readable array. See [CLI reference](https://reviewphin.com/docs/management/cli-reference/) for output modes and all tenant and model-profile commands.

---

## Using ReviewPhin

### Trigger a GitLab review

Post a merge request comment that mentions the bot:

```
@reviewphin review this
```

ReviewPhin queues a job, hydrates the code review, and creates or updates bot-owned discussions for each finding plus a summary comment at the top of the discussion list.

On first run this is a **full review** covering all changed files. On subsequent runs for the same code review it is an **incremental re-review** focused on files changed since the last run.

### Trigger a GitHub review

GitHub uses a Check Run action as the primary manual trigger. Open the pull
request's ReviewPhin Check Run and click **Run Review**. ReviewPhin provisions
the Check Run when a pull request is opened or reopened, when its head changes,
and when a GitHub tenant is added for repositories that already have open pull
requests.

ReviewPhin also accepts `/reviewphin review`, `@reviewphin review`, and
mentions of the generated App slug in pull request comments as compatibility
triggers, but GitHub does not expose those as native slash commands or reliable
mention autocomplete entries.

### Force a full re-scan

To ignore the previous review and rescan everything from scratch:

```
@reviewphin full review
```

Other accepted phrasings: `full rescan`, `fresh full review`, `rescan everything`.

### Follow-up conversations

Replies inside a bot-owned review discussion automatically queue a new pass scoped to that discussion. In GitLab this is a discussion note. In GitHub this is a reply inside a ReviewPhin-owned inline review thread. You do not need to mention the bot again:

```
# Inside a bot discussion:
Can you suggest a more readable variable name here?
```

### Teach the bot project conventions

To store a durable note in the project memory (written to the selected memory backend):

```
@reviewphin for future reference, we always prefer functional React components over class components
```

Other triggers: `remember`, `going forward`, `team policy`, `always prefer`, `please prefer`.

Project memory is owned by the configured code-review platform and storage
provider. GitHub uses the configured ReviewPhin storage provider. GitLab uses
the project wiki when GitLab project metadata reports the wiki feature enabled;
otherwise it uses the configured storage provider. If a GitLab project later
enables wiki after store-backed memory exists, the wiki wins and the store row
is deleted.

### Override the model for one code review

Add a directive in the code review **description** (the merge request description in GitLab, not a comment):

```
/reviewphin-profile byok-gpt5.4
```

This selects a named model profile for every review run on that code review. To read more about named model profiles, read [Model profiles](https://reviewphin.com/docs/management/model-profiles/).

---

## How it works

A developer starts a review from a GitLab merge request or GitHub pull request. ReviewPhin resolves the configured project, checks out the requested revision, gathers the change and its surrounding context, and sends that context to the selected model.

Findings are published through the platform's native review tools as bot-owned discussions, inline comments, suggestions, and a summary. Later reviews can focus on new changes, while replies inside existing findings continue the conversation without starting over.

The ReviewPhin worker runs on infrastructure you control, but review context is sent to the model provider you configure. When you select a hosted storage provider instead of local SQLite, persisted review state goes to that provider. Project memory follows the platform: GitHub uses the configured storage provider, while GitLab uses the project wiki when enabled and configured storage otherwise. Review AI-generated findings before acting on or merging them.

---

## Review pipeline

ReviewPhin uses three logical roles across a review: the **Router** accepts and classifies work, the **Reviewer** analyses the code, and **Chatter** handles conversations and project memory.

### 1. Receive and queue

The Router validates the incoming platform event, resolves it to a configured tenant, and decides whether it starts a review, continues a conversation, or updates existing review state. Review jobs are persisted and deduplicated before a worker claims them. No model calls happen at this stage.

### 2. Hydrate the code review

The worker checks out the exact commit under review and gathers the diff, relevant discussions, repository context, and project instruction files. This creates an isolated workspace for the model session.

### 3. Review

The Reviewer runs two sequential agents inside one model session:

1. **context-analyst** — finds the repository context most relevant to the changed files.
2. **review-author** — produces structured findings with severity, category, an optional diff anchor, and an optional inline suggestion.

The Reviewer selects a mode from the trigger context:

- **first-pass-full** — reviews the complete change on the first run or after an explicit full rescan.
- **incremental-rereview** — focuses on files changed since the previous review.
- **follow-up-discussion** — limits the pass to one existing discussion.

### 4. Publish

The platform provider reconciles the structured findings with ReviewPhin's existing output. It creates or updates bot-owned discussions and the review summary, and resolves obsolete findings where the platform supports it.

### 5. Continue conversations

Chatter answers replies inside ReviewPhin-owned discussions and decides whether durable project conventions should be added to memory. It uses the active profile's text-generation model, falling back to the review model when none is configured.

See the [technical review flow](https://reviewphin.com/docs/development/review-flow/) for queue, retry, lease, and publication details.

---

## Environment variables

All variables are optional unless noted. For local Docker from source, put them in `.env.docker`; for local runs, use `.env`.

| Variable                                             | Default                          | Description                                                                        |
| ---------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `PORT`                                               | `3000`                           | HTTP port                                                                          |
| `HOST`                                               | `0.0.0.0`                        | Bind address                                                                       |
| `PUBLIC_URL`                                         | `http://localhost:<PORT>`        | Public app URL used to print initial provider setup links                          |
| `REVIEWPHIN_ALLOW_BOT_INDEXING`                      | `false`                          | Allow crawler indexing for docs paths only (`/docs/*`) when set to `true`          |
| `REVIEWPHIN_BOT_INDEXING_ALLOWED_HOSTS`              | _(none)_                         | Comma-separated host allowlist for docs indexing; non-docs stay blocked always     |
| `LOG_LEVEL`                                          | `info`                           | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent`           |
| `STORAGE_PROVIDER_MODULE`                            | built-in SQLite                  | Module path or package name for a custom storage adapter                           |
| `PLATFORM_MODULES`                                   | `gitlab,github`                  | Comma-separated platform provider modules. Supports built-ins, paths, and packages |
| `SQLITE_DATABASE_PATH`                               | `./data/review-worker.sqlite`    | SQLite file path (ignored when a custom storage module is set)                     |
| `RUN_LOG_DIR`                                        | `./data/run-logs`                | Root directory for per-review run artifacts                                        |
| `WORKSPACE_ROOT`                                     | `./tmp/review-workspaces`        | Scratch directory for hydrated repositories                                        |
| `MAX_JOB_RETRIES`                                    | `3`                              | Retry attempts for failed review jobs                                              |
| `RETRY_BACKOFF_MS`                                   | `5000`                           | Delay (ms) between retries; preserved across restarts by the persisted queue       |
| `REVIEWPHIN_JOB_POLL_INTERVAL_MS`                    | `2000`                           | How often the runner polls storage for a claimable job (positive integer)          |
| `REVIEWPHIN_MAX_QUEUED_JOB_AGE_MS`                   | `21600000`                       | Max age from original enqueue before a queued job is expired (positive integer)    |
| `REVIEWPHIN_JOB_LEASE_MS`                            | `120000`                         | Claim lease; heartbeat renews at one third of it (minimum `1000`)                  |
| `REVIEWPHIN_JOB_RUNNER_ENABLED`                      | `true`                           | Set `false` for HTTP-only replicas that never claim or execute jobs                |
| `COPILOT_TIMEOUT_MS`                                 | `180000`                         | Model session timeout in milliseconds                                              |
| `COPILOT_SDK_LOG_LEVEL`                              | _(none)_                         | SDK log verbosity: `none` \| `error` \| `warning` \| `info` \| `debug` \| `all`    |
| `COPILOT_CLI_PATH`                                   | `/usr/local/bin/copilot` (image) | Path to the Copilot CLI binary                                                     |
| `REVIEWPHIN_MEMORY_ENABLED`                          | `true`                           | Enable per-project memory                                                          |
| `REVIEWPHIN_MAX_PROMPT_MEMORY_CHARS`                 | `5000`                           | Character budget for injected project memory                                       |
| `GH_TOKEN` / `GITHUB_TOKEN` / `COPILOT_GITHUB_TOKEN` | _(required for Copilot mode)_    | GitHub PAT with **Copilot Requests** permission                                    |

For model profile setup (BYOK providers, Azure OpenAI, etc.) see [Model providers](https://reviewphin.com/docs/management/model-profiles/).
For custom storage adapters see [Storage providers](https://reviewphin.com/docs/deployment/storage/).
For custom code review platform providers see [Code review platform providers](https://reviewphin.com/docs/development/providers/).

---

## Inspiration & motivation

ReviewPhin exists because of the work other people have already done in this space. It is not trying to compete with them - it is trying to fill a specific gap.

- **[CodeRabbit](https://www.coderabbit.ai/)** is the single biggest inspiration. The shape of the review pipeline, the way findings are reconciled as bot-owned discussions, and the overall feel of conversational follow-ups all started from "what CodeRabbit does, but self-hosted". If you can afford their per-developer pricing, they are almost certainly the better product.
- **[Greptile](https://www.greptile.com/)** is another tool in a similar space that showed me how effective the conversational, discussion-driven review format can be. I looked into it much less deeply than CodeRabbit, but I'd be lying if I said I didn't read through their docs before starting my own project. Same caveat applies - a polished hosted product run by people who do this full time and probably with better results than what ReviewPhin can provide.
- **[GitHub Copilot code review](https://docs.github.com/en/copilot/using-github-copilot/code-review)** showed me that copilot is capable of good reviews on some of my projects. The catch for me was that it lives inside GitHub, and the projects I work on primarily live on GitLab.

The motivation, then, is the intersection of three constraints those tools did not cover for me:

1. **Affordability for small teams.** Per-developer pricing scales linearly with headcount even when only a fraction of MRs need AI review. A single Copilot seat (or a self-hosted model) can drive reviews for a whole team and usually costs less than one CodeRabbit/Greptile seat. If you have spare quotas on your Copilot license, you might even be able to run ReviewPhin at no model extra cost.
2. **Bring-your-own model, including private ones.** I wanted to point the reviewer at models hosted inside our own infrastructure - e.g. a Qwen 3 27B running on internal GPUs - to push the cost down further and keep code inside the network. ReviewPhin's harness/profile system exists primarily to make that possible.
3. **GitLab first.** ReviewPhin starts from self-hosted GitLab in mind. Why? Because I use it as daily driver for most of my development work. (see [Code review platform providers](https://reviewphin.com/docs/development/providers/)).

So: **the deployment choices are yours.** You choose the storage, model provider, subscription, and hosting, including self-hosted options where they fit. If any of the projects above fits your team and budget better, please use it. They are great.
