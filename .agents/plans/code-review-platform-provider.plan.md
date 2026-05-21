# Plan: Code Review Platform Provider

## Problem

All code-review-platform logic (webhook parsing, API client, tenant data shape) is hard-wired to
GitLab. Adding a second provider (GitHub, Bitbucket, custom) requires forking significant parts of
the app. Goal: make the CR platform a pluggable provider, following the same module-loading pattern
already used by storage providers.

## Confirmed design decisions

| # | Decision |
|---|----------|
| 1 | **TenantRecord schema** — add `platformType: string` + `platformConfig: string` (JSON blob). GitLab-specific fields (`baseUrl`, `projectId`, `apiToken`, `botUserId`, `botUsername`) move into `platformConfig`. `webhookSecret` stays on the root record (needed for pre-DB-query secret validation). |
| 2 | **Webhook tenant resolution** — provider extracts identity hints from the raw request; app queries DB by `platformType`; provider narrows candidates; provider validates the secret (supports HMAC for GitHub etc.). |
| 3 | **Setup pages** — providers may optionally declare setup routes under `/setup/<providertype>/<tenantid>[/*]`. GitLab adapter declares none. App registers the routes only when the loaded provider declares them. |
| 4 | **Module loading** — same ESM dynamic-import pattern as storage: built-in shorthand (`"gitlab"`, future `"github"`) or a file path / npm package specifier. |
| 5 | **Secret validation** — delegated entirely to the provider (constant-time compare for GitLab, HMAC-SHA256 for GitHub etc.). |

---

## Steps

### Step 1 — Define the `CRPlatformProvider` contract (`src/cr-platform/`)

Create a new top-level module with the following files:

**`src/cr-platform/provider.ts`** — core interfaces:

```ts
// Opaque bag of hints the provider extracts from the raw request.
// Can be as simple as { projectId, baseUrl } for GitLab.
export interface WebhookTenantHints { [key: string]: unknown }

export interface IncomingWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;          // already parsed JSON (or raw Buffer if provider needs it)
  rawBody?: Buffer;       // optional raw bytes for HMAC
}

export interface CRPlatformProvider {
  // Identity
  getProviderId(): string;

  // Tenant key — called at registration and lookup; must be stable
  computeTenantKey(platformConfig: unknown): string;

  // Inbound — webhook tenant resolution (three-phase)
  extractWebhookTenantHints(req: IncomingWebhookRequest): WebhookTenantHints | null;
  filterTenantCandidates(hints: WebhookTenantHints, tenants: TenantRecord[]): TenantRecord[];
  validateWebhookSecret(req: IncomingWebhookRequest, tenant: TenantRecord): boolean;

  // Inbound — trigger classification
  classifyWebhookTrigger(req: IncomingWebhookRequest, tenant: TenantRecord): WebhookTrigger | null;

  // Inbound — create job input from a validated, classified webhook
  createInteractionJobInput(
    req: IncomingWebhookRequest,
    tenant: TenantRecord,
    trigger: WebhookTrigger,
  ): CreateInteractionJobInput;

  // Outbound — review operations
  createReviewAdapter(tenant: TenantRecord): CRReviewAdapter;

  // Optional — setup pages (e.g. OAuth redirect flow)
  getSetupRoutes?(): CRSetupRouteDefinition[];
}
```

**`src/cr-platform/review-adapter.ts`** — outbound review operations (extracted from the current
implicit GitLab contract):

```ts
export interface CRReviewAdapter {
  hydrateMergeRequest(jobRecord: InteractionJobRecord): Promise<ReviewContext>;
  prepareWorkspace(context: ReviewContext): Promise<string>;  // returns workspacePath
  postDiscussions(context: ReviewContext, result: ReviewResult): Promise<void>;
  resolveDiscussions(tenantId: string, discussionIds: string[]): Promise<void>;
  // ... other outbound operations currently in src/gitlab/
}
```

**`src/cr-platform/module.ts`** — dynamic loading contract (mirrors `StorageProviderModule`):

```ts
export interface CRPlatformProviderModule {
  createCRPlatformProvider(
    context: CRPlatformProviderFactoryContext,
  ): Promise<CRPlatformProvider> | CRPlatformProvider;
}
```

**`src/cr-platform/runtime.ts`** — resolves built-in names or ESM paths, exactly like
`src/storage/runtime.ts`. Built-in shorthand `"gitlab"` maps to
`./adapters/gitlab/entrypoint.js`.

**`src/cr-platform/setup-route.ts`** — type for setup route declarations:

```ts
export interface CRSetupRouteDefinition {
  method: "GET" | "POST" | "GET|POST";
  path: string;          // relative to /setup/<providertype>/<tenantid>/
  handler: FastifyRouteHandler;
}
```

---

### Step 2 — Wrap GitLab into a `CRPlatformProvider` adapter

