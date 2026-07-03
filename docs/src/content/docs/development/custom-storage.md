---
title: Custom storage adapters
description: Implement a storage provider for another persistence backend.
---

Custom storage adapters let ReviewPhin persist to PostgreSQL, MySQL, a cloud key-value store, or internal storage. They are loaded with `STORAGE_PROVIDER_MODULE`.

:::note[Operating vs. implementing]
This page is about **implementing** an adapter. To configure, back up, or migrate an existing provider, see [storage & migration](../../deployment/storage/).
:::

```ini
STORAGE_PROVIDER_MODULE=@my-org/reviewphin-postgres
```

## Required contract

Adapters must report the current storage contract revision:

```ts
getSupportedStorageContract(): string {
  return "storage-v004";
}
```

They must implement all stores required by the current contract and return a valid preparation result from `prepare()`:

```ts
{
  providerId,
  storageContractRevision,
  appliedMigrationIds
}
```

Each entity store implements `get`, `getMany`, `find`, `list`, `upsert`, `upsertMany`, `replace`, `replaceMany`, `update`, `updateMany`, `patch`, `patchMany`, `delete`, and `deleteMany`.

Use `src/storage/adapters/README.md` and the SQLite adapter as implementation references.

## Contract revision notes

- `storage-v003` added provider-owned interaction trigger identity through `InteractionJobRecord.triggerJson` and made `commentId` nullable. Built-in migrations preserve existing GitLab jobs and synthesize trigger JSON from the existing comment id.
- `storage-v004` added `ProjectMemoryRecord` and the `projectMemories` store. There is at most one project memory record per tenant, with the record id equal to the tenant id. Built-in adapters delete that row during tenant deletion and include it in tenant deletion summaries.

## Verify a new adapter

Point `STORAGE_PROVIDER_MODULE` at the adapter and use the CLI against it: `tenant add`, `tenant list`, then a real review. `storage migrate` can seed it from an existing SQLite database — see [migrating between adapters](../../deployment/storage/#migrating-between-adapters).
