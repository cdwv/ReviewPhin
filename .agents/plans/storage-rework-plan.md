# Storage rework plan

## Problem

The current storage layer already exposes a useful `Storage` TypeScript contract, but `SqliteStorage.initialize()` still mixes together:

- database connection setup
- current SQLite schema creation
- legacy schema repair / ad hoc alignment logic
- application startup readiness

That makes schema evolution hard to reason about and makes future adapter work harder because the app currently depends on one SQLite-specific implementation owning too much behavior.

## Agreed direction

- Treat the **current table shape as frozen v0**.
- Do **not** redesign existing tables as part of this refactor.
- Add **migration tracking** on top of the current schema.
- The first formal migration should represent the current schema as a baseline and mark it as applied after ensuring the current tables exist with the same shape.
- From that point forward, every schema change must be a proper migration tracked by the storage adapter.
- Optimize the first milestone for **SQLite-first with clean adapter and migration boundaries**.
- The core app should expose a **shared storage contract in TypeScript**, while each provider owns its own physical schema and migrations.
- Third-party providers should be loadable from a **user-specified JS module path or package name** at runtime.

## Proposed approach

### 1. Split storage into three layers

1. **Domain storage contracts**
   - TypeScript record types, input types, and repository/query result types used by the app
   - No adapter-specific SQL or table knowledge leaked outside the adapter package
2. **Adapter runtime**
   - Open connection / client
   - Expose repositories implementing the domain contracts
   - Expose readiness / preparation capabilities
3. **Provider-owned migration runtime**
   - Read applied migration state from provider-owned metadata storage
   - Run pending provider migrations in order
   - Fail startup if any provider migration fails

### 2. Keep a canonical app-facing contract, not a universal ORM abstraction

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
- `find(filters)` for a single full object by indexed/unique fields
- `list(filters, order, pagination)` for multiple full objects
- `upsert(...)` or `replace(...)`
- `update(id, patch)` where supported by the contract
- `delete(id)` / `deleteMany(ids)`

The provider contract should avoid arbitrary join-like query surfaces. When the app needs cross-entity or pre-joined views, it should model them explicitly as stored **read models / projections / denormalized records** instead of leaking custom joins into provider APIs.

### Query model potholes to cover

The no-join direction is sound, but the plan should explicitly account for these risks:

1. **N+1 read storms**
   - If a workflow repeatedly fetches related objects one by one, provider portability improves but runtime efficiency can collapse.
   - Mitigation: add `getMany(ids)` and use explicit projections for recurring cross-entity views.

2. **Overpowered generic filters**
   - A generic `find(filters)` can quietly become a custom query language.
   - Mitigation: keep filters strongly typed per entity and limited to indexed or documented fields.

3. **Pagination drift**
   - `list(filters, order, pagination)` needs stable ordering rules or providers will return inconsistent pages.
   - Mitigation: define deterministic sort semantics using the domain-appropriate lifecycle timestamp first, such as `created_at`, `enqueued_at`, or `started_at`, with a stable secondary tie-breaker such as `id`.

4. **Lost updates**
   - "Always full objects" can cause write races if two writers replace the same record.
   - Mitigation: decide whether updates are replace-style, patch-style, or guarded by version/updatedAt checks.

5. **Bulk workflows**
   - CRUD-only contracts are painful without batch operations.
   - Mitigation: include `getMany`, `deleteMany`, and possibly `upsertMany` where the app genuinely needs them.

6. **Uniqueness and index expectations**
   - Providers need to know which fields are expected to be unique or efficiently queryable.
   - Mitigation: document those expectations in contract revision metadata.

7. **Cross-entity consistency**
   - Some operations touch multiple records that should move together.
   - Mitigation: define provider capabilities for transactions or document acceptable eventual-consistency behavior for projections.

### 3. Freeze current SQLite schema as baseline migration

Introduce an adapter-owned migration tracking table, for example:

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

### 4. Remove ad hoc schema repair from normal startup path

The current one-off helpers in `sqlite-storage.ts` such as:

- legacy table renames
- column existence patches
- review findings normalization / rebuild
- dedupe repair logic

should stop being implicit startup behavior. If any of that still needs to exist, it should move into explicit migrations or be dropped if it only served old drift that is no longer supported.

### 5. Gate app startup on provider preparation

Startup should become:

1. load config
2. resolve and load storage provider module
3. create provider from config
4. open provider
5. run provider preparation (including migrations if needed)
6. construct repositories / registry / worker
7. start Fastify

If provider preparation fails, the process should exit before the webhook server starts listening.

## Library / implementation options

### Recommended boundary

Keep the **migration orchestration and repository interfaces custom**, and use a library only inside SQL adapters.

### SQLite adapter options

1. **Stay on `node:sqlite` + custom migration runner**
   - smallest change from current code
   - easiest way to freeze current schema exactly
   - requires more handwritten repository/query code
2. **Kysely inside the SQLite adapter**
   - good typed query builder
   - keeps SQL explicit
   - less ORM-like than Drizzle, but flexible
