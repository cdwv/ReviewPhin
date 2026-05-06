# Storage rework plan

## Problem

The current storage layer already exposes a useful `Storage` TypeScript contract, but `SqliteStorage.initialize()` still mixes together:

- database connection setup
- current SQLite schema creation
- legacy schema repair / ad hoc alignment logic
- application startup readiness

That makes schema evolution hard to reason about and makes future provider work harder because the app currently depends on one SQLite-specific implementation owning too much behavior.

## Agreed direction

- Treat the **current table shape as frozen v0**.
- Do **not** redesign existing tables as part of this refactor.
- Add **migration tracking** on top of the current schema.
- The first formal migration should represent the current schema as a baseline and mark it as applied after ensuring the current tables exist with the same shape.
- From that point forward, every schema change must be a proper migration tracked by the provider.
- Optimize the first milestone for **SQLite-first with clean provider and migration boundaries**.
- The core app should expose a **shared storage contract in TypeScript**, while each provider owns its own physical schema and migrations.
- Third-party providers should be loadable from a **user-specified JS module path or package name** at runtime.
- For now, require an **exact storage contract revision match** between the app and provider.

## Proposed architecture

### 1. Split storage into three layers

1. **Domain storage contract**
   - TypeScript record types, input types, repository interfaces, filter types, ordering types, and pagination types used by the app
   - no adapter-specific SQL or table knowledge leaked outside the provider package
2. **Provider runtime**
   - open connection / client
   - expose repositories implementing the shared contract
   - expose readiness / preparation behavior
3. **Provider-owned migration runtime**
   - read applied migration state from provider-owned metadata storage
   - run pending provider migrations in order
   - fail startup if provider preparation fails

### 2. Provider module contract

Dynamic providers should be loaded from a module that exports a single entrypoint function returning a provider object.

Conceptually:

```ts
interface StorageProvider {
  getProviderId(): string;
  getSupportedStorageContract(): string;
  open(): Promise<void>;
  prepare(): Promise<StoragePreparationResult>;
  createRepositories(): StorageRepositories;
  close(): Promise<void>;
}
```

`prepare()` is intentionally broad. A provider may internally run:

- schema migrations
- content type descriptor sync
- data backfills
- index creation
- cache rebuilds
- one-off provider-local repairs

`prepare()` should be treated as:

- startup-blocking
- safe to call repeatedly
- idempotent
- responsible for any provider-local readiness work needed before the server starts

If a provider call throws, surface that error in logs and propagate it. Do not add a special provider error taxonomy yet.

### 3. Storage contract and compatibility model

Do not force third-party providers into a central migration abstraction. Instead:

- the core app publishes the storage contract as TypeScript types and repository interfaces
- providers implement that contract
- providers own their internal schema/content model and all migrations or fixes needed to satisfy the contract
- the app checks compatibility at startup before serving traffic

There are two classes of change:

1. **Provider-internal change**
   - index changes
   - backend-specific normalization
   - physical layout optimizations
   - local data repair or backfill
   These remain invisible to the core app as long as the shared contract stays the same.

2. **Storage contract change**
   - new persisted concept the app depends on
   - new required field in a record
   - changed repository method semantics
   - removed or renamed app-visible storage concept
   These require a contract revision and corresponding provider updates.

### 4. Contract versioning and history

The shared contract should use a deliberately separate **storage contract revision id**, not app semver and not dates. Use a simple monotonic scheme such as:

- `storage-v000`
- `storage-v001`
- `storage-v002`

Recommended structure:

- `src\storage\contract\current.ts` for the canonical current contract
- `src\storage\contract\history\storage-v000.d.ts` for the baseline snapshot
- `src\storage\contract\history\storage-v001.d.ts` for later contract snapshots
- `src\storage\contract\history\index.ts` for revision metadata and change summaries

Each contract revision entry should document:

- revision id
- summary of changes
- whether the change is additive or breaking
- entity/repository surfaces affected
- implementation notes for providers, such as:
  - field should be unique
  - index strongly recommended
  - backfill expected during provider preparation if supported

The history snapshots are for provider authors, compatibility checks, and documentation. They should not replace the single canonical current contract as the main source of truth for runtime code.

## Query and repository model

### 1. No-join provider policy

The app should depend on repository-style interfaces and app-shaped query results, with a strong **no-join provider policy**. Provider-facing repositories should stay close to CRUD object contracts, for example:

- `tenantStore`
- `modelProfileStore`
- `interactionJobStore`
- `interactionRunStore`
- `reviewFindingStore`
- `discussionMappingStore`

Preferred provider-facing operations:

- `get(id)`
- `getMany(ids)`
- `find(filters)` for a single full object by indexed or unique fields
- `list(filters, order, page, pageSize)` for multiple full objects
- `upsert(...)`
- `replace(...)`
- `update(...)`
- `patch(...)`
- `delete(id)`
- `deleteMany(ids)`
- optionally `upsertMany(...)` if the app genuinely needs it

