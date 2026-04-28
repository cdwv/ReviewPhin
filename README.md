# GitLab agentic review worker

Node.js + TypeScript service that listens for GitLab Note Hook comments that explicitly mention the configured bot username and follow-up comments on bot-owned discussions, hydrates merge request context into a temporary workspace, runs a Copilot-powered review, and reconciles the result back into GitLab discussions while only mutating bot-owned content.

## What it does

- Accepts GitLab **Note Hook** webhooks for merge request comments that mention `@<botUsername>` and human follow-up comments inside bot-owned review discussions, including edits to those trigger comments when users refine the instruction in place
- Treats other merge request comments as background context only; they do not trigger new review passes by themselves
- Stores tenants, jobs, snapshots, review runs, findings, and discussion mappings in **SQLite**
- Hydrates merge request metadata, diff versions, changed files, notes, discussions, and project instructions before each run, using `git` checkout first and API fallbacks when needed
- Uses a provider boundary with a first implementation backed by **`@github/copilot-sdk`**
- Creates new discussions, updates bot-authored notes, replies in bot-created discussions, and resolves obsolete bot-owned discussions
- Maintains one bot-authored merge request summary note, updating it on each run with the latest overall assessment and merge readiness
- Emits GitLab suggestion blocks when it has a safe new-side diff anchor on the latest merge request version, including multi-line suggestions when the replacement range is clear

## Requirements

- Node.js 22+
- pnpm 10+
- GitHub Copilot access for the machine running the worker (an active Copilot subscription or organization entitlement with Copilot CLI enabled)
- Docker + Docker Compose (only when running the packaged container image)

## Setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. (optionally) Copy `.env.example` into `.env` (or `.env.docker` if using `docker compose`) and fill in your shared worker configuration:

   ```bash
   copy .env.example .env
   ```

3. Ensure Copilot is authenticated for the runtime user. The SDK uses the Copilot CLI runtime under the hood. For local runs an interactive `copilot` login is fine; for Docker or other non-interactive runs, `COPILOT_GITHUB_TOKEN` (or `GH_TOKEN` or `GITHUB_TOKEN`) with a fine-grained GitHub PAT that has the **Copilot Requests** permission.

4. Start the service:

   ```bash
   pnpm dev
   ```

5.  For non-local GitLab installations you will need to expose the server to the internet, e.g. with cloudlfare:
   ```
   cloudflared tunnel --url http://localhost:3000
   ```
   
6. In GitLab Project, 
   1. create a bot token (group, project, or user access token) with `api` scope; if it maps to a project member or bot user, make that identity at least `Developer` because the worker resolves merge request discussions.
   2. add webhook pointing to https://your-public-url/webhooks/gitlab/note.
   
7. Register a tenant locally with the CLI.

   ```bash
   pnpm cli tenant add --base-url https://gitlab.example.com --project-id 123 --api-token glpat-xxxxxxxx --webhook-secret replace-me --bot-user-id 999 --bot-username review-bot
   ```

8. Confirm the worker is up:

   ```bash
   curl http://localhost:3000/healthz
   ```

## Running with Docker

The repository includes a multi-stage `Dockerfile` and a `docker-compose.yml` that build the worker, install the GitHub Copilot CLI, and run the compiled service on port `3000`.

1. Copy `.env.example` to `.env.docker`.
2. Fill in any worker settings you want to override and uncomment `COPILOT_GITHUB_TOKEN` with a fine-grained GitHub personal access token that has the **Copilot Requests** permission.
3. Build and start the container:

   ```bash
   docker compose up --build -d
   ```

4. Register at least one tenant in the container-backed SQLite database:

   ```bash
   docker compose run --rm worker node dist/cli.js tenant add --base-url https://gitlab.example.com --project-id 123 --api-token glpat-xxxxxxxx --webhook-secret replace-me --bot-user-id 999 --bot-username review-bot
   ```