3. **Drizzle inside the SQLite adapter**
   - strong TS schema definitions
   - nice if you want SQL schema represented directly in TS
   - still should stay adapter-internal, not become the app contract

### Recommendation for this repo

For this codebase, the safest first step is either:

- **`node:sqlite` + custom migration runtime**, if minimizing moving parts matters most, or
- **Kysely inside the SQLite adapter**, if you want typed SQL helpers without overcommitting to ORM patterns

I would avoid making a SQL ORM the top-level abstraction for the whole system, because future non-SQL adapters like Flotiq will not map cleanly to ORM expectations anyway.

## Provider extensibility notes

- Future providers will likely need **provider-specific migrations and fixes**. That is normal and acceptable.
- What should be shared is the **storage contract**, readiness lifecycle, and compatibility expectations.
- A good common contract is:
  - `getProviderId()`
  - `getSupportedStorageContract()`
  - `open()`
  - `prepare()`
  - `createRepositories()`
  - `close()`
- Each provider can decide whether preparation means SQL migrations, API calls, content model provisioning, index repair, cached view rebuilds, or some other backend-native work.

For non-SQL backends, not every repository capability may be equally efficient. If needed later, define adapter capability flags explicitly rather than hiding major behavioral differences.

## Storage contract and compatibility model

### Recommendation: central contract, provider-owned evolution

Do not force third-party providers into a central migration abstraction. Instead:

- the core app publishes the storage contract as TypeScript types and repository interfaces
- providers implement that contract
- providers own their internal schema/content model and all migrations or fixes needed to satisfy the contract
- the app checks compatibility at startup before serving traffic

This keeps custom provider authoring realistic and preserves the ability for users to drop in their own JS module without participating in core-managed migration authoring.

### Two classes of change

1. **Provider-internal change**
   - index changes
   - backend-specific normalization
   - physical layout optimizations
   - local data repair or backfill
   These should remain invisible to the core app as long as the shared contract stays the same.

2. **Storage contract change**
   - new persisted concept the app depends on
   - new required field in a record
   - changed repository method semantics
   - removed or renamed app-visible storage concept
   These require a contract update and corresponding provider updates.

### Suggested provider shape

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

The core does not need to understand those details.

### Contract versioning

The shared contract should use a deliberately separate **storage contract revision id**, not app semver and ideally not dates. A simple monotonic scheme is clearer, for example:

- `storage-v000`
- `storage-v001`
- `storage-v002`

This avoids confusion with application release versions while still making ordering and compatibility checks obvious.

Recommended structure:

- `src\storage\contract\current.ts` for the canonical current contract
- `src\storage\contract\history\storage-v000.d.ts` for the baseline snapshot
- `src\storage\contract\history\storage-v001.d.ts` for the next contract revision snapshot
- `src\storage\contract\history\index.ts` for machine-readable revision metadata and human-readable change summaries

Each contract revision entry should document:

- revision id
- summary of changes
- whether the change is additive or breaking
- entity/repository surfaces affected
- implementation notes for providers, such as:
  - field should be unique
  - index strongly recommended
  - backfill expected during provider preparation if supported

Providers declare the storage contract revision they support. Startup should fail clearly if the loaded provider does not satisfy the required revision.

The history snapshots are primarily for provider authors, compatibility checks, and documentation. They should not replace the single canonical current contract as the main source of truth for runtime code.

### Dynamic provider loading

The app should support loading official or third-party providers by:

- package name
- absolute module path
- possibly relative module path resolved from the working directory

That allows OSS users to ship custom storage implementations without waiting for changes in the core repository.

### Official provider guidance

The repository should provide:

- one or more first-class official providers
- provider examples showing migration patterns
- a compatibility test suite or contract tests that third-party providers can run

For example, a Flotiq provider may update content type descriptors and backfill objects during `prepare()`, while a SQLite provider may run SQL migrations and data rewrites. Both are valid as long as they satisfy the same app-facing contract.

## Todos

1. Freeze current SQLite schema as formal v0 baseline and decide what legacy repair code is no longer supported.
2. Design the provider runtime, compatibility checks, and dynamic module loading interfaces.
3. Reorganize app-facing storage types into clearer domain contracts and repository boundaries.
4. Add SQLite migration state tracking and baseline migration execution inside the SQLite provider.
5. Refactor SQLite startup so schema setup happens through provider preparation instead of ad hoc initialization helpers.
6. Standardize read/write access behind repository methods or typed query objects so app code stops depending on custom joins.
7. Gate server startup on successful provider preparation completion.
8. Add/update tests around baseline migration, repeat startup, failed provider preparation behavior, and provider contract compatibility.

## Notes

- Because the current schema is being frozen, the initial migration should preserve current table names, columns, and indexes exactly.
- This refactor can be delivered incrementally: first formalize migration tracking and startup gating, then improve repository boundaries and query standardization.
- The existing `Storage` interface is a strong starting point, but it will likely need to be split into smaller repositories to keep providers manageable.
- Core-managed migration abstractions should stay minimal; provider-local fixes and optimizations should remain provider-internal unless they change the shared contract.
