---
title: Management
description: Concepts and CLI for connections, tenants, model profiles, and memory.
---

Management is the operator's view: the objects you create so ReviewPhin can review a project, and the CLI that creates them. If you want to *use* reviews, see [Using ReviewPhin](../using-reviewphin/). If you want to *run* the worker, see [Deployment](../deployment/).

## How the pieces fit

```text
platform connection   (reusable credentials for one platform)
        |
        +-- tenant     (one project or repository attached to a connection)
                |
                +-- model profile   (optional; which model reviews this tenant)
                +-- project memory  (durable conventions for this project)
```

You register a connection once, then attach one or more tenants to it. Each tenant can pin a model profile; otherwise it falls back to the default.

## Concept glossary

| Term | What it is |
| --- | --- |
| **Platform connection** | Reusable credentials and identity for one code review platform (a GitLab token, or a generated GitHub App). Created before any tenant. |
| **Tenant** | One project (GitLab) or repository (GitHub) attached to a connection. The unit ReviewPhin reviews. |
| **Model profile** | Named model configuration (provider, base URL, review and text models). Resolved per review. |
| **Project memory** | Durable conventions learned from review conversations, stored per project. |
| **Webhook secret** | Per-tenant shared secret that authenticates incoming platform webhooks. |
| **Public URL** | The external HTTPS address platforms use to reach the worker. Set with `PUBLIC_URL`. See [exposing webhooks](../deployment/exposing-webhooks/). |

## Management pages

- [Platform connections](platform-connections/) — register GitLab and GitHub credentials.
- [Tenants](tenants/) — attach projects and repositories.
- [Model profiles](model-profiles/) — Copilot CLI, OpenAI-compatible, Azure, and Anthropic.
- [CLI reference](cli-reference/) — every command and flag.

## Running the CLI

The CLI manages platform connections, tenants, model profiles, storage migrations, and diagnostics.

Inside Docker, the image registers `reviewphin`:

```bash
docker compose run --rm worker reviewphin <resource> <action> [options]
```

From a local checkout, use `pnpm cli`:

```bash
pnpm cli <resource> <action> [options]
```

Both accept the same flags. Examples in these docs write `reviewphin` for readability. From a host shell with Docker Compose, prefix with `docker compose run --rm worker`; from a local checkout, replace `reviewphin` with `pnpm cli`. Full details are in the [CLI reference](cli-reference/).

## Common tasks

| Task | Command |
| --- | --- |
| Add a GitLab connection | `reviewphin platform connection add --platform gitlab ...` |
| Add a tenant | `reviewphin tenant add ...` |
| List tenants | `reviewphin tenant list` |
| Create a model profile | `reviewphin model-profile add ...` |
| Set a default model profile | `reviewphin model-profile set-default --name <name>` |
| Migrate storage | `reviewphin storage migrate ...` |
| Inspect a review context | `reviewphin mr describe ...` |
