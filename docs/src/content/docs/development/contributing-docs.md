---
title: Contributing to docs
description: Build, preview, and style rules for the documentation site.
---

Documentation source lives in `docs/`. Generated container output lives in `public/` and should not be edited by hand.

## Preview locally

```bash
pnpm docs:dev
```

## Build for the container image

```bash
pnpm docs:build:container
```

The container build does not include the homepage by default. Build the homepage only for a static site host, such as future GitHub Pages, by setting:

```bash
REVIEWPHIN_BUILD_HOMEPAGE=true pnpm docs:build
```

PostHog analytics are also disabled by default. To build a tracked static site, set `REVIEWPHIN_POSTHOG_KEY` at build time. `REVIEWPHIN_POSTHOG_HOST` is optional and defaults to `https://us.i.posthog.com`.

## How the container serves docs

The docs site is authored in `docs/` and built into the runtime static directory. The container docs build writes:

- `public/docs/` for Starlight documentation pages and assets,
- `public/pagefind/` for the Starlight local search bundle.

Existing runtime assets under `public/github/setup/` and `public/favicon.png` are preserved. The Fastify app serves `public/` at `/`, then registers setup and webhook routes.

Because docs pages live under `/docs/*`, they must not shadow `/healthz`, `/setup/*`, `/webhooks/*`, or `/github/setup/*`. The container docs build also removes `public/index.html` so the runtime root can be owned by the application, not the static docs site. Route smoke checks should verify those paths after each docs integration change.

## Writing rules

Use the `reviewphin-docs` skill before changing docs or official-site copy.

- Keep GitLab first in navigation and examples, while giving GitHub and custom providers equal structure where supported.
- Keep SQLite first in storage docs, then Flotiq, then custom adapters.
- Write for operators and maintainers in plain, task-oriented language.
- Do not duplicate guidance across pages; link to the canonical page instead.

## Fact checks

Verify commands, routes, environment variables, and provider behavior against source before publishing. Use `schema-verification-skill` for storage contract, schema, migration, or adapter documentation.