Create `src/cr-platform/adapters/gitlab/` with an entrypoint that wires up existing
`src/gitlab/` code into the provider interface — existing files are not moved.

The GitLab adapter implements `CRPlatformProvider`:

- `getProviderId()` → `"gitlab"`
- `computeTenantKey(config)` → `createTenantKey(config.baseUrl, config.projectId)`
  (reuses existing `src/utils/ids.ts`)
- `extractWebhookTenantHints(req)` → parses the body with the existing `noteHookSchema` and
  returns `{ projectId, webUrl, repositoryHomepage }` (or `null` on parse failure)
- `filterTenantCandidates(hints, tenants)` → filters by `config.projectId === hints.projectId`,
  then by `webhookMatchesGitLabBase` — logic currently in `TenantRegistry.resolveWebhookTenant`
- `validateWebhookSecret(req, tenant)` → constant-time compare of
  `req.headers["x-gitlab-token"]` against `tenant.webhookSecret` — logic currently inline in
  `resolveWebhookTenant` / `constantTimeEqual`
- `classifyWebhookTrigger(req, tenant)` → wraps current `ReviewWorker.classifyWebhookTrigger`
  (removes the GitLab type coupling from the worker)
- `createInteractionJobInput(req, tenant, trigger)` → wraps
  `ReviewWorker.createInteractionJobFromWebhook`
- `createReviewAdapter(tenant)` → returns a `GitLabReviewAdapter` that wraps the existing client,
  hydrator, workspace, image-attachments etc.
- `getSetupRoutes()` → not implemented / returns `undefined` (GitLab uses a push-webhook model,
  no OAuth flow needed)

---

### Step 3 — Bump storage contract to `storage-v001` + tenant schema changes

**`src/storage/contract/history/storage-v001.d.ts`** — new `TenantRecord`:

```ts
export interface TenantRecord {
  id: string;
  key: string;
  platformType: string;      // NEW — e.g. "gitlab"
  platformConfig: string;    // NEW — JSON blob (provider-specific fields)
  webhookSecret: string;     // stays at root (used by app before calling provider)
  modelProfileName: string | null;
  createdAt: string;
  updatedAt: string;
  // REMOVED: baseUrl, projectId, apiToken, botUserId, botUsername
}
```

`StorageTenantInput` is adjusted accordingly: `platformType`, `platformConfig`, `webhookSecret`.

**`InteractionJobRecord`** — currently has `projectId`, `mergeRequestIid`, `noteId` which are
GitLab-specific. These are used for deduplication and display; a full migration is deferred.
For now, keep them and add a `platformPayload: string` (JSON blob) field alongside them to carry
provider-native job data. Mark the existing typed fields as deprecated in the contract.
> ⚠️ This is a forward-compatibility compromise. Full removal of typed fields belongs in a later
> schema revision once the deduplication logic is also provider-delegated.

**Update** `CURRENT_STORAGE_CONTRACT_REVISION` → `"storage-v001"` in `src/storage/contract/index.ts`.

---

### Step 4 — Write migrations for both storage adapters

**SQLite adapter** (`src/storage/adapters/sqlite/`):
- Add migration `storage-v000-to-v001`:
  - `ALTER TABLE tenants ADD COLUMN platformType TEXT NOT NULL DEFAULT 'gitlab'`
  - `ALTER TABLE tenants ADD COLUMN platformConfig TEXT NOT NULL DEFAULT '{}'`
  - UPDATE: pack `baseUrl`, `projectId`, `apiToken`, `botUserId`, `botUsername` into
    `platformConfig` JSON for all existing rows
  - DROP COLUMNS (SQLite 3.35+): `baseUrl`, `projectId`, `apiToken`, `botUserId`, `botUsername`
    (or mark as tombstone columns if the SQLite version in use is older — check at runtime)
  - `ALTER TABLE interaction_jobs ADD COLUMN platformPayload TEXT`

**Flotiq adapter** (`src/storage/adapters/flotiq/`):
- Mirror the same tenant schema changes via Flotiq's content type update API
- Provide the same data migration as a prepared script / automated migration step

---

### Step 5 — Update `TenantRegistry`

Remove all GitLab-specific imports from `tenant-registry.ts`.

New `resolveWebhookTenant`:

```ts
public async resolveWebhookTenant(
  req: IncomingWebhookRequest,
  provider: CRPlatformProvider,
): Promise<TenantRecord | null> {
  const hints = provider.extractWebhookTenantHints(req);
  if (!hints) return null;

  const candidates = await listAll(this.storage.stores.tenants, {
    filters: { platformType: { eq: provider.getProviderId() } },
  });

  const narrowed = provider.filterTenantCandidates(hints, candidates);

  for (const tenant of narrowed) {
    if (provider.validateWebhookSecret(req, tenant)) {
      return tenant;
    }
  }
  return null;
}
```

