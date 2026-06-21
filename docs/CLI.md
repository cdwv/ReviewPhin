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

## Help

Append `--help` to any command path to show only matching usage entries:

```bash
reviewphin --help
reviewphin tenant --help
reviewphin tenant add --help
```

Help requests exit successfully. Incomplete or unknown commands exit with an
error after displaying contextual help. When a recognized command fails,
its usage entry is displayed with the error.

---

## Tenant commands

Reusable credentials are registered as platform connections before tenants.

### `platform connection`

```bash
reviewphin platform connection add \
  --name main-gitlab \
  --platform gitlab \
  --base-url https://gitlab.example.com \
  --api-token glpat-xxxxxxxx
```

Bot identity is inferred from the token unless explicitly supplied. The
`update`, `remove`, and `describe` commands accept
`--connection <name-or-id>`. `list` and `describe` redact connection secrets.

| Flag             | Add required | Description                                                                                                    |
| ---------------- | ------------ | -------------------------------------------------------------------------------------------------------------- |
| `--name`         | Yes          | Globally unique connection name.                                                                               |
| `--platform`     | No           | Platform slug. Defaults to `gitlab`.                                                                           |
| `--base-url`     | Yes          | Base URL of the GitLab instance.                                                                               |
| `--api-token`    | Yes          | API token used for GitLab requests.                                                                            |
| `--bot-user-id`  | No           | Numeric GitLab user ID of the bot. If omitted, it is requested from the GitLab API using the connection token. |
| `--bot-username` | No           | GitLab username used to match direct mentions. If omitted, it is requested from the GitLab API.                |

Provider options, including bot identity, can also be changed with
`platform connection update --connection <name-or-id>`.

For GitHub, registration creates an expiring setup link for the GitHub App
manifest flow:

```bash
PUBLIC_URL=https://reviewphin.example.com reviewphin platform connection add \
  --platform github \
  --name main-github \
  --owner example-org
```

Open the printed setup URL, review the generated manifest, and complete the
registration and installation on GitHub. After registration, ReviewPhin
redirects to the app installation page. The connection changes from
`setup_required` to `ready` only after ReviewPhin validates the installation
account and successfully makes an installation-authenticated repository API
request.
The setup page builds callback, webhook, and asset URLs from `PUBLIC_URL`, so a
reverse-proxy path prefix such as `https://host/reviewphin` is preserved.

To preview the GitHub setup templates without a setup token during local
development, run `pnpm dev` and open the logged
`http://localhost:<PORT>/github/setup/samples` URL. The sample pages are
populated with example data and live outside `/setup/github`, so they do not
read or mutate storage, call GitHub, or advance a connection through the setup
flow. These sample routes are not mounted by the production server.

The Check Run **Run Review** action is the primary GitHub trigger. Pull request
comments also accept `/reviewphin review`, `@reviewphin review`, or a mention
of the generated App slug. GitHub does not autocomplete these compatibility
commands. Replies inside ReviewPhin-owned inline review threads automatically
continue that finding.

GitHub project memory uses the configured ReviewPhin storage provider. It does
not require repository wiki access or repository contents write access for
memory.

Use `--recreate` to issue a fresh setup link without deleting the connection
or its tenant assignments. Recreate prints cleanup instructions for the old
remote app and retains only non-secret app identity metadata for reference.
Ordinary GitHub connection updates are rejected because registration changes
require an explicit recreate.

GitHub does not support setting the app badge through an App Manifest or REST
API. After setup succeeds, follow the success-page instructions to download
`<PUBLIC_URL>/favicon.png`, edit the generated app under **Settings > Developer
settings > GitHub Apps**, and upload it as the app logo. GitHub accepts PNG,
JPG, or GIF files under 1 MB and recommends a square image around 200 by 200
pixels.

#### Removing a GitHub connection

`platform connection remove` prints provider-specific cleanup instructions and
then removes only ReviewPhin's local connection record. It does not uninstall
or delete the generated GitHub App.
Before removing the local connection:

1. Remove all ReviewPhin tenants attached to the connection.
2. In the target personal or organization account, open **Settings > GitHub
   Apps**, select the installed ReviewPhin app, and click **Uninstall**.
3. In the account that owns the generated app registration, open **Settings >
   Developer settings > GitHub Apps**, edit the app, open **Advanced**, and
   delete the GitHub App registration.
4. Run:

```bash
reviewphin platform connection remove --connection main-github
```

Deleting the registration also uninstalls that app from any remaining
accounts. The explicit uninstall step is recommended so you can confirm which
account and repositories lose access before deleting the registration.

