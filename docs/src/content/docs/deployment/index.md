---
title: Deployment & instance management
description: Run, expose, configure, and persist a ReviewPhin instance.
---

ReviewPhin ships as a single container image that serves the worker, the platform setup flow, and these docs from one runtime. This area covers running that image, exposing it to the internet, configuring it, and keeping its data safe.

## Choose how to run it

| Environment | Use it when | Guide |
| --- | --- | --- |
| Local (from source) | Developing or evaluating on your machine | [Run locally](run-locally/) |
| Docker Compose | Single-host production or a quick trial | [Run with Docker](docker/) |
| Kubernetes (Helm) | Cluster deployments with ingress and persistence | [Run on Kubernetes](kubernetes/) |

Then make the instance reachable so platforms can deliver webhooks — see [exposing webhooks](exposing-webhooks/).

## Configuration and data

- [Environment variables](environment-variables/) — the full runtime reference.
- [Storage & migration](storage/) — SQLite, Flotiq, custom adapters, backups, and moving data.

## What one container serves

```text
one image
  ├── /docs/*               this documentation + local search
  ├── /healthz              liveness probe
  ├── /setup/<platform>/*   optional provider setup flow
  └── /webhooks/<platform>  platform webhook receiver
```

The Fastify app serves `public/` at `/`, then registers setup and webhook routes. Docs pages under `/docs/*` must not shadow `/healthz`, `/setup/*`, `/webhooks/*`, or `/github/setup/*`.

## Public URL

Set `PUBLIC_URL` to the external HTTPS URL that GitLab or GitHub can reach:

```ini
PUBLIC_URL=https://reviewphin.example.com
```

GitHub setup builds callback, webhook, and asset URLs from this value, and GitLab webhook instructions depend on it. See [exposing webhooks](exposing-webhooks/) for how to obtain a public URL for local, Docker, and Kubernetes instances.

## Persistent paths

Persist these paths in production:

| Path | Purpose |
| --- | --- |
| `/app/data` | SQLite database and run logs by default. |
| `/app/tmp` | Hydrated review workspaces. |

## Runtime routes

| Route | Purpose |
| --- | --- |
| `/docs/` | Documentation hub. |
| `/healthz` | Health check, returns `{"status":"ok"}`. |
| `/robots.txt` | Crawler policy endpoint (default deny; optional allow for `/docs/*` only). |
| `/webhooks/gitlab` | GitLab webhook receiver. |
| `/webhooks/github` | GitHub webhook receiver. |
| `/setup/github/*` | GitHub setup flow. |

## Bot indexing policy

By default, ReviewPhin sends `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate` and serves a restrictive `robots.txt`, so crawlers and common AI training bots should not index any route.

For official publication domains, enable docs indexing explicitly:

```ini
REVIEWPHIN_ALLOW_BOT_INDEXING=true
```

To limit docs indexing to specific hosts, keep the global flag off and set:

```ini
REVIEWPHIN_BOT_INDEXING_ALLOWED_HOSTS=reviewphin.example.com,docs.reviewphin.example.com
```
