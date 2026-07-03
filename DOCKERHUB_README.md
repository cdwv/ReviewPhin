<div align="center">
  <img src="./public/favicon.png" alt="ReviewPhin" width="120" />

# ReviewPhin

**Self-hosted AI code review for GitLab and GitHub.**
Run on your own infrastructure. Bring your own model. Use your own agent subscription to pay per review, not per developer.

[![Docker Image](https://img.shields.io/badge/docker-cdwv%2Freviewphin-blue?logo=docker)](https://hub.docker.com/r/cdwv/reviewphin)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](./LICENSE)

</div>

---

ReviewPhin listens for GitLab and GitHub code review events, runs a multi-agent AI review, and publishes findings through each provider's native review model while only modifying content it created itself.

All model calls go through a configured harness (currently Copilot CLI, but more may come) so you can plug in either a subscription model or an [OpenAI-compatible API](https://reviewphin.codewave.pl/docs/management/model-profiles/).

Internally, code-review operations flow through a platform adapter layer with built-in GitLab and GitHub implementations.

The container image serves the documentation hub at `/docs/`. During local Docker runs, open `http://localhost:3000/docs/`. The docs source lives in `docs/`; the homepage is built only for static-site hosts when explicitly enabled.

_Created by [@rgembalik](https://github.com/rgembalik) with support from [CodeWave](https://codewave.eu)_

## Table of Contents

- [Official docs](https://reviewphin.codewave.pl/docs/)
- [Quickstart with Docker](#quickstart-with-docker)
- [Kubernetes / Helm](#kubernetes--helm)
- [Adding tenants](#adding-tenants)
- [Using ReviewPhin](#using-reviewphin)
- [How it works](#how-it-works)
- [Review pipeline](#review-pipeline)
- [Technologies](#technologies)
- [Environment variables](#environment-variables)
- [Inspiration & motivation](#inspiration--motivation)
- [CLI reference](https://reviewphin.codewave.pl/docs/management/cli-reference/)
- [Model providers](https://reviewphin.codewave.pl/docs/management/model-profiles/)
- [Code review platform providers](https://reviewphin.codewave.pl/docs/development/providers/)
- [Storage providers](https://reviewphin.codewave.pl/docs/deployment/storage/)

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

If you prefer to configure separate GitHub API tokens for different projects, you can skip this environment variable and configure [model profiles](https://reviewphin.codewave.pl/docs/management/model-profiles/).

See [Environment variables](#environment-variables) and [Model providers](https://reviewphin.codewave.pl/docs/management/model-profiles/) for full options.

### 2. Start the container

```bash
docker compose up -d
```

The compose file mounts `./data` to `/app/data` (SQLite database + run logs) and `./tmp` to `/app/tmp` (hydrated workspaces). Both directories are created automatically.

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

A Helm chart is included in `.chart/`. It deploys one `Deployment`, one `Service` on port `3000`, and one `PersistentVolumeClaim` for `/app/data` and `/app/tmp`.

```bash
kubectl create namespace reviewphin
kubectl create secret generic reviewphin-env \
  --namespace reviewphin \
  --from-env-file=.env.production
helm upgrade --install reviewphin .chart/ \
  --namespace reviewphin --create-namespace \
  --set image.repository=cdwv/reviewphin \
  --set image.tag=<version> \
  --set application.envSecret=reviewphin-env \
  --set persistence.size=1Gi
```

The chart requires `image.repository`, `image.tag`, and `application.envSecret`; the default values file leaves the image fields empty on purpose. Put `PUBLIC_URL`, model authentication such as `GH_TOKEN` or `COPILOT_GITHUB_TOKEN`, and any storage settings in `.env.production` before creating the secret. If you prefer to configure separate GitHub API tokens for different projects, omit the token from this secret and configure [model profiles](https://reviewphin.codewave.pl/docs/management/model-profiles/).

Ingress and Gateway API `HTTPRoute` resources are available as opt-in chart features and are disabled by default.

```bash
helm upgrade --install reviewphin .chart/ \
  --namespace reviewphin --create-namespace \
  --set image.repository=cdwv/reviewphin \
  --set image.tag=<version> \
  --set application.envSecret=reviewphin-env \
  --set persistence.size=1Gi \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=reviewphin.example.com
```

```bash
helm upgrade --install reviewphin .chart/ \
  --namespace reviewphin --create-namespace \
  --set image.repository=cdwv/reviewphin \
  --set image.tag=<version> \
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

#### In a Docker container

```bash
docker compose run --rm worker reviewphin platform connection add \
  --name main-gitlab \
  --platform gitlab \
  --base-url https://gitlab.example.com \
  --api-token <your-gitlab-token>

docker compose run --rm worker reviewphin tenant add \
  --connection main-gitlab \
  --project-id 123 \
  --webhook-secret <your-webhook-secret>
```

#### From a local checkout

```bash
pnpm cli platform connection add \
  --name main-gitlab \
  --platform gitlab \
  --base-url https://gitlab.example.com \
  --api-token <your-gitlab-token>

pnpm cli tenant add \
  --connection main-gitlab \
  --project-id 123 \
  --webhook-secret <your-webhook-secret>
```

`--platform` currently defaults to `gitlab`, so the flag is optional. To assign a specific model profile at registration time, add `--model-profile <name>`. See [Model providers](https://reviewphin.codewave.pl/docs/management/model-profiles/) for profile setup.

For GitHub, register a GitHub App connection first. The command prints an expiring setup URL for the App Manifest flow:

```bash
docker compose run --rm -e PUBLIC_URL=https://reviewphin.example.com worker reviewphin platform connection add \
  --platform github \
  --name main-github \
  --owner example-org
```

Open the printed setup URL, complete registration and installation on GitHub, then add a repository tenant:

```bash
docker compose run --rm worker reviewphin tenant add \
  --platform github \
  --connection main-github \
  --repository example-org/example-repository
```

From a local checkout, use the same `platform connection add` and `tenant add` arguments with `pnpm cli`. See [GitHub platform provider](https://reviewphin.codewave.pl/docs/management/platform-connections/) for the full GitHub connection lifecycle.

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
# Docker
docker compose run --rm worker reviewphin tenant list

# Local
pnpm cli tenant list
```

The JSON output includes each tenant's `id`, `key`, and `platform`. See [CLI reference](https://reviewphin.codewave.pl/docs/management/cli-reference/) for all tenant and model-profile commands.

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

This selects a named model profile for every review run on that code review. To read more about named model profiles, read [Model profiles](https://reviewphin.codewave.pl/docs/management/model-profiles/).

---

## How it works

1. A developer triggers a review from GitLab comments, GitHub pull request comments, or the GitHub **Run Review** Check Run action.
2. ReviewPhin receives the platform webhook, validates the signature, resolves the tenant, and queues a job.
3. The **Router** hydrates the code review: it checks out the exact commit, fetches diffs, notes, and any project instruction files.
4. The **Reviewer** (a two-agent pipeline) analyses the changes and produces structured findings with severity, category, optional line anchors, and inline code suggestions.
5. The **Chatter** handles follow-up replies, conversational questions, and durable project memory updates.
6. Findings are reconciled back through the platform provider as bot-owned review output. Obsolete threads are resolved where the platform supports it; the summary comment is updated.

All code and data stay on your infrastructure. The worker calls the configured model API and the connected code review platform API; nothing else leaves the network.

---

## Review pipeline

ReviewPhin uses three logical components for each triggered review:

### Router

The webhook handler validates the platform signature, classifies the trigger (direct mention, Check Run action, follow-up reply, or summary note reply), deduplicates concurrent jobs, and enqueues a review task. No model calls happen here.

### Reviewer

The main agent runs as two sequential subagents inside a single model session:

1. **context-analyst** - explores the hydrated workspace using `glob`, `ripgrep`, and file-read tools to gather the context most relevant to the changed files.
2. **review-author** - produces structured findings: severity, category, body text, optional diff anchor, and optional inline code suggestion.

The reviewer selects one of three modes based on trigger context:

- **first-pass-full** - first review of the MR, or an explicit full rescan
- **incremental-rereview** - focused on files changed since the last review
- **follow-up-discussion** - scoped to one existing discussion

### Chatter

A lightweight agent that runs after the reviewer (when applicable). It handles:

- conversational replies to questions or wording requests
- project memory decisions (`add_memory_entry` tool writes to the selected memory backend)
- reply text for explicit follow-up targets

Chatter uses the `textGenerationModel` from the active profile (falling back to the review model when unset), keeping lighter interactions cheaper.

---

## Technologies

| Layer              | Technology                                    |
| ------------------ | --------------------------------------------- |
| Runtime            | Node.js 22, TypeScript 5                      |
| HTTP server        | Fastify 5                                     |
| AI runtime         | `@github/copilot-sdk` (Copilot CLI wrapper)   |
| Model APIs         | native Copilot, vLLM, Azure OpenAI, Anthropic |
| Storage (default)  | SQLite via Node.js `node:sqlite`              |
| Storage (optional) | Flotiq headless CMS                           |
| Logging            | pino (structured JSON)                        |
| Validation         | zod                                           |
| Packaging          | Docker, multi-stage build                     |
| Orchestration      | Helm (Kubernetes)                             |

---

## Environment variables

All variables are optional unless noted. For local Docker from source, put them in `.env.docker`; for local runs, use `.env`.

| Variable                                             | Default                          | Description                                                                        |
| ---------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `PORT`                                               | `3000`                           | HTTP port                                                                          |
| `HOST`                                               | `0.0.0.0`                        | Bind address                                                                       |
| `PUBLIC_URL`                                         | `http://localhost:<PORT>`        | Public app URL used to print initial provider setup links                          |
| `REVIEWPHIN_ALLOW_BOT_INDEXING`                      | `false`                          | Allow crawler indexing for docs paths only (`/docs/*`) when set to `true`         |
| `REVIEWPHIN_BOT_INDEXING_ALLOWED_HOSTS`              | _(none)_                         | Comma-separated host allowlist for docs indexing; non-docs stay blocked always     |
| `LOG_LEVEL`                                          | `info`                           | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent`           |
| `STORAGE_PROVIDER_MODULE`                            | built-in SQLite                  | Module path or package name for a custom storage adapter                           |
| `PLATFORM_MODULES`                                   | `gitlab,github`                  | Comma-separated platform provider modules. Supports built-ins, paths, and packages |
| `SQLITE_DATABASE_PATH`                               | `./data/review-worker.sqlite`    | SQLite file path (ignored when a custom storage module is set)                     |
| `RUN_LOG_DIR`                                        | `./data/run-logs`                | Root directory for per-review run artifacts                                        |
| `WORKSPACE_ROOT`                                     | `./tmp/review-workspaces`        | Scratch directory for hydrated repositories                                        |
| `MAX_JOB_RETRIES`                                    | `3`                              | Retry attempts for failed review jobs                                              |
| `RETRY_BACKOFF_MS`                                   | `5000`                           | Delay (ms) between retries                                                         |
| `COPILOT_TIMEOUT_MS`                                 | `180000`                         | Model session timeout in milliseconds                                              |
| `COPILOT_SDK_LOG_LEVEL`                              | _(none)_                         | SDK log verbosity: `none` \| `error` \| `warning` \| `info` \| `debug` \| `all`    |
| `COPILOT_CLI_PATH`                                   | `/usr/local/bin/copilot` (image) | Path to the Copilot CLI binary                                                     |
| `REVIEWPHIN_MEMORY_ENABLED`                          | `true`                           | Enable per-project memory                                                          |
| `REVIEWPHIN_MAX_PROMPT_MEMORY_CHARS`                 | `5000`                           | Character budget for injected project memory                                       |
| `GH_TOKEN` / `GITHUB_TOKEN` / `COPILOT_GITHUB_TOKEN` | _(required for Copilot mode)_    | GitHub PAT with **Copilot Requests** permission                                    |

For model profile setup (BYOK providers, Azure OpenAI, etc.) see [Model providers](https://reviewphin.codewave.pl/docs/management/model-profiles/).
For custom storage adapters see [Storage providers](https://reviewphin.codewave.pl/docs/deployment/storage/).
For custom code review platform providers see [Code review platform providers](https://reviewphin.codewave.pl/docs/development/providers/).

---

## Routes

| Method | Path                    | Description                                                                        |
| ------ | ----------------------- | ---------------------------------------------------------------------------------- |
| `GET`  | `/healthz`              | Liveness probe, returns `{"status":"ok"}`                                          |
| `POST` | `/webhooks/<platform>`  | Platform webhook receiver. Built-ins use `/webhooks/gitlab` and `/webhooks/github` |
| `*`    | `/setup/<platform>`     | Optional platform setup handler when the provider exposes one                      |
| `GET`  | `/github/setup/samples` | Dev-server-only GitHub setup template previews with example data                   |
| `POST` | `/webhooks/gitlab/note` | Deprecated GitLab compatibility alias                                              |

---

## Inspiration & motivation

ReviewPhin exists because of the work other people have already done in this space. It is not trying to compete with them - it is trying to fill a specific gap.

- **[CodeRabbit](https://www.coderabbit.ai/)** is the single biggest inspiration. The shape of the review pipeline, the way findings are reconciled as bot-owned discussions, and the overall feel of conversational follow-ups all started from "what CodeRabbit does, but self-hosted". If you can afford their per-developer pricing, they are almost certainly the better product.
- **[Greptile](https://www.greptile.com/)** is another tool in a similar space that showed me how effective the conversational, discussion-driven review format can be. I looked into it much less deeply than CodeRabbit, but I'd be lying if I said I didn't read through their docs before starting my own project. Same caveat applies - a polished hosted product run by people who do this full time and probably with better results than what ReviewPhin can provide.
- **[GitHub Copilot code review](https://docs.github.com/en/copilot/using-github-copilot/code-review)** showed me that copilot is capable of good reviews on some of my projects. The catch for me was that it lives inside GitHub, and the projects I work on primarily live on GitLab.

The motivation, then, is the intersection of three constraints those tools did not cover for me:

1. **Affordability for small teams.** Per-developer pricing scales linearly with headcount even when only a fraction of MRs need AI review. A single Copilot seat (or a self-hosted model) can drive reviews for a whole team and usually costs less than one CodeRabbit/Greptile seat. If you have spare quotas on your Copilot license, you might even be able to run ReviewPhin at no model extra cost.
2. **Bring-your-own model, including private ones.** I wanted to point the reviewer at models hosted inside our own infrastructure - e.g. a Qwen 3 27B running on internal GPUs - to push the cost down further and keep code inside the network. ReviewPhin's harness/profile system exists primarily to make that possible.
3. **GitLab first.** ReviewPhin starts from self-hosted GitLab in mind. Why? Because I use it as daily driver for most of my development work. (see [Code review platform providers](https://reviewphin.codewave.pl/docs/development/providers/)).

So: **everything is yours.** Storage, model, subscription, hosting. You know what you pay for because it's all yours - and if any of the projects above fits your team and budget better, please use them. They are great.
