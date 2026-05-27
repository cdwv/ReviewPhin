# ReviewPhin CLI reference

The CLI manages tenants, model profiles, and storage from the command line.

**In Docker**, the compiled entrypoint is exposed as the `reviewphin` command:

```bash
docker compose run --rm worker reviewphin <resource> <action> [options]
```

**In a local checkout**, use `pnpm cli`:

```bash
pnpm cli <resource> <action> [options]
```

Both invocations accept the same flags.

---

## Tenant commands

Tenants belong to a code review platform. Today the only supported platform is GitLab, so a tenant is effectively a `(GitLab instance URL, project ID)` pair plus platform metadata.

### `tenant add`

Register a new tenant. Today GitLab is the only supported platform, so `--platform gitlab` is optional and defaults to GitLab.

```bash
reviewphin tenant add \
  --platform gitlab \
  --base-url https://gitlab.example.com \
  --project-id 123 \
  --api-token glpat-xxxxxxxx \
  --webhook-secret replace-me
```

| Flag                        | Required | Description                                                                                                                            |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--platform`                | No       | Code review platform slug. Currently only `gitlab` is supported. Defaults to `gitlab`.                                                |
| `--base-url`                | Yes      | GitLab instance root URL. May include a path prefix for proxied installs. Do not include `/api/v4`.                                    |
| `--project-id`              | Yes      | Numeric GitLab project ID.                                                                                                             |
| `--api-token`               | Yes      | Project, group, or personal access token with `api` scope.                                                                             |
| `--webhook-secret`          | Yes      | Value expected in the `X-Gitlab-Token` header for this project's webhooks.                                                             |
| `--bot-user-id`             | No       | Numeric GitLab user ID of the bot. If not provided, it will be requested from gitlab api with provided token.                          |
| `--bot-username`            | No       | GitLab username of the bot. Used to match direct mentions.  If not provided, it will be requested from gitlab api with provided token. |  |
| `--model-profile`           | No       | Assign a named model profile to this tenant at registration time.                                                                      |
| `--sqlite-database-path`    | No       | Override the SQLite file path instead of reading `SQLITE_DATABASE_PATH` from `.env`.                                                   |
| `--storage-provider-module` | No       | Override the storage adapter module instead of reading `STORAGE_PROVIDER_MODULE` from `.env`.                                          |

---

### `tenant list`

Print all registered tenants.

```bash
reviewphin tenant list
```

The JSON output includes each tenant's `id`, `key`, `platform`, and `modelProfileName`.

| Flag                        | Required | Description                  |
| --------------------------- | -------- | ---------------------------- |
| `--sqlite-database-path`    | No       | Override the SQLite path.    |
| `--storage-provider-module` | No       | Override the storage module. |

---

### `tenant set-profile`

Assign an existing model profile to a tenant.

```bash
reviewphin tenant set-profile \
  --key https://gitlab.example.com::123 \
  --model-profile byok-gpt4
```

| Flag                        | Required | Description                                     |
| --------------------------- | -------- | ----------------------------------------------- |
| `--tenant-id`               | Yes*     | Internal tenant ID (ULID).                      |
| `--key`                     | Yes*     | Stable tenant key printed by `tenant list`.     |
| `--model-profile`           | Yes      | Name of the profile to assign.                  |
| `--sqlite-database-path`    | No       | Override the SQLite path.                       |
| `--storage-provider-module` | No       | Override the storage module.                    |

\* Provide either `--tenant-id` or `--key`.

---

### `tenant clear-profile`

Remove the model profile assignment from a tenant (falls back to the database default).

```bash
reviewphin tenant clear-profile \
  --key https://gitlab.example.com::123
```

| Flag                        | Required | Description                                 |
| --------------------------- | -------- | ------------------------------------------- |
| `--tenant-id`               | Yes*     | Internal tenant ID (ULID).                  |
| `--key`                     | Yes*     | Stable tenant key printed by `tenant list`. |
| `--sqlite-database-path`    | No       | Override the SQLite path.                   |
| `--storage-provider-module` | No       | Override the storage module.                |

\* Provide either `--tenant-id` or `--key`.

---

### `tenant remove`

Deregister a tenant and clean up its data. Prints a deletion summary (database rows, run-log directories, hydrated workspaces) and asks for confirmation before deleting. Pass `--yes` to skip confirmation.

```bash
reviewphin tenant remove \
  --key https://gitlab.example.com::123 \
  --yes