5. Confirm the container is healthy:

   ```bash
   curl http://localhost:3000/healthz
   ```

The compose setup mounts:

- `./data` into `/app/data` for the SQLite database and per-review run logs
- `./tmp` into `/app/tmp` for hydrated review workspaces

Keep tenant records in the SQLite database by using the CLI command above; tenant configuration is not provided through environment variables.

## GitLab CI + Helm deployment

The repository now includes:

- `.gitlab-ci.yml` for test coverage on merge requests and `main`, plus OCI image build and deployment from `main`
- `.chart/` with the Helm chart used by the deployment job

The chart intentionally keeps cluster-specific settings out of `values.yaml`. The GitLab deployment job passes them with `helm upgrade --set ...`.

### What the chart deploys

- one `Deployment` for the Node.js worker
- one `Service` on port `3000`
- one `PersistentVolumeClaim`, mounted into `/app/data` and `/app/tmp`
- no ingress resource

### GitLab CI variables

The pipeline now assumes sensible defaults for the deployment settings and only needs overrides when your cluster differs:

- `KUBE_NAMESPACE` (optional; defaults to `${CI_PROJECT_NAME}-${CI_PROJECT_ID}`)
- `KUBECTL_CONTEXT` (optional, only if the runner must switch kube context explicitly)
- `HELM_CPU_REQUEST` (optional; defaults to `250m`)
- `HELM_CPU_LIMIT` (optional; defaults to `500m`)
- `HELM_MEMORY_REQUEST` (optional; defaults to `512Mi`)
- `HELM_MEMORY_LIMIT` (optional; defaults to `1Gi`)
- `HELM_PVC_SIZE` (optional; defaults to `10Gi`)
- `HELM_PVC_STORAGE_CLASS` (optional if your cluster default is acceptable)

GitLab exposes `CI_ENVIRONMENT_URL` automatically from the environment definition. For `production`, the pipeline sets it to `https://reviewphin.codewave.pl`.

App-shaped defaults such as replica count, service type/port, probe path, and PVC access mode now live in `.chart/values.yaml` instead of being passed from CI.

Application secrets are expected to be managed by the internal `generic-secrets` template include. The deployment consumes the generated `${CI_ENVIRONMENT_SLUG}-env-secrets` secret as container environment variables.

## Running locally

For a normal local run:

1. Copy `.env.example` to `.env`.
2. Register at least one tenant locally with the CLI.
3. Start the worker with `pnpm dev`.
4. Expose the local port to GitLab if your GitLab instance cannot reach your machine directly.

Useful commands:

- `pnpm dev` - start in watch mode
- `pnpm start` - run the built app from `dist`
- `pnpm build` - compile TypeScript
- `pnpm test` - run tests

## Add a test GitLab server and project

The worker treats each GitLab target as a **tenant** keyed by:

- `baseUrl` = GitLab server URL
- `projectId` = numeric GitLab project ID

One tenant entry lets the worker review one project on one GitLab server.

### 1. Create a test project

In GitLab:

1. Create a project, for example `agentic-review-sandbox`.
2. Make sure merge requests are enabled.
3. Create a test branch and open a merge request into your default branch.

### 2. Create an API token for that project/server

Use one of:

- a dedicated bot user's personal access token
- a project access token
- a group access token

This worker uses the GitLab API to read merge requests, notes, discussions, versions, raw files, and repository archives, and it also creates discussions, replies, edits bot-authored notes, resolves discussions, and authenticates `git fetch` over HTTPS during workspace hydration.

From the GitLab token docs:

- `read_repository` and `read_api` are read-only scopes
- `api` grants read/write API access, and for personal access tokens also covers Git-over-HTTP access used by the worker's `git fetch`

Use **`api` scope** for this worker.

