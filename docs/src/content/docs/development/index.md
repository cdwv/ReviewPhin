---
title: Development
description: Architecture and provider extension points.
---

This area is for contributors and provider authors. It maps how ReviewPhin is built and shows where to extend it without touching review orchestration. If you only run or use ReviewPhin, [Deployment](../deployment/) and [Management](../management/) are the right places.

## The four parts

ReviewPhin has four main parts: the HTTP app, platform providers, the review worker, and storage.

```text
HTTP app (Fastify)
  ├── serves docs, health, setup routes
  └── receives /webhooks/<platform>
        │
platform providers ──► review worker ──► storage
  normalize GitLab/     classify, build     tenants, connections,
  GitHub/custom into    context, run model  jobs, runs, findings,
  shared operations     harness, reconcile  discussion maps,
                        output back          model profiles, memory
```

## HTTP app

The Fastify app serves static assets, health checks, setup routes, and platform webhooks.

| Route | Purpose |
| --- | --- |
| `/docs/*` | Static documentation. |
| `/healthz` | Liveness check. |
| `/setup/<platform>/*` | Optional provider setup flow. |
| `/webhooks/<platform>` | Platform webhook receiver. |
| `/github/setup/samples` | Dev-only GitHub setup template preview. |

## Providers

Platform providers normalize GitLab, GitHub, and future platforms into shared review operations. Storage providers normalize persistence behind the current storage contract. Both are extension points — see [providers](providers/).

## Review worker

The worker classifies triggers, builds prompt context, runs the model harness, and reconciles output back to the platform. The end-to-end path is described in [review flow](review-flow/).

## Storage

Storage keeps tenants, platform connections, jobs, runs, findings, discussion mappings, model profiles, and project memory behind the current storage contract.

## In this area

- [Review flow](review-flow/) — from webhook to published review.
- [Providers](providers/) — the platform and storage provider model.
- [Custom platform providers](custom-platforms/) — add a code review platform.
- [Custom storage adapters](custom-storage/) — add a persistence backend.
- [Contributing to docs](contributing-docs/) — build, preview, and style rules.
