# GitLab agentic review worker

Node.js + TypeScript service that listens for GitLab Note Hook comments that explicitly mention the configured bot username, follow-up comments on bot-owned discussions, and replies on the bot-owned review summary note, hydrates merge request context into a temporary workspace, runs a Copilot-powered review, and reconciles the result back into GitLab discussions while only mutating bot-owned content.

## What it does

- Accepts GitLab **Note Hook** webhooks for merge request comments that mention `@<botUsername>`, human follow-up comments inside bot-owned review discussions, and replies on the bot-owned review summary note, including edits to those trigger comments when users refine the instruction in place
- Treats other merge request comments as background context only; they do not trigger new review passes by themselves
- Stores tenants, jobs, snapshots, review runs, findings, and discussion mappings in **SQLite**
- Hydrates merge request metadata, diff versions, changed files, notes, discussions, and project instructions before each run, using `git` checkout first and API fallbacks when needed
- Uses a provider boundary with a first implementation backed by **`@github/copilot-sdk`**
- Creates new discussions, updates bot-authored notes, replies in bot-created discussions, and resolves obsolete bot-owned discussions
- Maintains one bot-authored merge request summary note, updating it on each run with the latest overall assessment and merge readiness
- Emits GitLab suggestion blocks when it has a safe new-side diff anchor on the latest merge request version, including multi-line suggestions when the replacement range is clear
- Keeps optional per-project memory in the GitLab project wiki page `Reviewphin memory`, so durable user-provided conventions and policies can be reused in later reviews

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

## Prompt fragments and registration

Prompt instructions are split into small markdown fragments under `prompts/` and then registered into concrete prompt combinations in code.

### Source files

- `prompts/review/*.md` contains reusable review instruction fragments such as the shared base prompt, mode-specific overlays, and subagent prompts.
- `prompts/memory/*.md` contains memory-specific prompts such as project memory coalescing.

### Prompt modules

- `src/prompts/prompt-loader.ts` loads raw prompt files from `prompts/` and caches their trimmed content.
- `src/prompts/instruction-types.ts` contains the generic type utilities used by the prompt system.
- `src/prompts/instruction-helpers.ts` contains generic helpers for defining fragments, defining templates, building static combinations, and rendering registered prompts.
- `src/prompts/instruction-registry.ts` is the source of truth for registered fragments and named prompt combinations.
- `src/prompts/instruction-renderer.ts` exposes the public `renderPrompt(...)` function used by the rest of the app.
- `src/prompts/prompt-builders.ts` builds domain-specific prompts on top of registered instruction combinations, for example by appending review JSON schema and serialized review context.

### How registration works

1. A prompt fragment is registered in `src/prompts/instruction-registry.ts` with `definePromptFragment(...)`.
2. If the fragment needs parameter substitution, its registration provides a small render function that maps typed params into the raw markdown content.
3. A practical prompt combination is then registered with a stable id such as `review.first-pass-full` or `subagent.review-author`.
4. The rest of the application renders only registered combinations through `renderPrompt(...)`; application code does not load raw prompt files directly. This makes it much easier to trace instructions we have and dedup their instructions.

### Current review flow

- `src/prompts/instruction-registry.ts` registers the instruction-only combinations for first-pass review, incremental re-review, follow-up thread review, summary follow-up overlays, review subagents, and memory coalescing.
- `src/prompts/prompt-builders.ts` selects the correct review combination for a `ReviewContext`, renders it, and appends the review response schema plus compact serialized context.
- `src/review/copilot-provider.ts` uses the same registry for subagent prompts, so review prompt selection and subagent prompt selection both come from the same registered source.

### Adding a new prompt

1. Add the markdown fragment under `prompts/review/` or `prompts/memory/`.
2. Register the fragment and a named template in `src/prompts/instruction-registry.ts`.
3. If the prompt needs domain payload beyond static instructions, wire that in `src/prompts/prompt-builders.ts` or another domain-specific builder instead of expanding the registry.

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
REVIEWPHIN_MEMORY_ENABLED=true
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

The Docker image reads the same application variables as a local run. All worker settings have image defaults.

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
| `REVIEWPHIN_MEMORY_ENABLED` | No | `true` | Enables per-project wiki-backed memory on the `Reviewphin memory` page; set to `false` to disable all reads and writes |
| `REVIEWPHIN_MAX_PROMPT_MEMORY_CHARS` | No | `5000` | Character budget used for injected project memory and for triggering memory coalescing |
| `REVIEWPHIN_TEXT_GENERATION_MODEL` | No | `auto` | Dedicated Copilot model used for memory coalescing passes |
| `COPILOT_MODEL` | No | unset | Model name passed to the Copilot CLI. Required when using a custom provider. |
| `COPILOT_CLI_PATH` | No | `/usr/local/bin/copilot` in the image | The packaged image sets this automatically to the installed Copilot CLI |