For project membership, GitLab's permissions docs say project members can leave comments starting at **Guest**, repository/code access starts at **Reporter**, and resolving merge request threads requires **Developer** or the merge request author. Because this worker reads repository contents and resolves obsolete merge request discussions during reconciliation, the bot user or token-backed account should be **Developer or higher** in the target project.

### 3. Find the project ID

You can get the numeric ID from the GitLab project page, or from the API:

```bash
curl --header "PRIVATE-TOKEN: <token>" ^
  "https://gitlab.example.com/api/v4/projects?search=agentic-review-sandbox"
```

### 4. Find the bot identity

You should configure:

- `botUsername`
- `botUserId` (optional, but recommended for stricter ownership checks)

`botUsername` is required because direct mention triggers match against that username. `botUserId` is still recommended because ownership checks are stricter.

You can fetch the current token identity with:

```bash
curl --header "PRIVATE-TOKEN: <token>" ^
  "https://gitlab.example.com/api/v4/user"
```

Use the returned `id` as `botUserId` and `username` as `botUsername`.

### 5. Add the tenant locally with the CLI

Keep the shared worker settings in `.env`:

```env
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=debug
DATABASE_PATH=./data/review-worker.sqlite
RUN_LOG_DIR=./data/run-logs
WORKSPACE_ROOT=./tmp/review-workspaces
MAX_JOB_RETRIES=3
RETRY_BACKOFF_MS=5000
COPILOT_TIMEOUT_MS=180000
COPILOT_MODEL=gpt-5.4
```

Then add the tenant to the local SQLite database used by the worker:

```bash
pnpm cli tenant add --base-url https://gitlab.example.com --project-id 123 --api-token glpat-xxxxxxxx --webhook-secret replace-me --bot-user-id 999 --bot-username review-bot
```

If you store the worker database somewhere else, pass `--database-path`.

To inspect what is registered locally:

```bash
pnpm cli tenant list
```

To add another test project on the same server, run `tenant add` again with a different `projectId`.

To add another GitLab server, run `tenant add` again with a different `baseUrl`.

### 6. Add the webhook in GitLab

In the test project's **Settings -> Webhooks**:

1. Set the URL to your worker endpoint:

   ```text
   http://your-host:3000/webhooks/gitlab/note
   ```

2. Set the secret token to the same value as `webhookSecret`.
3. Enable **Note events**.
4. Save the webhook.

If GitLab cannot reach your laptop directly, expose the worker with a tunnel such as:

- `ngrok http 3000`
- `cloudflared tunnel --url http://localhost:3000`

Then use the public HTTPS URL from the tunnel in the webhook settings.

### 7. Trigger a test review

1. Push a branch with a code change.
2. Open or update a merge request.
3. Add a merge request comment containing `@review-bot` (or whatever `botUsername` you configured), for example `@review-bot review this`.
4. Optionally reply inside one of the bot's review discussions with follow-up instructions or wording requests; those replies also queue a new review pass without requiring another mention.

If everything is configured correctly, the worker will:

1. accept the Note Hook event
2. queue a review job
3. hydrate the merge request
4. run the Copilot review
5. create or update bot-owned GitLab discussions

Repository hydration currently tries, in order:

1. a `git` fetch/checkout of the exact merge request SHA
2. the GitLab repository archive API
3. targeted raw-file downloads for changed files and instruction files

## End-to-end smoke test

After the worker is running, verify the path in this order:

1. `GET /healthz` returns `{"status":"ok"}`
2. GitLab webhook test delivery reaches `POST /webhooks/gitlab/note`
3. a merge request comment with `@<botUsername>` returns HTTP `202`
4. a human reply inside a bot-owned review discussion also returns HTTP `202`
5. the worker logs show hydration and reconciliation activity
6. new or updated bot discussions appear on the merge request

## Configuration

### Container environment variables

