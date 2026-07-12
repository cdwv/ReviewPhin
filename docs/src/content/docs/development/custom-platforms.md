---
title: Custom platform providers
description: Load a code review platform provider module at runtime.
---

Set `PLATFORM_MODULES` to load built-in and custom platform modules. This is the extension point for adding a code review platform that ReviewPhin does not ship.

```ini
PLATFORM_MODULES=gitlab,github,./providers/internal-platform.js
```

## Loading platform modules

Each entry can be a built-in shorthand, relative path, absolute path, package name, or bare module specifier.

Built-in shorthands are:

- `gitlab`
- `github`

Relative paths are resolved from the process working directory and loaded as file URLs. Package and bare specifiers are passed directly to dynamic `import()`. The CLI reads the same list, so set `PLATFORM_MODULES` before running `tenant add` for a custom platform.

## Factory

A platform module must export a factory as `createPlatform(context)` or a default function. The factory receives environment values and a logger and returns an `IPlatform` implementation.

Platform slugs must be unique across all loaded modules. Startup fails if two providers return the same slug. Providers expose separate tenant and connection registration schemas, and runtime methods receive resolved tenant and connection context.

## Local review submission

`mr review` is optional for custom providers. Implement `createLocalInteractionJob` to support it:

```ts
createLocalInteractionJob(input: {
  resolvedTenant: ResolvedTenant;
  storage: StorageHelpers;
  selector: LocalReviewSelector;
  forceNew: boolean;
  requestId: string;
  createdAt: string;
}): Promise<PlatformInteractionJobInput>;
```

The selector is one canonical comment URL, a comment ID plus code review ID, or local instruction text plus code review ID. The provider owns platform API access, tenant and URL verification, comment classification, head-SHA resolution, trigger construction, and canonical deduplication. For comment selectors, return the same trigger and dedupe identity as the equivalent webhook. For text selectors, include the request ID so each submission is fresh.

The CLI adds the resolved tenant ID, persists the job, and synchronizes its queued lifecycle. Return a no-op lifecycle for provider-neutral local text triggers; keep native lifecycle behavior for reconstructed comments.

Providers that omit this hook continue to load normally. `mr review` reports that local submission is unsupported for those providers.

## Setup routes

If a provider implements `getSetupHandler()`, ReviewPhin mounts it at:

- `/setup/<platform>`
- `/setup/<platform>/*`

The handler receives `pathSuffix`, raw request body bytes, and storage helpers when setup storage is available. Providers route their own pages and callbacks by inspecting the route suffix; ReviewPhin does not register provider-owned setup sub-routes individually.

## Publication adapter

The publication adapter implements the semantic `PlatformReviewPublicationAdapter` contract:

- `loadDiscussions`
- `mutateDiscussion`
- `publishFindings`
- `upsertSummary`

Draft notes, pending reviews, submission calls, marker recovery, and cleanup are provider implementation details. The central reconciler owns finding identity, reconciliation policy, persistence, and operation ordering.

## Future built-ins

Bitbucket is not currently built in. It can be added as a built-in adapter or supplied as an external platform module.