#### GitHub Copilot authentication (default mode)

When using GitHub-hosted models, set exactly one of these variables:

| Variable | Required | Description |
| --- | --- | --- |
| `GH_TOKEN` | Yes, unless any other variant is set | Preferred GitHub personal access token for the Copilot CLI |
| `GITHUB_TOKEN` | Yes, unless any other variant is set | Preferred GitHub personal access token for the Copilot CLI |
| `COPILOT_GITHUB_TOKEN` | Yes, unless any other variant is set | Fallback GitHub personal access token name recognized by the Copilot CLI |

The GitHub token used for `GH_TOKEN`, `GITHUB_TOKEN` or `COPILOT_GITHUB_TOKEN` should be a **fine-grained PAT** with the **Copilot Requests** permission. The token owner also needs an active GitHub Copilot entitlement, and if Copilot access comes from an organization or enterprise, Copilot CLI must be allowed by that org or enterprise policy.

#### Custom provider / BYOK mode (e.g. vLLM, Ollama, Azure OpenAI)

Setting `COPILOT_PROVIDER_BASE_URL` activates BYOK (Bring Your Own Key) mode. In this mode GitHub authentication is **not** required; the Copilot CLI routes all inference requests to your own endpoint instead. `COPILOT_MODEL` is required and must match the model name exposed by the provider.

| Variable | Required | Description |
| --- | --- | --- |
| `COPILOT_PROVIDER_BASE_URL` | **Yes** (to activate BYOK) | OpenAI-compatible API endpoint, e.g. `http://vllm-host:8000/v1` |
| `COPILOT_MODEL` | **Yes** | Model name as the provider knows it, e.g. `meta-llama/Llama-3.1-8B-Instruct` |
| `COPILOT_PROVIDER_TYPE` | No | `openai` (default), `azure`, or `anthropic` |
| `COPILOT_PROVIDER_API_KEY` | No | API key; not required for local providers like Ollama or vLLM without auth |
| `COPILOT_PROVIDER_BEARER_TOKEN` | No | Bearer token; takes precedence over `COPILOT_PROVIDER_API_KEY` |
| `COPILOT_PROVIDER_WIRE_API` | No | `completions` (default) or `responses` |
| `COPILOT_PROVIDER_MODEL_ID` | No | Well-known base model ID used for internal capability and token-limit lookup when the wire model name differs (e.g. a fine-tune or Azure deployment name) |
| `COPILOT_PROVIDER_WIRE_MODEL` | No | Exact model identifier sent to the provider API; defaults to `COPILOT_MODEL` |
| `COPILOT_PROVIDER_MAX_PROMPT_TOKENS` | No | Override max prompt tokens for the model |
| `COPILOT_PROVIDER_MAX_OUTPUT_TOKENS` | No | Override max output tokens for the model |

**vLLM example** (no auth required when vLLM runs without an API key):

```env
COPILOT_PROVIDER_BASE_URL=http://vllm-host:8000/v1
COPILOT_MODEL=meta-llama/Llama-3.1-8B-Instruct
```

**Azure OpenAI example** (must use `type=azure` for `*.openai.azure.com` endpoints):

```env
COPILOT_PROVIDER_TYPE=azure
COPILOT_PROVIDER_BASE_URL=https://my-resource.openai.azure.com
COPILOT_PROVIDER_API_KEY=your-key-here
COPILOT_PROVIDER_MODEL_ID=gpt-4
COPILOT_PROVIDER_WIRE_MODEL=my-gpt4-deployment
COPILOT_MODEL=my-gpt4-deployment
```

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

#### Per-project memory

When `REVIEWPHIN_MEMORY_ENABLED=true`, the worker reads and writes a dedicated project wiki page named `Reviewphin memory`.

- The page is machine-managed in a structured Markdown format.
- Its contents are loaded into every review as durable project context, using the `REVIEWPHIN_MAX_PROMPT_MEMORY_CHARS` budget.
- The model may update it when a user comment clearly communicates long-term guidance such as team policy, stable convention, or "for future reference" knowledge.
- If the wiki is disabled or temporarily unavailable, the review still runs and simply skips project memory for that pass.
- When the managed memory grows close to the configured character budget, Reviewphin runs a dedicated coalescing pass with `REVIEWPHIN_TEXT_GENERATION_MODEL` to merge duplicates and shrink the stored memory before saving.
- One-off review remarks, temporary incidents, and merge-request-specific instructions should not be stored there.

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
