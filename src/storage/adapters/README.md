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
- The current required revision is `storage-v000`.
- The app validates compatibility in two phases:
  1. `getSupportedStorageContract()` is checked before `prepare()` is called.
  2. `prepare()` must return a `StoragePreparationResult` whose `storageContractRevision` is also checked after `prepare()` returns.
- Keep provider-local schema changes behind your own migrations and readiness logic.

## Provider responsibilities

Your provider owns:

- environment parsing and constructor inputs
- connection/client setup in `open()`
- idempotent startup preparation in `prepare()`, which returns `StoragePreparationResult` — `{ providerId, storageContractRevision, appliedMigrationIds }`
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
- Expose only the standard store contract (`get`, `getMany`, `find`, `list`, `upsert`, `replace`, `update`, `patch`, `delete`, `deleteMany`).
- If the app needs a query the filters/order contract cannot express efficiently, extend the shared filter/order types explicitly rather than adding provider-specific methods.

## Migrations

- Track migrations in provider-owned metadata storage.
- Make `prepare()` safe to call repeatedly.
- For baseline adoption, formalize the existing physical schema as a first tracked migration instead of silently repairing drift on startup.

## Official SQLite adapter

The built-in adapter lives under `src/storage/adapters/sqlite/`.

- Module entrypoint: `src/storage/adapters/sqlite/entrypoint.ts`
- Runtime config: `SQLITE_DATABASE_PATH`
- Baseline migration id: `sqlite:0001_v0_baseline`
