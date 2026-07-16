# Storage adapter author guide

Adapters are runtime plug-ins. The app only relies on the shared storage contract and the provider lifecycle in `src/storage/contract/` and `src/storage/provider.ts`.

## Module contract

Export a single entrypoint function:

```ts
export function createStorageProvider(
  context: StorageProviderFactoryContext,
): StorageProvider | Promise<StorageProvider>;
```

The app loads the module from `STORAGE_PROVIDER_MODULE` when set, otherwise it uses the built-in SQLite entrypoint.

## Compatibility rules

- Your adapter must report an exact storage contract revision match.
- The current required revision is `storage-v006`.
- Adapters must expose `platformConnections`; every tenant requires
  `platformConnectionId`.
- Connection names are globally unique. SQLite migration
  `sqlite:0008_v2_platform_connections` preserves tenant ids and keys while
  moving reusable GitLab credentials into connections.
- Interaction jobs expose provider-owned `triggerJson`; `commentId` is nullable.
  SQLite migration `sqlite:0009_v3_provider_triggers` rebuilds only the
  interaction job table, copies all rows, and derives trigger JSON from each
  preserved comment id. The Flotiq v003 migration pages through existing
  interaction jobs and batch-updates rows missing `triggerJson` before the
  migration is recorded.
- Project memory is a first-class `projectMemories` store. Each record is
  tenant-scoped, uses the tenant id as its record id, and stores serialized
  memory entries in `entriesJson`.
- `storage-v005` (breaking) makes the interaction-job store claim-aware. It must
  expose a `claimMode` (`"atomic"` or `"single-worker"`) and implement the
  claim-scoped operations (`claimNext`, `renewClaim`, `transitionClaim`,
  `expireQueued`, `reconcileOrphanedInteractionRuns`, and the `*ForClaim`
  run/finding/metric/snapshot/mapping methods). Claim-scoped methods return
  `false`/`null` on lease loss, and ordinary `EntityStore` mutations of an
  existing `in_progress` job must be rejected so fencing cannot be bypassed.
  `"atomic"` adapters (SQLite, via `BEGIN IMMEDIATE`) guarantee global
  single-review execution; `"single-worker"` adapters (Flotiq) require a single
  runner process while other replicas run with `REVIEWPHIN_JOB_RUNNER_ENABLED=false`.
  A reusable single-worker queue helper is available for adapters that declare
  that topology. The v005 migration adds `availableAt` (backfilled from
  `enqueuedAt`), claim fields, `latestInteractionRunId`, the `"expired"` status,
  nullable reasoning-effort fields on model profiles and runs, the run claim-token
  snapshot, and nullable `interactionRunId` on code-review snapshots; stop all
  v004 processes before migrating.
- `storage-v006` (breaking) stores one metrics record per harness session.
  Session identity is the interaction run, open-string harness name, and stable
  harness session key. `sessionType` and `usageUnit` remain open strings so
  custom harnesses do not require a contract revision to introduce values.
  `usageUnit` and `usageAmount` are both present or both absent, and
  `usageByModelJson` uses the same unit. Migrations preserve old counters,
  allocate legacy usage to the `unknown` model, and map `premiumRequests` to
  `github.copilot.premium-request`. SQLite preserves both timestamps; Flotiq
  preserves `createdAt` while its backfill advances provider-managed
  `updatedAt`. Cross-adapter migration may assign destination timestamps. Store
  filters also support `gte` and `lt`; providers must implement inclusive lower
  and exclusive upper boundaries, preferably in backend filters before
  pagination.
- The app validates compatibility in two phases:
  1. `getSupportedStorageContract()` is checked before `prepare()` is called.
  2. `prepare()` must return a `StoragePreparationResult` whose `storageContractRevision` is also checked after `prepare()` returns.
- Keep provider-local schema changes behind your own migrations and readiness logic.

## Provider responsibilities

Your provider owns:

- environment parsing and constructor inputs
- connection/client setup in `open()`
- idempotent startup preparation in `prepare()`, which returns `StoragePreparationResult` - `{ providerId, storageContractRevision, appliedMigrationIds }`
- store implementations returned by `createStores()`
- cleanup in `close()`

Required interface methods beyond the lifecycle: `getProviderId()` (string) and `getSupportedStorageContract()` (string).

The core app owns:

- cross-entity read models
- workflow orchestration
- compatibility enforcement

## Store boundary

- Keep stores CRUD/store-shaped around one persisted entity at a time.
- Keep provider-specific transport and schema details out of the app.
- Expose only the standard store contract (`get`, `getMany`, `find`, `list`, `upsert`, `upsertMany`, `replace`, `replaceMany`, `update`, `updateMany`, `patch`, `patchMany`, `delete`, `deleteMany`). The interaction-job store additionally extends this contract with the `storage-v005` claim-aware operations described above.
- If the app needs a query the filters/order contract cannot express efficiently, extend the shared filter/order types explicitly rather than adding provider-specific methods.

## Migrations

- Track migrations in provider-owned metadata storage.
- Make `prepare()` safe to call repeatedly.
- For baseline adoption, formalize the existing physical schema as a first tracked migration instead of silently repairing drift on startup.
- Keep each migration and its migration-specific helpers in a separate module.
  The SQLite adapter registers ordered modules from
  `src/storage/adapters/sqlite/migrations/`, matching the versioned module
  pattern used by Flotiq.

## Official SQLite adapter

The built-in adapter lives under `src/storage/adapters/sqlite/`.

- Module entrypoint: `src/storage/adapters/sqlite/entrypoint.ts`
- Runtime config: `SQLITE_DATABASE_PATH`
- Baseline migration id: `sqlite:0001_v0_baseline`
- Migration modules: `src/storage/adapters/sqlite/migrations/`
