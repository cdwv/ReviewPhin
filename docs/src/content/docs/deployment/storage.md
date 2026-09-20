---
title: Storage & migration
description: Configure SQLite, Flotiq, or a custom adapter, and move data between them.
---

ReviewPhin uses a pluggable storage layer for tenants, connections, jobs, runs, findings, discussion mappings, model profiles, and project memory. SQLite is the built-in default; Flotiq is included as an alternative; custom adapters load through `STORAGE_PROVIDER_MODULE`.

:::note[Which storage page do I need?]
This page covers **operating** storage: choosing a provider, configuring it, backups, and migration. To **implement** a new adapter against the storage contract, see [custom storage adapters](../../development/custom-storage/).
:::

## Choose a provider

<details>
<summary><strong>Help me choose</strong></summary>

- **Just running one instance?** Use **SQLite**. It is the default and needs no configuration beyond a persistent volume.
- **Want a browsable admin panel and are fine with a hosted dependency?** Use **Flotiq**.
- **Need PostgreSQL, MySQL, a cloud key-value store, or internal storage?** Write or install a [custom adapter](../../development/custom-storage/).

</details>

| Provider | Status            | Best for                                                       |
| -------- | ----------------- | -------------------------------------------------------------- |
| SQLite   | Built in, default | Single-container and simple production deployments             |
| Flotiq   | Built in          | Hosted storage with an admin panel                             |
| Custom   | Module loading    | Teams needing PostgreSQL, MySQL, cloud KV, or internal storage |

## SQLite

No extra configuration is needed when `STORAGE_PROVIDER_MODULE` is unset.

```ini
SQLITE_DATABASE_PATH=./data/review-worker.sqlite
```

In Docker and Kubernetes, keep the database directory on persistent storage so it survives container replacement. The adapter runs idempotent schema migrations on startup; history is tracked in the database and in source under `src/storage/adapters/sqlite/migrations/`.

SQLite claims jobs atomically inside adapter-local transactions (`claimMode: "atomic"`). This guarantees one active review globally even when several ReviewPhin processes share the database, so every replica may run the job runner.

### Backup

Copy the database file while the worker is stopped, or use SQLite's online backup:

```bash
sqlite3 ./data/review-worker.sqlite ".backup './data/review-worker.sqlite.bak'"
```

For scheduled backups, write to a separate directory:

```bash
mkdir -p ./data/backups
sqlite3 ./data/review-worker.sqlite ".backup './data/backups/review-worker.sqlite.$(date -Iminutes).bak'"
```

## Flotiq

Use Flotiq when a hosted admin panel for browsing and editing data is more useful than CLI-only operations. It is hosted, so it adds an external dependency — confirm that fits your privacy and self-hosting requirements.

```ini
FLOTIQ_API_KEY=fl.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
STORAGE_PROVIDER_MODULE=flotiq
```

The API key must be able to manage content type definitions. On first startup the adapter creates or updates the required content type definitions.

The Flotiq adapter saves a request, attaches it to a batch, and updates the batch's ready time through separate API calls. Another operation must not start claiming that batch halfway through those writes.

The adapter solves this by keeping an internal queue: it finishes one batch update or job claim before starting the next. That queue belongs to one running copy of ReviewPhin. A second copy has its own queue, so the two copies cannot protect each other from conflicting writes.

**Run one copy of ReviewPhin to receive comment webhooks and execute jobs when using Flotiq.** Do not send comment webhooks to a second copy, even with its job runner disabled. SQLite protects the same operations with database transactions, which coordinate all copies sharing that database.

This difference stays inside the storage adapters. The worker calls the same storage methods for both. The app displays a startup warning when an adapter reports this single-copy requirement. CLI commands can still administer and inspect storage because they do not collect webhook comment batches or claim jobs.

## Custom adapters

Set the module path or package name:

```ini
STORAGE_PROVIDER_MODULE=@my-org/reviewphin-postgres
```

A custom adapter must report the current storage contract revision, `storage-v007`, implement claim-aware interaction-job operations, and store one metrics record per harness session. Implementation details are in [custom storage adapters](../../development/custom-storage/).

### Upgrading to storage-v007

Stop older service processes and back up storage before upgrading. SQLite migration `sqlite:0013_v7_interaction_batches` adds an interaction-request table, a nullable job batch marker, saved batch output on runs, and routing-model settings on profiles. Every existing job receives one request record containing its original trigger, payload, revision, and enqueue time. Existing jobs remain separate and closed to grouping; existing results, metrics, and other data stay intact.

Flotiq v007 adds the same fields and creates deterministic request records in pages. It verifies each backfill before recording migration completion, so an interrupted migration can resume. Existing Flotiq objects are not rewritten. If a restart interrupts the separate API writes, the adapter finishes assigning the saved request before accepting another request or claiming a job. Follow the single-copy deployment requirement above.

### Upgrading to storage-v006

`storage-v006` is a breaking revision for interaction-run metrics. Stop older processes before migrating. Built-in adapters preserve every existing metrics row and its operational counters. Legacy premium-request values receive a deterministic session identity, the open unit key `github.copilot.premium-request`, and an `unknown` model allocation so model and monthly totals still include that usage.

SQLite rebuilds only the metrics table and copies all existing rows, including `createdAt` and `updatedAt`, before replacing it. Flotiq first adds the new identity fields as optional, backfills every metrics object, and only then installs the final required shape. The Flotiq update retains each object's `createdAt`, while Flotiq advances its provider-managed `updatedAt` to the backfill time. The migration also retains the existing field help text. Do not mark a custom-provider migration complete until its backfill succeeds.

After upgrading, use [`metrics collect`](../../management/cli-reference/#metrics-collect) to import supported historical session files. Collection does not remove those files. Keep run logs until stored counts have been checked for the deployment.

### Upgrading to storage-v005

`storage-v005` is a breaking revision that adds job leases and claim fields. Before applying its migration, **stop all older (v004) processes** so an old worker cannot keep running after its job row is recovered. Built-in migrations preserve existing rows and backfill each job's `availableAt` from its `enqueuedAt`; a legacy in-progress job with no claim fields is treated as an expired lease and recovered on the first claim pass.

## Migrating between adapters

Use `storage migrate` to copy all data from one adapter to another — for example from SQLite to a custom adapter, or between SQLite databases.

```bash
reviewphin storage migrate \
  --from-storage-provider-module sqlite \
  --from-sqlite-database-path ./data/review-worker.sqlite \
  --to-storage-provider-module @my-org/reviewphin-postgres
```

Migrating to Flotiq points the target at the Flotiq entrypoint (set `FLOTIQ_API_KEY` first):

```bash
reviewphin storage migrate \
  --from-storage-provider-module sqlite \
  --from-sqlite-database-path ./data/review-worker.sqlite \
  --to-storage-provider-module flotiq
```

`sqlite` and `flotiq` are built-in storage module shorthands. `source-*` is an alias for `from-*`, and `destination-*` is an alias for `to-*`. Full flags are in the [CLI reference](../../management/cli-reference/#storage-migrate). Stop the worker (or run during a quiet window) so no new writes land in the source mid-migration, then switch `STORAGE_PROVIDER_MODULE` to the target before restarting.

Cross-adapter migration preserves the application data used for historical reporting, such as a run's `startedAt`. Provider-managed `createdAt` and `updatedAt` values may be assigned again by the destination adapter, especially when migrating to Flotiq. Treat timestamp equality across adapters as unsupported and do not use those provider-managed values as the historical event time.