```

| Flag                        | Required | Description                                                                  |
| --------------------------- | -------- | ---------------------------------------------------------------------------- |
| `--tenant-id`               | Yes*     | Internal tenant ID (ULID).                                                   |
| `--key`                     | Yes*     | Stable tenant key printed by `tenant list`.                                  |
| `--sqlite-database-path`    | No       | Override the SQLite path.                                                    |
| `--storage-provider-module` | No       | Override the storage module.                                                 |
| `--workspace-root`          | No       | Override the workspace scratch root (default: `WORKSPACE_ROOT` from `.env`). |
| `--run-log-dir`             | No       | Override the run-log root (default: `RUN_LOG_DIR` from `.env`).              |
| `--yes`                     | No       | Skip the interactive confirmation prompt.                                    |

\* Provide either `--tenant-id` or `--key`.

---

## Model profile commands

Model profiles store LLM provider configuration. When no profiles exist, ReviewPhin uses the Copilot CLI directly. When profiles exist, the effective profile is resolved in this order:

1. `/reviewphin-profile <name>` directive in the code review description (the merge request description in GitLab today)
2. the tenant's assigned profile
3. the database default profile
4. plain Copilot CLI fallback

See [Model providers](model-providers.md) for provider-specific examples.

### `model-profile add`

Create or update a named model profile.

```bash
# GitHub Copilot with an explicit model
reviewphin model-profile add \
  --name copilot-gpt4 \
  --review-model gpt-4.1 \
  --text-generation-model gpt-4.1-mini \
  --default

# BYOK: self-hosted vLLM
reviewphin model-profile add \
  --name byok-llama \
  --base-url http://vllm-host:8000/v1 \
  --provider-type openai \
  --review-model meta-llama/Llama-3.1-8B-Instruct

# BYOK: Azure OpenAI
reviewphin model-profile add \
  --name azure-gpt4 \
  --base-url https://my-resource.openai.azure.com \
  --provider-type azure \
  --auth-token your-azure-key \
  --review-model my-gpt4-deployment
```

| Flag                            | Required | Description                                                                                                 |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `--name`                        | Yes      | Stable profile name. Used in `--model-profile` flags and `/reviewphin-profile` MR directives.               |
| `--base-url`                    | No       | BYOK provider base URL. Leave unset for native Copilot CLI profiles.                                        |
| `--provider-type`               | No       | `openai`, `azure`, or `anthropic`. Required when `--base-url` is set.                                       |
| `--wire-api`                    | No       | `responses` or `completions`. Defaults to `responses` for BYOK profiles.                                    |
| `--auth-token`                  | No       | API key for the BYOK provider, or an override GitHub PAT for Copilot profiles. Always masked in CLI output. |
| `--review-model`                | No       | Model identifier for review runs. Required when `--base-url` is set.                                        |
| `--text-generation-model`       | No       | Model for memory coalescing and lightweight generation. Defaults to `--review-model` when omitted.          |
| `--default`                     | No       | Mark this profile as the database default.                                                                  |
| `--clear-base-url`              | No       | Clear the stored base URL (also clears provider type and wire API unless you set new values).               |
| `--clear-provider-type`         | No       | Clear the stored provider type.                                                                             |
| `--clear-wire-api`              | No       | Clear the stored wire API setting.                                                                          |
| `--clear-auth-token`            | No       | Clear the stored auth token.                                                                                |
| `--clear-review-model`          | No       | Clear the stored review model.                                                                              |
| `--clear-text-generation-model` | No       | Clear the stored text-generation model.                                                                     |
| `--sqlite-database-path`        | No       | Override the SQLite path.                                                                                   |
| `--storage-provider-module`     | No       | Override the storage module.                                                                                |

---

### `model-profile list`

Print all model profiles.

```bash
reviewphin model-profile list
```

| Flag                        | Required | Description                  |
| --------------------------- | -------- | ---------------------------- |
| `--sqlite-database-path`    | No       | Override the SQLite path.    |
| `--storage-provider-module` | No       | Override the storage module. |

---

### `model-profile set-default`

Mark an existing profile as the database default.

```bash
reviewphin model-profile set-default --name byok-llama
```

| Flag                        | Required | Description                  |
| --------------------------- | -------- | ---------------------------- |
| `--name`                    | Yes      | Profile name.                |
| `--sqlite-database-path`    | No       | Override the SQLite path.    |
| `--storage-provider-module` | No       | Override the storage module. |

---

### `model-profile clear-default`

Remove the default flag from all profiles (fallback to Copilot CLI).

```bash
reviewphin model-profile clear-default
```

| Flag                        | Required | Description                  |
| --------------------------- | -------- | ---------------------------- |
| `--sqlite-database-path`    | No       | Override the SQLite path.    |
| `--storage-provider-module` | No       | Override the storage module. |

---

### `model-profile remove`

Delete a named model profile. Fails if a tenant still references this profile.

```bash
reviewphin model-profile remove --name byok-llama
```

| Flag                        | Required | Description                  |
| --------------------------- | -------- | ---------------------------- |
| `--name`                    | Yes      | Profile name to remove.      |
| `--sqlite-database-path`    | No       | Override the SQLite path.    |
| `--storage-provider-module` | No       | Override the storage module. |

---

## Storage commands

### `storage migrate`

Copy all data from one storage adapter to another. Useful for migrating from SQLite to a custom adapter, or between SQLite databases.

```bash
reviewphin storage migrate \
  --from-storage-provider-module ./dist/storage/adapters/sqlite/entrypoint.js \
  --from-sqlite-database-path ./data/old.sqlite \
  --to-storage-provider-module @my-org/reviewphin-postgres \
  --to-sqlite-database-path ./data/new.sqlite
