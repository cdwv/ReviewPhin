---
title: Platform connections
description: Register reusable GitLab and GitHub credentials.
---

A platform connection stores reusable credentials and bot identity for one code review platform. You register a connection before attaching any [tenant](../tenants/). GitLab uses an access token; GitHub uses a generated GitHub App.

Examples use `reviewphin` for readability — see [running the CLI](../#running-the-cli) for the Docker Compose and local forms.

## GitLab

The GitLab provider reads merge request context, publishes discussions, and receives GitLab webhooks.

### Add the connection

```bash
reviewphin platform connection add \
  --name main-gitlab \
  --platform gitlab \
  --base-url https://gitlab.example.com \
  --api-token glpat-xxxxxxxx
```

The token can be personal, group, or project-scoped. It must have `api` scope and enough project access to read merge request data, create, update, and resolve bot-owned discussions, and clone over HTTPS. ReviewPhin discovers the bot user ID and username from the token unless you pass `--bot-user-id` and `--bot-username`.

### Cleanup

Recreating or removing a GitLab connection only changes ReviewPhin's local connection record. Remove obsolete project webhooks manually and revoke any dedicated access token that is no longer used.

## GitHub

GitHub support uses a generated GitHub App. The app owns check runs, receives webhooks, and publishes pull request review output.

### Prerequisites

GitHub builds the app manifest, callback, and webhook URLs from `PUBLIC_URL`, so the worker must already be reachable at that URL before you create the connection.

1. Choose the public URL the app will use.
2. Set `PUBLIC_URL` in the worker environment.
3. Start ReviewPhin.
4. Run `platform connection add`.

:::caution
`PUBLIC_URL` must be set and reachable *before* this step. For a local or Docker instance, expose it first with a tunnel or ingress — see [exposing webhooks](../../deployment/exposing-webhooks/). `PUBLIC_URL` is not editable on the setup page.
:::

### Create the connection

```bash
reviewphin platform connection add \
  --platform github \
  --name main-github \
  --owner example-org
```

The command stores a one-hour setup token and prints a URL under `/setup/github/<token>`. Open it, review the generated GitHub App manifest, create the app in GitHub, and install it on the target account. The setup page preserves reverse-proxy path prefixes such as `https://host/reviewphin`.

The connection changes to `ready` only after GitHub registration, installation, account validation, and an installation-token repository check all succeed. The setup token is invalidated after a successful installation.

### App badge

GitHub App manifests cannot set the app badge. After setup succeeds, use the success-page link to download `<PUBLIC_URL>/favicon.png`, then upload it manually under **Settings > Developer settings > GitHub Apps**. GitHub accepts PNG, JPG, or GIF under 1 MB, ideally square around 200×200.

### Recreate

Use `--recreate` to issue a fresh setup link without deleting the connection or its tenant assignments. Recreate prints cleanup instructions for the old remote app and keeps only non-secret identity metadata. Ordinary GitHub connection updates are rejected because registration changes require an explicit recreate.

### Cleanup

`platform connection remove` removes only ReviewPhin's local record. Before removing it:

1. Remove tenants that reference the connection.
2. Uninstall the generated GitHub App under **Settings > GitHub Apps**.
3. Delete the app registration under **Settings > Developer settings > GitHub Apps > Advanced**.
4. Run `reviewphin platform connection remove --connection main-github`.

Deleting a registration removes remaining installations. Uninstalling first is recommended because it makes the affected access explicit.

### Preview setup templates locally

During local development, `pnpm dev` logs a `/github/setup/samples` URL. That gallery renders example setup pages with sample data. It does not need a setup token, touch storage, call GitHub, or advance a connection. It is not mounted by the production server.

## Project memory

Project memory stores durable conventions per project. Where it lands depends on the platform:

- **GitLab** uses the project wiki when GitLab reports the wiki feature enabled. If the wiki is disabled, memory uses the configured [storage provider](../../deployment/storage/). If the wiki is later enabled while a store-backed row exists, the wiki wins and the store row is deleted without being copied.
- **GitHub** always uses the configured storage provider. It does not require wiki access or repository contents write access for memory.

Developers teach conventions from the review surface — see [comments and triggers](../../using-reviewphin/comments-and-triggers/).