The provider contract should avoid arbitrary join-like query surfaces.

### 2. Filters, ordering, and pagination

Use classical pagination:

- `page`
- `pageSize`

Filters should be:

- typed per entity
- limited to documented indexed or otherwise approved fields
- limited to the operators currently needed:
  - equality
  - greater than / less than
  - greater than or equal / less than or equal
  - empty
  - not empty

Default ordering should be deterministic and based on the domain lifecycle timestamp first, such as:

- `created_at`
- `enqueued_at`
- `started_at`

with a stable secondary tie-breaker such as `id`.

### 3. Read-model ownership

Read models are built by the app, not by providers.

When cross-entity data is needed, the app should:

1. fetch records by ids or indexed fields
2. collect related ids
3. fetch related records in one or more additional steps
4. assemble the read model in app logic

The rule for consistency is: **the app must complete all dependent writes before it considers the operation successful**.

### 4. Query model potholes to cover

The no-join direction is sound, but the implementation should guard against:

1. **N+1 read storms**
   - Mitigation: support `getMany(ids)` and add explicit read models for recurring cross-entity views.
2. **Overpowered generic filters**
   - Mitigation: keep filters strongly typed per entity and limited to documented fields.
3. **Pagination drift**
   - Mitigation: always apply deterministic timestamp-based ordering plus a stable tie-breaker.
4. **Lost updates**
   - Mitigation: define `replace`, `update`, and `patch` semantics clearly, and decide later whether optimistic concurrency is needed.
5. **Cross-record consistency**
   - Mitigation: keep app write sequencing explicit rather than assuming hidden provider transactions.

## Value and serialization rules

- Use the basic app-level types already present in the system.
- `Date` objects are allowed at the contract boundary.
- Providers are responsible for mapping unsupported native backend types into their own storage representation.
- Provider guidance should recommend UTC-based serialization where backend-native date support is unavailable.

## SQLite baseline and startup flow

### 1. Freeze current SQLite schema as baseline migration

Introduce a provider-owned migration tracking table, for example:

- `storage_migrations`
  - `adapter_name`
  - `migration_id`
  - `applied_at`
  - optional checksum / metadata

Then define a baseline migration like `sqlite:0001_v0_baseline` that:

- creates `storage_migrations` if needed
- executes `CREATE TABLE IF NOT EXISTS ...` for the **current exact schema**
- creates the current indexes
- records itself as applied

This migration is not meant to reshape live data. It only formalizes the current state as the starting point for future tracked migrations.

### 2. Remove ad hoc schema repair from normal startup path

The current one-off helpers in `sqlite-storage.ts` such as:

- legacy table renames
- column existence patches
- review findings normalization / rebuild
- dedupe repair logic

should stop being implicit startup behavior. If any of that still needs to exist, it should move into explicit migrations or be dropped if it only served old drift that is no longer supported.

### 3. Gate app startup on provider preparation

Startup should become:

1. load config
2. resolve and load storage provider module
3. create provider from config
4. open provider
5. run provider preparation
6. construct repositories / registry / worker
7. start Fastify

If provider preparation fails, the process should exit before the webhook server starts listening.

## Library and implementation guidance

### Recommended boundary

Keep the **provider lifecycle and repository interfaces custom**, and use libraries only inside official providers.

### SQLite provider choice for v1

Use **`node:sqlite` + custom migration/runtime code** for v1.

Reasons:

- smallest change from the current code
- easiest way to freeze the current schema exactly
- lowest abstraction overhead while the storage contract and provider lifecycle are still settling

### Possible post-v1 evolution

If handwritten SQLite query code becomes too heavy later, the SQLite provider may migrate to **Kysely** outside v1:

- good typed query builder
- keeps SQL explicit
- stays provider-internal rather than becoming the app contract

### Recommendation for this repo

For this codebase, the v1 recommendation is **`node:sqlite` + custom migration/runtime code**.

Avoid making a SQL ORM the top-level abstraction for the whole system, because future non-SQL providers like Flotiq will not map cleanly to ORM expectations anyway.

## Official scope

- Start with SQLite only.
- Organize the directory structure so more first-class providers can be added cleanly later.
- The repository should eventually provide:
  - one or more first-class official providers
  - provider examples showing migration patterns
  - a compatibility test suite or contract tests that third-party providers can run

## Todos

1. Freeze current SQLite schema as formal v0 baseline and decide what legacy repair code is no longer supported.
2. Design the provider runtime, compatibility checks, and dynamic module loading interfaces.
3. Reorganize app-facing storage types into clearer domain contracts and repository boundaries.
4. Add SQLite migration state tracking and baseline migration execution inside the SQLite provider.
5. Refactor SQLite startup so schema setup happens through provider preparation instead of ad hoc initialization helpers.
6. Standardize read/write access behind repository methods or typed query objects so app code stops depending on custom joins.
7. Gate server startup on successful provider preparation completion.
8. Add or update tests around baseline migration, repeat startup, failed provider preparation behavior, and provider contract compatibility.