```

`source-*` and `destination-*` are accepted as aliases for `from-*` and `to-*`.

| Flag                             | Required | Description                                                          |
| -------------------------------- | -------- | -------------------------------------------------------------------- |
| `--from-storage-provider-module` | Yes      | Source adapter module path or package name.                          |
| `--from-sqlite-database-path`    | No       | Source SQLite path (when the source is the built-in SQLite adapter). |
| `--to-storage-provider-module`   | Yes      | Target adapter module path or package name.                          |
| `--to-sqlite-database-path`      | No       | Target SQLite path (when the target is the built-in SQLite adapter). |

---

## Diagnostic commands

### `mr describe`

Print the hydrated code review context for a given code review. Useful for debugging review inputs without triggering a full review. The data is still GitLab-shaped today because GitLab is the only supported platform.

```bash
reviewphin mr describe \
  --key https://gitlab.example.com::123 \
  --code-review-id 42 \
  --json
```

| Flag                           | Required | Description                                                                         |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------- |
| `--tenant-id`                  | Yes*     | Internal tenant ID (ULID).                                                          |
| `--key`                        | Yes*     | Stable tenant key printed by `tenant list`.                                         |
| `--code-review-id`             | Yes      | Code review ID. For GitLab this is the merge request IID (the `!N` number).         |
| `--merge-request-iid`          | No       | GitLab-compatible alias for `--code-review-id`.                                     |
| `--current-interaction-job-id` | No       | Attach a specific interaction job ID to the context.                                |
| `--trigger-note-id`            | No       | Simulate a specific trigger note.                                                   |
| `--trigger-note-action`        | No       | `create` or `update`.                                                               |
| `--trigger-note-updated-at`    | No       | ISO timestamp for the simulated trigger.                                            |
| `--trigger-note-body`          | No       | Body text for the simulated trigger note.                                           |
| `--json`                       | No       | Output raw JSON instead of formatted text.                                          |
| `--sqlite-database-path`       | No       | Override the SQLite path.                                                           |
| `--storage-provider-module`    | No       | Override the storage module.                                                        |

\* Provide either `--tenant-id` or `--key`.

---

### `metrics sessions`

Print aggregated metrics from run-log files: token counts, tool calls, premium request counts, and durations.

```bash
reviewphin metrics sessions
```

| Flag            | Required | Description                                                     |
| --------------- | -------- | --------------------------------------------------------------- |
| `--run-log-dir` | No       | Override the run-log root (default: `RUN_LOG_DIR` from `.env`). |