GitLab connection recreate and removal similarly print reminders to remove
obsolete project webhooks and revoke dedicated access tokens manually.

### `tenant add`

Register a new GitLab or GitHub tenant. `--platform` defaults to `gitlab`.

```bash
reviewphin tenant add \
  --platform gitlab \
  --connection main-gitlab \
  --project-id 123 \
  --webhook-secret replace-me
```

For GitHub, the assigned connection must have completed App installation:

```bash
reviewphin tenant add \
  --platform github \
  --connection main-github \
  --repository example-org/example-repository
```

During GitHub tenant registration, ReviewPhin scans existing open pull
requests and idempotently provisions missing **Run Review** Check Runs. A
failed scan aborts registration; rerunning the command safely retries the
backfill.

| Flag                        | Required | Description                                                                                                           |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `--platform`                | No       | Code review platform slug. Defaults to `gitlab`; custom slugs require loading their provider with `PLATFORM_MODULES`. |
| `--connection`              | Yes      | Globally unique connection name or id. It must be ready and match the tenant platform.                                |
| `--project-id`              | GitLab   | Numeric GitLab project ID.                                                                                            |
| `--webhook-secret`          | GitLab   | Value expected in the `X-Gitlab-Token` header for this project's webhooks.                                            |
| `--repository`              | GitHub   | Repository in `owner/repo` form, resolved through the configured GitHub App installation.                             |
| `--model-profile`           | No       | Assign a named model profile to this tenant at registration time.                                                     |
| `--sqlite-database-path`    | No       | Override the SQLite file path instead of reading `SQLITE_DATABASE_PATH` from `.env`.                                  |
| `--storage-provider-module` | No       | Override the storage adapter module instead of reading `STORAGE_PROVIDER_MODULE` from `.env`.                         |

For non-built-in platforms, set `PLATFORM_MODULES` in the environment before running `tenant add`; CLI platform registration uses the same comma-separated module list as the server. See [Code review platform providers](code-review-platform-providers.md#loading-platform-modules).

GitLab project memory uses the project wiki when GitLab reports the wiki
feature enabled. If the wiki feature is disabled, memory uses the configured
storage provider. GitHub project memory always uses the configured storage
provider.

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

| Flag                        | Required | Description                                 |
| --------------------------- | -------- | ------------------------------------------- |
| `--tenant-id`               | Yes\*    | Internal tenant ID (ULID).                  |
| `--key`                     | Yes\*    | Stable tenant key printed by `tenant list`. |
| `--model-profile`           | Yes      | Name of the profile to assign.              |
| `--sqlite-database-path`    | No       | Override the SQLite path.                   |
| `--storage-provider-module` | No       | Override the storage module.                |

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
| `--tenant-id`               | Yes\*    | Internal tenant ID (ULID).                  |
| `--key`                     | Yes\*    | Stable tenant key printed by `tenant list`. |
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
| `--tenant-id`               | Yes\*    | Internal tenant ID (ULID).                                                   |
| `--key`                     | Yes\*    | Stable tenant key printed by `tenant list`.                                  |
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

Print the hydrated code review context for a given code review. Useful for debugging review inputs without triggering a full review. The command accepts the provider-neutral tenant key and code review identifier.

```bash
reviewphin mr describe \
  --key https://gitlab.example.com::123 \
  --code-review-id 42 \
  --json
```

| Flag                           | Required | Description                                                                 |
| ------------------------------ | -------- | --------------------------------------------------------------------------- |
| `--tenant-id`                  | Yes\*    | Internal tenant ID (ULID).                                                  |
| `--key`                        | Yes\*    | Stable tenant key printed by `tenant list`.                                 |
| `--code-review-id`             | Yes      | Code review ID. For GitLab this is the merge request IID (the `!N` number). |
| `--merge-request-iid`          | No       | GitLab-compatible alias for `--code-review-id`.                             |
| `--current-interaction-job-id` | No       | Attach a specific interaction job ID to the context.                        |
| `--trigger-comment-id`         | No       | Simulate a specific trigger comment.                                        |
| `--trigger-comment-action`     | No       | `create` or `update`.                                                       |
| `--trigger-comment-updated-at` | No       | ISO timestamp for the simulated trigger.                                    |
| `--trigger-comment-body`       | No       | Body text for the simulated trigger comment.                                |
| `--json`                       | No       | Output raw JSON instead of formatted text.                                  |
| `--sqlite-database-path`       | No       | Override the SQLite path.                                                   |
| `--storage-provider-module`    | No       | Override the storage module.                                                |

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