The Docker image reads the same application variables as a local run. All worker settings have image defaults, but Copilot authentication still needs to be supplied explicitly.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | No | `3000` | HTTP port exposed by the worker |
| `HOST` | No | `0.0.0.0` | Bind address inside the container |
| `LOG_LEVEL` | No | `info` | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `DATABASE_PATH` | No | `./data/review-worker.sqlite` | SQLite database path; keep this under `/app/data` if you want it persisted by compose |
| `RUN_LOG_DIR` | No | `./data/run-logs` | Root directory for per-review run artifacts, including Copilot traces, GitLab HTTP logs, and worker app logs |
| `WORKSPACE_ROOT` | No | `./tmp/review-workspaces` | Scratch directory for hydrated repositories |
| `MAX_JOB_RETRIES` | No | `3` | Retry attempts for failed review jobs |
| `RETRY_BACKOFF_MS` | No | `5000` | Delay between retries in milliseconds |
| `COPILOT_TIMEOUT_MS` | No | `180000` | Copilot review timeout in milliseconds |
| `COPILOT_MODEL` | No | unset | Optional model override passed to the Copilot SDK |
| `COPILOT_CLI_PATH` | No | `/usr/local/bin/copilot` in the image | The packaged image sets this automatically to the installed Copilot CLI |

For Copilot CLI authentication inside the image, set exactly one of these variables:

| Variable | Required | Description |
| --- | --- | --- |
| `GH_TOKEN` | Yes, unless any other variant is set | Preferred GitHub personal access token for the Copilot CLI |
| `GITHUB_TOKEN` | Yes, unless any other variant is set | Preferred GitHub personal access token for the Copilot CLI |
| `COPILOT_GITHUB_TOKEN` | Yes, unless any other variant is set | Fallback GitHub personal access token name recognized by the Copilot CLI |

The GitHub token used for `GH_TOKEN`, `GITHUB_TOKEN` or `COPILOT_GITHUB_TOKEN` should be a **fine-grained PAT** with the **Copilot Requests** permission. The token owner also needs an active GitHub Copilot entitlement, and if Copilot access comes from an organization or enterprise, Copilot CLI must be allowed by that org or enterprise policy.

`pnpm cli tenant add` accepts these fields:

| Field | Required | Description |
| --- | --- | --- |
| `--base-url` | Yes | GitLab instance base URL, for example `https://gitlab.example.com` or `https://gitlab.example.com/gitlab` |
| `--project-id` | Yes | Numeric GitLab project ID |
| `--api-token` | Yes | Personal, project, or group token with merge request API access |
| `--webhook-secret` | Yes | Secret expected in the `X-Gitlab-Token` header |
| `--bot-user-id` | No | Numeric GitLab bot user ID used for stricter ownership checks |
| `--bot-username` | Yes | Bot username used for direct mention matching |
| `--database-path` | No | Override the SQLite path instead of using `DATABASE_PATH` from `.env` |

`RUN_LOG_DIR` controls where per-review run artifacts are written. Each `reviewRunId` gets its own directory containing a `copilot` subdirectory with the prompt/session trace, a `gitlab-http.ndjson` file with GitLab request and response logs, and an `app.ndjson` file with worker lifecycle logging. The legacy `COPILOT_LOG_DIR` environment variable is still accepted as a fallback alias.

`COPILOT_TIMEOUT_MS` controls how long the worker waits for Copilot to finish a review turn before treating it as failed. The default is `180000` (3 minutes).

`baseUrl` may include a path prefix for self-hosted installs behind a reverse proxy, but it should point to the GitLab instance root, not directly to `/api/v4`. The worker normalizes `/api/v4` away if you include it by mistake.

The editable review instruction templates live in `prompts/review/`:

- `prompts/review/main.md`
- `prompts/review/context-analyst.md`
- `prompts/review/review-author.md`

## Routes

- `GET /healthz` returns liveness information
- `POST /webhooks/gitlab/note` accepts GitLab Note Hook payloads

## Development commands

- `pnpm build`
- `pnpm lint`
- `pnpm test`
