# Storage providers

ReviewPhin uses a pluggable storage layer. The built-in adapter is SQLite. External adapters are loaded dynamically via `STORAGE_PROVIDER_MODULE`.

---

## SQLite (default)

No extra configuration is needed. The built-in SQLite adapter is used when `STORAGE_PROVIDER_MODULE` is not set.

### Configuration

| Environment variable   | Default                       | Description                       |
| ---------------------- | ----------------------------- | --------------------------------- |
| `SQLITE_DATABASE_PATH` | `./data/review-worker.sqlite` | Path to the SQLite database file. |

In Docker, the `./data` directory is mounted as a persistent volume. The default path keeps the database there automatically.

### Migrations

The SQLite adapter runs idempotent schema migrations on startup. No manual migration step is needed. The migration history is tracked in the database itself.

### Backup and portability

SQLite produces a single file. Back it up by copying the file. To move data to another adapter, use the `storage migrate` CLI command:

```bash
reviewphin storage migrate \
  --from-sqlite-database-path ./data/review-worker.sqlite \
  --to-storage-provider-module <other-adapter>
```

---

## Flotiq

[Flotiq](https://flotiq.com/) is a headless CMS with a REST API. ReviewPhin includes a Flotiq storage adapter as an alternative to SQLite for cases where you want an **admin panel** for managing configuration instead of going through the CLI.

### When to use Flotiq

Flotiq is useful when you want a managed, API-accessible data store without running a database yourself - and when the built-in admin panel for browsing and editing data is more convenient than the CLI. It is hosted, so it adds an external dependency; consider whether that aligns with your privacy and self-hosting requirements.

### Setup

1. Create a Flotiq account and workspace.
2. Generate a **Read & Write** API key from the Flotiq dashboard.
3. Set the following environment variable:

   ```env
   FLOTIQ_API_KEY=fl.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

4. Set `STORAGE_PROVIDER_MODULE` to the built-in Flotiq entrypoint:

   ```env
   STORAGE_PROVIDER_MODULE=flotiq
   ```

5. On first startup, the adapter will create the required Flotiq content type definitions (schema migration). This requires a read-write API key with content-type management permissions.

### Configuration

| Environment variable | Required | Description                  |
| -------------------- | -------- | ---------------------------- |
| `FLOTIQ_API_KEY`     | Yes      | Flotiq Read & Write API key. |

### Migrating from SQLite to Flotiq

```bash
reviewphin storage migrate \
  --from-sqlite-database-path ./data/review-worker.sqlite \
  --to-storage-provider-module ./dist/storage/adapters/flotiq/entrypoint.js
```

Set `FLOTIQ_API_KEY` in the environment before running the migration command.

---

## Writing a custom storage adapter

The storage layer is designed to be extended. To implement your own adapter (PostgreSQL, MySQL, a cloud KV store, etc.):

1. Export a single entrypoint function:

   ```ts
   export function createStorageProvider(
     context: StorageProviderFactoryContext,
   ): StorageProvider | Promise<StorageProvider>;
   ```

2. Report the current storage contract revision from `getSupportedStorageContract()`:

   ```ts
   getSupportedStorageContract(): string {
     return "storage-v000";
   }
   ```

3. Implement the full store contract for each entity (`get`, `getMany`, `find`, `list`, `upsert`, `upsertMany`, `replace`, `replaceMany`, `update`, `updateMany`, `patch`, `patchMany`, `delete`, `deleteMany`).

4. Return a valid `StoragePreparationResult` from `prepare()` including `{ providerId, storageContractRevision, appliedMigrationIds }`.

5. Set `STORAGE_PROVIDER_MODULE` to your adapter's module path or package name.

See `src/storage/adapters/README.md` in the repository for the full adapter author guide, and `src/storage/adapters/sqlite/` for a reference implementation.

---

## Future adapters

The following adapters are not yet implemented but are probably the first to appear:

| Adapter                      | Notes                                                                   |
| ---------------------------- | ----------------------------------------------------------------------- |
| **PostgreSQL**               | Suitable for production deployments that already run a Postgres cluster |
| **MySQL / MariaDB**          | Alternative relational backend                                          |
| **DynamoDB / Cloudflare D1** | Serverless-friendly key-value or SQL stores                             |

Contributions welcome - see [CONTRIBUTORS.md](../CONTRIBUTORS.md) for how to submit a pull request.
