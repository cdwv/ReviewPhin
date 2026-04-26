# GitLab agentic review worker

Node.js + TypeScript service that listens for GitLab Note Hook `/review` commands and follow-up comments on bot-owned discussions, hydrates merge request context into a temporary workspace, runs a Copilot-powered review, and reconciles the result back into GitLab discussions while only mutating bot-owned content.

## What it does

- Accepts GitLab **Note Hook** webhooks for merge request comments containing `/review` and human follow-up comments inside bot-owned review discussions
- Stores tenants, jobs, snapshots, review runs, findings, and discussion mappings in **SQLite**
- Hydrates merge request metadata, diff versions, changed files, notes, discussions, and project instructions before each run, using `git` checkout first and API fallbacks when needed
- Uses a provider boundary with a first implementation backed by **`@github/copilot-sdk`**
- Creates new discussions, updates bot-authored notes, replies in bot-created discussions, and resolves obsolete bot-owned discussions
- Emits suggestion blocks only when it has a safe single-line diff anchor on the latest merge request version

## Requirements

- Node.js 22+
- pnpm 10+
- GitHub Copilot access for the machine running the worker

## Setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Copy `.env.example` into `.env` and fill in your shared worker configuration:

   ```bash
   copy .env.example .env
   ```

3. Ensure Copilot is authenticated for the runtime user. The SDK uses the Copilot CLI runtime under the hood.

4. Start the service:

   ```bash
   pnpm dev
   ```

5.  For non-local GitLab installations you will need to expose the server to the internet, e.g. with cloudlfare:
   ```
   cloudflared tunnel --url http://localhost:3000
   ```
   
6. In GitLab Project, 
   1. create access token (group, project or user access token) that allows api writes and repo read.
   2. add webhook pointing to https://your-public-url/webhooks/gitlab/note.
   
7. Register a tenant locally with the CLI.

   ```bash
   pnpm cli tenant add --base-url https://gitlab.example.com --project-id 123 --api-token glpat-xxxxxxxx --webhook-secret replace-me --bot-user-id 999 --bot-username review-bot
   ```

8. Confirm the worker is up:

   ```bash
   curl http://localhost:3000/healthz
   ```

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

The token needs permission to:

- read merge requests, discussions, notes, versions, and repository contents
- create discussions
- reply to discussions
- edit bot-authored notes
- resolve bot-authored discussions

In practice, **API scope** on a bot-style token is the simplest starting point.

### 3. Find the project ID

You can get the numeric ID from the GitLab project page, or from the API:

```bash
curl --header "PRIVATE-TOKEN: <token>" ^
  "https://gitlab.example.com/api/v4/projects?search=agentic-review-sandbox"
```

### 4. Find the bot identity

You should configure at least one of:

- `botUserId`
- `botUsername`

`botUserId` is preferred because ownership checks are stricter.

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
COPILOT_LOG_DIR=./data/copilot-session-logs
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
3. Add a merge request comment containing `/review`.
4. Optionally reply inside one of the bot's review discussions with follow-up instructions or wording requests; that also queues a new review pass.

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
3. a merge request comment with `/review` returns HTTP `202`
4. a human reply inside a bot-owned review discussion also returns HTTP `202`
5. the worker logs show hydration and reconciliation activity
6. new or updated bot discussions appear on the merge request

## Configuration

`pnpm cli tenant add` accepts these fields:

| Field | Required | Description |
| --- | --- | --- |
| `--base-url` | Yes | GitLab instance base URL, for example `https://gitlab.example.com` or `https://gitlab.example.com/gitlab` |
| `--project-id` | Yes | Numeric GitLab project ID |
| `--api-token` | Yes | Personal, project, or group token with merge request API access |
| `--webhook-secret` | Yes | Secret expected in the `X-Gitlab-Token` header |
| `--bot-user-id` | No | Numeric GitLab bot user ID used for ownership checks |
| `--bot-username` | No | Bot username fallback used when `botUserId` is unavailable |
| `--database-path` | No | Override the SQLite path instead of using `DATABASE_PATH` from `.env` |

`COPILOT_LOG_DIR` controls where per-run Copilot session traces are written. Each trace file includes the generated prompt, streamed Copilot session events, the final assistant response when available, and any thrown error.

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
