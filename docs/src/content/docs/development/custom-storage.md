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
  return "storage-v005";
}
```

They must implement all stores required by the current contract and return a valid preparation result from `prepare()`:

```ts
return {
  providerId: "my-adapter",
  storageContractRevision: "storage-v005",
  appliedMigrationIds: [],
};
```

Each entity store implements `get`, `getMany`, `find`, `list`, `upsert`, `upsertMany`, `replace`, `replaceMany`, `update`, `updateMany`, `patch`, `patchMany`, `delete`, and `deleteMany`.

Use `src/storage/adapters/README.md` and the SQLite adapter as implementation references.

## Claim-aware interaction jobs

`storage-v005` makes the interaction-job store claim-aware. Beyond the standard store operations, it must expose a `claimMode` and claim-scoped operations that fence work by claim token:

- `claimMode` is `"atomic"` or `"single-worker"`.
- `claimNext` recovers expired leases, preserves single active execution, selects an eligible job (`status = queued`, `enqueuedAt >= queuedAfter`, `availableAt <= now`) ordered by `availableAt`, then `enqueuedAt`, then id, and claims it with a fresh token.
- `renewClaim`, `transitionClaim`, and the `*ForClaim` run/finding/metric/snapshot/mapping operations return `false` or `null` when the token no longer owns the job. Callers treat that as lease loss and stop writing for that attempt.
- `expireQueued` and `reconcileOrphanedInteractionRuns` provide bounded maintenance.
- Ordinary `EntityStore` mutations of an existing `in_progress` job must be rejected so they cannot bypass fencing.

Pick a claim mode by what your backend can guarantee:

- **`atomic`** — the backend can select-and-claim in one atomic step (like SQLite's `BEGIN IMMEDIATE`). Global single-review execution holds even with many runner processes.
- **`single-worker`** — the backend has no cross-request compare-and-set. Only one runner process may execute jobs; additional replicas must set `REVIEWPHIN_JOB_RUNNER_ENABLED=false`. ReviewPhin ships a reusable single-worker queue helper on top of the generic entity store that you can reuse when declaring this topology.

The claim token fences an abandoned attempt after its lease expires. Because a third-party provider request cannot be made transactional with the storage lease, an in-flight external call may still finish after lease loss; exactly-once external side effects remain outside the fencing guarantee. Project-memory writes are also outside claim fencing by design.

## Contract revision notes

- `storage-v003` added provider-owned interaction trigger identity through `InteractionJobRecord.triggerJson` and made `commentId` nullable. Built-in migrations preserve existing GitLab jobs and synthesize trigger JSON from the existing comment id.
- `storage-v004` added `ProjectMemoryRecord` and the `projectMemories` store. There is at most one project memory record per tenant, with the record id equal to the tenant id. Built-in adapters delete that row during tenant deletion and include it in tenant deletion summaries.
- `storage-v005` (breaking) added claim-aware interaction-job operations, the terminal `"expired"` status, and job fields `availableAt`, `claimToken`, `claimedBy`, `claimExpiresAt`, and `latestInteractionRunId`. It also added nullable `reviewReasoningEffort` and `textGenerationReasoningEffort` to model profiles and interaction runs, an `interactionJobClaimToken` snapshot on runs, and nullable `interactionRunId` on code-review snapshots. Migrations preserve existing rows, backfill `availableAt` from `enqueuedAt`, and leave new nullable fields empty. Migrate with `availableAt` optional first, backfill legacy rows, then require it. **Stop all v004 processes before migrating** so a recovered job row cannot keep running under an old worker.

## Verify a new adapter

Point `STORAGE_PROVIDER_MODULE` at the adapter and use the CLI against it: `tenant add`, `tenant list`, then a real review. `storage migrate` can seed it from an existing SQLite database — see [migrating between adapters](../../deployment/storage/#migrating-between-adapters).
