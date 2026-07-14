---
title: Tenants
description: Attach a project or repository to a connection.
---

A tenant attaches one project (GitLab) or repository (GitHub) to a [platform connection](../platform-connections/). One ReviewPhin instance can serve many tenants, but each tenant maps to exactly one project or repository.

Examples use `reviewphin` for readability — see [running the CLI](../#running-the-cli) for the Docker Compose and local forms.

## GitLab

```bash
reviewphin tenant add \
  --platform gitlab \
  --connection main-gitlab \
  --project-id 123 \
  --webhook-secret replace-me
```

The `--webhook-secret` is the value ReviewPhin expects in the `X-Gitlab-Token` header for this project's webhooks. It protects the worker from untrusted traffic that could otherwise spend platform and model tokens.

After adding the tenant, configure the project webhook and make the endpoint reachable — that is a deployment concern, covered in [exposing webhooks](../../deployment/exposing-webhooks/#gitlab-webhook).

## GitHub

The assigned connection must have completed GitHub App installation first.

```bash
reviewphin tenant add \
  --platform github \
  --connection main-github \
  --repository example-org/example-repository
```

Registration scans existing open pull requests and idempotently provisions missing **Run Review** check runs. A failed scan aborts registration; rerunning the command safely retries the backfill. The GitHub App configures its own webhook, so there is no separate webhook secret to set here.

## Assign a model profile

Pin a [model profile](../model-profiles/) to a tenant at registration with `--model-profile <name>`, or later:

```bash
reviewphin tenant set-profile \
  --key https://gitlab.example.com::123 \
  --model-profile byok-gpt5.4
```

Clear it to fall back to the database default:

```bash
reviewphin tenant clear-profile --key https://gitlab.example.com::123
```

## List and remove

```bash
reviewphin tenant list
```

The default table includes each tenant's connection name. Use `--output json` for records containing `id`, `key`, `platform`, `platformConnectionId`, `platformConnectionName`, and `modelProfileName`.

```bash
reviewphin tenant remove --key https://gitlab.example.com::123 --yes
```

Removal prints a deletion summary (database rows, run-log directories, hydrated workspaces) and asks for confirmation unless you pass `--yes`.

## Custom platforms

For non-built-in platforms, set `PLATFORM_MODULES` in the environment before running `tenant add`; CLI platform registration uses the same comma-separated module list as the server. See [custom platform providers](../../development/custom-platforms/).

All tenant flags are listed in the [CLI reference](../cli-reference/#tenant-add).