`getTenantKey` delegates to the provider: `provider.computeTenantKey(parsedPlatformConfig)`.

---

### Step 6 — Update CLI tenant commands

- Add `--platform-type <type>` flag to `tenant add` (default `"gitlab"` to keep backward compat
  for existing scripts). For `gitlab`, the remaining existing flags (`--base-url`, `--project-id`,
  `--api-token`, `--bot-user-id`, `--bot-username`) are validated and packed into `platformConfig`
  by the adapter's `buildTenantConfig(flags)` helper.
- `tenant list` — display `platformType` alongside existing fields; show `platformConfig` in a
  provider-friendly summary format via `provider.summarizeTenantConfig(config)`.
- `tenant remove` / `set-profile` / `clear-profile` — can still look up by `--base-url` +
  `--project-id` for GitLab compat (resolved by parsing `platformConfig` within the registry helper).

---

### Step 7 — Update `app.ts` webhook routing

Replace the hardcoded route with a provider-driven registration:

```ts
// Webhook route — one per built-in or loaded provider
app.post(`/webhook/${provider.getProviderId()}/*`, async (request, reply) => {
  const req: IncomingWebhookRequest = { headers: request.headers, body: request.body, rawBody: request.rawBody };

  const tenant = await tenantRegistry.resolveWebhookTenant(req, provider);
  if (!tenant) return reply.code(401).send({ error: "unauthorized" });

  const trigger = provider.classifyWebhookTrigger(req, tenant);
  if (!trigger) return reply.code(202).send({ accepted: false, reason: "no-trigger" });

  const jobInput = provider.createInteractionJobInput(req, tenant, trigger);
  const { job, created } = await jobQueue.upsertJob(jobInput);
  if (created) queue.enqueue(job.id);

  return reply.code(202).send({ accepted: true, jobId: job.id, deduplicated: !created });
});

// Setup routes (optional, provider-declared)
for (const route of provider.getSetupRoutes?.() ?? []) {
  app.route({
    method: route.method,
    url: `/setup/${provider.getProviderId()}/:tenantId/${route.path}`,
    handler: route.handler,
  });
}
```

Keep `/webhooks/gitlab/note` as a **deprecated alias** (proxies to the new route) for one release
to avoid breaking existing webhook configurations. Remove in the next minor version.

---

### Step 8 — Decouple `review-worker.ts` from GitLab types

`ReviewWorker.classifyWebhookTrigger` and `createInteractionJobFromWebhook` currently accept
`GitLabNoteHookPayload`. These are now replaced by delegation to the provider (Step 7 handles
this at the routing layer). The worker's public API becomes platform-agnostic: it receives
a `InteractionJobRecord` (already persisted) and a `CRReviewAdapter` to run the review.

---

## Files affected (summary)

| Area | Change |
|------|--------|
| `src/cr-platform/` | **New** — provider interface, review adapter interface, module loader, runtime, setup-route type |
| `src/cr-platform/adapters/gitlab/` | **New** — GitLab implementation wrapping existing `src/gitlab/` code |
| `src/gitlab/` | Mostly **unchanged** — wrapped by the adapter, not moved |
| `src/storage/contract/history/storage-v001.d.ts` | **New** — updated `TenantRecord`, deprecated job fields |
| `src/storage/contract/index.ts` | Bump `CURRENT_STORAGE_CONTRACT_REVISION` |
| `src/storage/adapters/sqlite/` | **New migration** `v000→v001` |
| `src/storage/adapters/flotiq/` | **New migration** `v000→v001` |
| `src/tenants/tenant-registry.ts` | Remove GitLab imports; new `resolveWebhookTenant` signature |
| `src/app.ts` | Replace hardcoded route; add setup-route registration; add deprecated alias |
| `src/cli.ts` | Add `--platform-type`; pack GitLab config into `platformConfig` |
| `src/jobs/review-worker.ts` | Remove GitLab type coupling from public API |
| `docs/code-review-platform-providers.md` | Update to reflect new provider model |

---

## Open questions / considerations

- **`InteractionJobRecord` platform fields** (`projectId`, `mergeRequestIid`, `noteId`): a full
  move to a generic `platformPayload` blob is deferred. The new `platformPayload` column is added
  in v001 alongside the existing typed columns (populated by the GitLab adapter). Removal of the
  typed columns is a future `storage-v002`.
- **Multi-provider runtime**: v1 of this feature loads a single CR platform provider (configured
  via env var, like storage). Supporting tenants on different providers simultaneously is a later
  extension (requires routing by `platformType` at the DB query level, which is already set up by
  the `platformType` column).
- **`webhookSecret` in `platformConfig`**: For HMAC providers (GitHub), the shared secret doubles
  as the HMAC key. It is stored on the root record for uniform access; the provider's
  `validateWebhookSecret` uses it as it sees fit.
