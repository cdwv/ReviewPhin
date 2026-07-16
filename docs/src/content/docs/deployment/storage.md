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

Flotiq has no compare-and-set transaction spanning job selection and update, so it reports `claimMode: "single-worker"`. Only **one** ReviewPhin process may run the job runner. Any additional HTTP replicas must set `REVIEWPHIN_JOB_RUNNER_ENABLED=false`. Every process using a single-worker adapter logs a warning that restates this topology. Global single-review execution across competing runner processes is guaranteed only by `atomic` adapters like SQLite. CLI processes may administer and observe storage under either claim mode because they never claim or execute jobs.

## Custom adapters

Set the module path or package name:

```ini
STORAGE_PROVIDER_MODULE=@my-org/reviewphin-postgres
```

A custom adapter must report the current storage contract revision, `storage-v006`, implement claim-aware interaction-job operations, and store one metrics record per harness session. Implementation details are in [custom storage adapters](../../development/custom-storage/).

### Upgrading to storage-v006

`storage-v006` is a breaking revision for interaction-run metrics. Stop older processes before migrating. Built-in adapters preserve every existing metrics row, its timestamps, and its operational counters. Legacy premium-request values receive a deterministic session identity and the open unit key `github.copilot.premium-request`.

SQLite rebuilds only the metrics table and copies all existing rows before replacing it. Flotiq first adds the new identity fields as optional, backfills every metrics object, and only then installs the final required shape. Do not mark a custom-provider migration complete until its backfill succeeds.

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
