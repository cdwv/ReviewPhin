import { describe, expect, it } from "vitest";

import { createSingleWorkerInteractionJobStore } from "../src/storage/adapters/single-worker-interaction-job-store.js";
import type {
  EntityStore,
  InteractionJobRecord,
  InteractionRunRecord,
  StoreValueFilter,
} from "../src/storage/contract/index.js";

type WithId = { id: string };

function matchesFilter(value: unknown, filter: StoreValueFilter<unknown>): boolean {
  if (filter.eq !== undefined && value !== filter.eq) {
    return false;
  }
  if (filter.neq !== undefined && value === filter.neq) {
    return false;
  }
  if (filter.in !== undefined && !filter.in.includes(value)) {
    return false;
  }
  if (filter.notIn !== undefined && filter.notIn.includes(value)) {
    return false;
  }
  if (filter.isNull !== undefined) {
    const isNull = value === null || value === undefined;
    if (isNull !== filter.isNull) {
      return false;
    }
  }
  return true;
}

function createInMemoryStore<T extends WithId>(): EntityStore<
  T,
  Partial<Record<string, StoreValueFilter<unknown>>>,
  string
> & { all(): T[] } {
  const rows = new Map<string, T>();

  function matches(
    row: T,
    filters?: Partial<Record<string, StoreValueFilter<unknown>>>,
  ) {
    if (!filters) {
      return true;
    }
    return Object.entries(filters).every(([field, filter]) =>
      filter ? matchesFilter((row as Record<string, unknown>)[field], filter) : true,
    );
  }

  return {
    all: () => [...rows.values()],
    async get(id) {
      return rows.get(id) ?? null;
    },
    async getMany(ids) {
      return ids
        .map((id) => rows.get(id))
        .filter((row): row is T => row !== undefined);
    },
    async find(filters) {
      return [...rows.values()].find((row) => matches(row, filters)) ?? null;
    },
    async list(input) {
      let results = [...rows.values()].filter((row) =>
        matches(row, input.filters),
      );
      const order = input.order?.[0];
      if (order) {
        results = results.sort((left, right) => {
          const a = (left as Record<string, unknown>)[order.field] as
            | string
            | number;
          const b = (right as Record<string, unknown>)[order.field] as
            | string
            | number;
          const cmp = a < b ? -1 : a > b ? 1 : 0;
          return order.direction === "desc" ? -cmp : cmp;
        });
      }
      const start = (input.page - 1) * input.pageSize;
      return results.slice(start, start + input.pageSize);
    },
    async upsert(entity) {
      rows.set(entity.id, entity);
    },
    async upsertMany(entities) {
      for (const entity of entities) {
        rows.set(entity.id, entity);
      }
    },
    async replace(entity) {
      rows.set(entity.id, entity);
    },
    async replaceMany(entities) {
      for (const entity of entities) {
        rows.set(entity.id, entity);
      }
    },
    async update({ value }) {
      rows.set(value.id, value);
    },
    async updateMany(inputs) {
      for (const { value } of inputs) {
        rows.set(value.id, value);
      }
    },
    async patch({ id, value }) {
      const existing = rows.get(id);
      if (existing) {
        rows.set(id, { ...existing, ...value });
      }
    },
    async patchMany(inputs) {
      for (const { id, value } of inputs) {
        const existing = rows.get(id);
        if (existing) {
          rows.set(id, { ...existing, ...value });
        }
      }
    },
    async delete(id) {
      rows.delete(id);
    },
    async deleteMany(ids) {
      for (const id of ids) {
        rows.delete(id);
      }
    },
  };
}

function makeStores(
  pageSize = 5,
  now: () => string = () => "2026-06-01T01:01:00.000Z",
) {
  const jobs = createInMemoryStore<InteractionJobRecord>();
  const runs = createInMemoryStore<InteractionRunRecord>();
  const metrics = createInMemoryStore();
  const snapshots = createInMemoryStore();
  const store = createSingleWorkerInteractionJobStore({
    jobs: jobs,
    runs: runs,
    reviewFindings: createInMemoryStore() as never,
    interactionRunMetrics: metrics as never,
    codeReviewSnapshots: snapshots as never,
    discussionMappings: createInMemoryStore() as never,
    pageSize,
    now,
  });
  return { jobs, runs, metrics, snapshots, store };
}

function makeJob(overrides: Partial<InteractionJobRecord> & { id: string }): InteractionJobRecord {
  return {
    tenantId: "tenant-1",
    dedupeKey: overrides.id,
    codeReviewId: 7,
    commentId: 1,
    triggerJson: "{}",
    headSha: "abc",
    status: "queued",
    payloadJson: "{}",
    retryCount: 0,
    lastError: null,
    enqueuedAt: "2026-06-01T00:00:00.000Z",
    availableAt: "2026-06-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    claimToken: null,
    claimedBy: null,
    claimExpiresAt: null,
    latestInteractionRunId: null,
    ...overrides,
  };
}

const QUEUED_AFTER = "2020-01-01T00:00:00.000Z";

describe("single-worker interaction job store", () => {
  it("reports single-worker claim mode", () => {
    const { store } = makeStores();
    expect(store.claimMode).toBe("single-worker");
  });

  it("claims the oldest eligible job and confirms via read-back", async () => {
    const { jobs, store } = makeStores();
    await jobs.upsert(
      makeJob({
        id: "job-b",
        enqueuedAt: "2026-06-01T00:00:02.000Z",
        availableAt: "2026-06-01T00:00:02.000Z",
      }),
    );
    await jobs.upsert(
      makeJob({
        id: "job-a",
        enqueuedAt: "2026-06-01T00:00:01.000Z",
        availableAt: "2026-06-01T00:00:01.000Z",
      }),
    );

    const claimed = await store.claimNext({
      workerId: "worker-1",
      claimToken: "token-1",
      now: "2026-06-01T01:00:00.000Z",
      claimExpiresAt: "2026-06-01T01:02:00.000Z",
      queuedAfter: QUEUED_AFTER,
      maxJobRetries: 3,
    });
    expect(claimed?.id).toBe("job-a");
    expect(claimed?.claimToken).toBe("token-1");

    const blocked = await store.claimNext({
      workerId: "worker-1",
      claimToken: "token-2",
      now: "2026-06-01T01:00:01.000Z",
      claimExpiresAt: "2026-06-01T01:02:01.000Z",
      queuedAfter: QUEUED_AFTER,
      maxJobRetries: 3,
    });
    expect(blocked).toBeNull();
  });

  it("recovers an expired lease and requeues within the retry budget", async () => {
    const { jobs, store } = makeStores();
    await jobs.upsert(makeJob({ id: "job-x" }));
    await store.claimNext({
      workerId: "worker-1",
      claimToken: "token-1",
      now: "2026-06-01T01:00:00.000Z",
      claimExpiresAt: "2026-06-01T01:00:30.000Z",
      queuedAfter: QUEUED_AFTER,
      maxJobRetries: 3,
    });

    const recovered = await store.claimNext({
      workerId: "worker-2",
      claimToken: "token-2",
      now: "2026-06-01T01:05:00.000Z",
      claimExpiresAt: "2026-06-01T01:07:00.000Z",
      queuedAfter: QUEUED_AFTER,
      maxJobRetries: 3,
    });
    expect(recovered?.claimToken).toBe("token-2");
    expect(recovered?.retryCount).toBe(1);

    expect(
      await store.transitionClaim({
        jobId: "job-x",
        claimToken: "token-1",
        status: "completed",
        retryCount: 1,
        lastError: null,
        availableAt: recovered!.availableAt,
        finishedAt: "2026-06-01T01:06:00.000Z",
      }),
    ).toBe(false);
  });

  it("rejects ordinary mutation of an in-progress job", async () => {
    const { jobs, store } = makeStores();
    await jobs.upsert(makeJob({ id: "job-guard" }));
    const claimed = await store.claimNext({
      workerId: "worker-1",
      claimToken: "token-1",
      now: "2026-06-01T01:00:00.000Z",
      claimExpiresAt: "2026-06-01T01:02:00.000Z",
      queuedAfter: QUEUED_AFTER,
      maxJobRetries: 3,
    });
    expect(claimed?.id).toBe("job-guard");

    await expect(
      store.patch({ id: "job-guard", value: { status: "completed" } }),
    ).rejects.toThrow(/in-progress/);
    await expect(store.delete("job-guard")).rejects.toThrow(/in-progress/);
  });

  it("creates runs, sets latestInteractionRunId, and fences stale tokens", async () => {
    const { jobs, store } = makeStores();
    await jobs.upsert(makeJob({ id: "job-run" }));
    await store.claimNext({
      workerId: "worker-1",
      claimToken: "token-1",
      now: "2026-06-01T01:00:00.000Z",
      claimExpiresAt: "2026-06-01T01:02:00.000Z",
      queuedAfter: QUEUED_AFTER,
      maxJobRetries: 3,
    });

    const run = await store.createInteractionRunForClaim({
      jobId: "job-run",
      claimToken: "token-1",
      run: {
        interactionJobId: "job-run",
        tenantId: "tenant-1",
        provider: "copilot-sdk",
        model: "gpt-5.6",
        modelProfileName: null,
        providerBaseUrl: null,
        providerType: null,
        textGenerationModel: null,
        reviewReasoningEffort: "medium",
        textGenerationReasoningEffort: null,
      },
    });
    expect(run?.interactionJobClaimToken).toBe("token-1");
    expect(run?.reviewReasoningEffort).toBe("medium");
    const job = await store.get("job-run");
    expect(job?.latestInteractionRunId).toBe(run?.id);

    expect(
      await store.createInteractionRunForClaim({
        jobId: "job-run",
        claimToken: "stale",
        run: {
          interactionJobId: "job-run",
          tenantId: "tenant-1",
          provider: "copilot-sdk",
          model: "gpt-5.6",
          modelProfileName: null,
          providerBaseUrl: null,
          providerType: null,
          textGenerationModel: null,
        },
      }),
    ).toBeNull();

    expect(
      await store.createInteractionRunForClaim({
        jobId: "job-run",
        claimToken: "token-1",
        run: {
          interactionJobId: "different-job",
          tenantId: "tenant-1",
          provider: "copilot-sdk",
          model: "gpt-5.6",
          modelProfileName: null,
          providerBaseUrl: null,
          providerType: null,
          textGenerationModel: null,
        },
      }),
    ).toBeNull();
  });

  it("serializes heartbeat renewal with terminal transition", async () => {
    const { jobs, store } = makeStores();
    await jobs.upsert(makeJob({ id: "job-heartbeat" }));
    await store.claimNext({
      workerId: "worker-1",
      claimToken: "token-1",
      now: "2026-06-01T01:00:00.000Z",
      claimExpiresAt: "2026-06-01T01:02:00.000Z",
      queuedAfter: QUEUED_AFTER,
      maxJobRetries: 3,
    });

    const [renewed, completed] = await Promise.all([
      store.renewClaim({
        jobId: "job-heartbeat",
        claimToken: "token-1",
        now: "2026-06-01T01:01:00.000Z",
        claimExpiresAt: "2026-06-01T01:03:00.000Z",
      }),
      store.transitionClaim({
        jobId: "job-heartbeat",
        claimToken: "token-1",
        status: "completed",
        retryCount: 0,
        lastError: null,
        availableAt: "2026-06-01T00:00:00.000Z",
        finishedAt: "2026-06-01T01:01:01.000Z",
      }),
    ]);

    expect(renewed).toBe(true);
    expect(completed).toBe(true);
    expect(await store.get("job-heartbeat")).toMatchObject({
      status: "completed",
      claimToken: null,
      claimExpiresAt: null,
    });
  });

  it("does not renew a claim at or after its persisted lease deadline", async () => {
    const { jobs, store } = makeStores(
      5,
      () => "2026-06-01T01:02:00.000Z",
    );
    await jobs.upsert(makeJob({ id: "job-expired-renewal" }));
    await store.claimNext({
      workerId: "worker-1",
      claimToken: "token-1",
      now: "2026-06-01T01:00:00.000Z",
      claimExpiresAt: "2026-06-01T01:02:00.000Z",
      queuedAfter: QUEUED_AFTER,
      maxJobRetries: 3,
    });

    expect(
      await store.renewClaim({
        jobId: "job-expired-renewal",
        claimToken: "token-1",
        now: "2026-06-01T01:01:00.000Z",
        claimExpiresAt: "2026-06-01T01:04:00.000Z",
      }),
    ).toBe(false);
    expect(await store.get("job-expired-renewal")).toMatchObject({
      claimExpiresAt: "2026-06-01T01:02:00.000Z",
    });
  });

  it("rejects claim-scoped writes after the persisted lease deadline", async () => {
    let currentTime = "2026-06-01T01:01:00.000Z";
    const { jobs, store } = makeStores(5, () => currentTime);
    await jobs.upsert(makeJob({ id: "job-expired-write" }));
    await store.claimNext({
      workerId: "worker-1",
      claimToken: "token-1",
      now: "2026-06-01T01:00:00.000Z",
      claimExpiresAt: "2026-06-01T01:02:00.000Z",
      queuedAfter: QUEUED_AFTER,
      maxJobRetries: 3,
    });
    const runInput = {
      interactionJobId: "job-expired-write",
      tenantId: "tenant-1",
      provider: "copilot-sdk",
      model: "gpt-5.6",
      modelProfileName: null,
      providerBaseUrl: null,
      providerType: null,
      textGenerationModel: null,
    };
    const run = await store.createInteractionRunForClaim({
      jobId: "job-expired-write",
      claimToken: "token-1",
      run: runInput,
    });
    expect(run).not.toBeNull();

    currentTime = "2026-06-01T01:02:00.000Z";
    await expect(
      store.createInteractionRunForClaim({
        jobId: "job-expired-write",
        claimToken: "token-1",
        run: runInput,
      }),
    ).resolves.toBeNull();
    await expect(
      store.transitionInteractionRunForClaim({
        jobId: "job-expired-write",
        claimToken: "token-1",
        interactionRunId: run!.id,
        status: "completed",
        resultJson: "{}",
        error: null,
        finishedAt: currentTime,
      }),
    ).resolves.toBe(false);
  });

  it("reconciles orphaned in-progress runs after the job loses its claim", async () => {
    const { jobs, store } = makeStores();
    await jobs.upsert(makeJob({ id: "job-orphan" }));
    await store.claimNext({
      workerId: "worker-1",
      claimToken: "token-1",
      now: "2026-06-01T01:00:00.000Z",
      claimExpiresAt: "2026-06-01T01:02:00.000Z",
      queuedAfter: QUEUED_AFTER,
      maxJobRetries: 3,
    });
    const run = await store.createInteractionRunForClaim({
      jobId: "job-orphan",
      claimToken: "token-1",
      run: {
        interactionJobId: "job-orphan",
        tenantId: "tenant-1",
        provider: "copilot-sdk",
        model: "gpt-5.6",
        modelProfileName: null,
        providerBaseUrl: null,
        providerType: null,
        textGenerationModel: null,
      },
    });

    await store.transitionClaim({
      jobId: "job-orphan",
      claimToken: "token-1",
      status: "queued",
      retryCount: 1,
      lastError: "retry",
      availableAt: "2026-06-01T02:00:00.000Z",
      finishedAt: null,
    });

    const reconciled = await store.reconcileOrphanedInteractionRuns({
      now: "2026-06-01T02:05:00.000Z",
      limit: 10,
    });
    expect(reconciled.map((entry) => entry.id)).toContain(run?.id);
    expect(reconciled[0]?.status).toBe("failed");
  });

  it("updateReviewFindingStatusForClaim reports true on no-match and false only on ownership failure", async () => {
    const { jobs, store } = makeStores();
    await jobs.upsert(makeJob({ id: "job-fs" }));
    await store.claimNext({
      workerId: "worker-1",
      claimToken: "token-1",
      now: "2026-06-01T01:00:00.000Z",
      claimExpiresAt: "2026-06-01T01:02:00.000Z",
      queuedAfter: QUEUED_AFTER,
      maxJobRetries: 3,
    });
    const run = await store.createInteractionRunForClaim({
      jobId: "job-fs",
      claimToken: "token-1",
      run: {
        interactionJobId: "job-fs",
        tenantId: "tenant-1",
        provider: "copilot-sdk",
        model: "gpt-5.6",
        modelProfileName: null,
        providerBaseUrl: null,
        providerType: null,
        textGenerationModel: null,
      },
    });

    const owned = await store.updateReviewFindingStatusForClaim({
      jobId: "job-fs",
      claimToken: "token-1",
      interactionRunId: run!.id,
      tenantId: "tenant-1",
      codeReviewId: 7,
      identityKey: "no-such-finding",
      status: "resolved",
    });
    expect(owned).toBe(true);

    const fenced = await store.updateReviewFindingStatusForClaim({
      jobId: "job-fs",
      claimToken: "stale",
      interactionRunId: run!.id,
      tenantId: "tenant-1",
      codeReviewId: 7,
      identityKey: "no-such-finding",
      status: "resolved",
    });
    expect(fenced).toBe(false);
  });

  it("reconciles a completed run whose job never completed under that attempt", async () => {
    const { jobs, store } = makeStores();
    await jobs.upsert(makeJob({ id: "job-false" }));
    await store.claimNext({
      workerId: "worker-1",
      claimToken: "token-1",
      now: "2026-06-01T01:00:00.000Z",
      claimExpiresAt: "2026-06-01T01:02:00.000Z",
      queuedAfter: QUEUED_AFTER,
      maxJobRetries: 3,
    });
    const run = await store.createInteractionRunForClaim({
      jobId: "job-false",
      claimToken: "token-1",
      run: {
        interactionJobId: "job-false",
        tenantId: "tenant-1",
        provider: "copilot-sdk",
        model: "gpt-5.6",
        modelProfileName: null,
        providerBaseUrl: null,
        providerType: null,
        textGenerationModel: null,
      },
    });
    await store.transitionInteractionRunForClaim({
      jobId: "job-false",
      claimToken: "token-1",
      interactionRunId: run!.id,
      status: "completed",
      resultJson: '{"ok":true}',
      error: null,
      finishedAt: "2026-06-01T01:01:00.000Z",
    });
    // The job completion lost its lease and was requeued; latestInteractionRunId
    // still points at the completed run.
    await store.transitionClaim({
      jobId: "job-false",
      claimToken: "token-1",
      status: "queued",
      retryCount: 1,
      lastError: "lease lost",
      availableAt: "2026-06-01T02:00:00.000Z",
      finishedAt: null,
    });

    const reconciled = await store.reconcileOrphanedInteractionRuns({
      now: "2026-06-01T02:05:00.000Z",
      limit: 10,
    });
    expect(reconciled.map((entry) => entry.id)).toContain(run?.id);
    expect(reconciled[0]?.status).toBe("failed");

    // Idempotent: a second pass leaves the failed run alone.
    const second = await store.reconcileOrphanedInteractionRuns({
      now: "2026-06-01T02:06:00.000Z",
      limit: 10,
    });
    expect(second.map((entry) => entry.id)).not.toContain(run?.id);
  });

  it("preserves a legitimately completed run for a completed job", async () => {
    const { jobs, runs, store } = makeStores();
    await jobs.upsert(makeJob({ id: "job-done" }));
    await store.claimNext({
      workerId: "worker-1",
      claimToken: "token-1",
      now: "2026-06-01T01:00:00.000Z",
      claimExpiresAt: "2026-06-01T01:02:00.000Z",
      queuedAfter: QUEUED_AFTER,
      maxJobRetries: 3,
    });
    const run = await store.createInteractionRunForClaim({
      jobId: "job-done",
      claimToken: "token-1",
      run: {
        interactionJobId: "job-done",
        tenantId: "tenant-1",
        provider: "copilot-sdk",
        model: "gpt-5.6",
        modelProfileName: null,
        providerBaseUrl: null,
        providerType: null,
        textGenerationModel: null,
      },
    });
    await store.transitionInteractionRunForClaim({
      jobId: "job-done",
      claimToken: "token-1",
      interactionRunId: run!.id,
      status: "completed",
      resultJson: "{}",
      error: null,
      finishedAt: "2026-06-01T01:01:00.000Z",
    });
    await store.transitionClaim({
      jobId: "job-done",
      claimToken: "token-1",
      status: "completed",
      retryCount: 0,
      lastError: null,
      availableAt: "2026-06-01T00:00:00.000Z",
      finishedAt: "2026-06-01T01:01:30.000Z",
    });

    const reconciled = await store.reconcileOrphanedInteractionRuns({
      now: "2026-06-01T02:00:00.000Z",
      limit: 10,
    });
    expect(reconciled.map((entry) => entry.id)).not.toContain(run?.id);
    const stored = await store.get("job-done");
    expect(stored?.status).toBe("completed");
    const storedRun = await runs.get(run!.id);
    expect(storedRun?.status).toBe("completed");
  });

  it("advances a bounded reconciliation cursor across non-completed jobs", async () => {
    const { jobs, runs, store } = makeStores(2);
    await jobs.upsert(makeJob({ id: "job-a", status: "failed" }));
    await jobs.upsert(makeJob({ id: "job-b", status: "cancelled" }));
    await jobs.upsert(
      makeJob({
        id: "job-z",
        status: "failed",
        latestInteractionRunId: "run-z",
      }),
    );
    await runs.upsert({
      id: "run-z",
      interactionJobId: "job-z",
      tenantId: "tenant-1",
      provider: "copilot-sdk",
      model: "gpt-5.6",
      modelProfileName: null,
      providerBaseUrl: null,
      providerType: null,
      textGenerationModel: null,
      status: "completed",
      resultJson: '{"ok":true}',
      error: null,
      startedAt: "2026-06-01T01:00:00.000Z",
      finishedAt: "2026-06-01T01:01:00.000Z",
      interactionJobClaimToken: "token-z",
      reviewReasoningEffort: null,
      textGenerationReasoningEffort: null,
    });

    expect(
      await store.reconcileOrphanedInteractionRuns({
        now: "2026-06-01T02:00:00.000Z",
        limit: 10,
      }),
    ).toEqual([]);
    const second = await store.reconcileOrphanedInteractionRuns({
      now: "2026-06-01T02:01:00.000Z",
      limit: 10,
    });

    expect(second.map((run) => run.id)).toEqual(["run-z"]);
    expect(await runs.get("run-z")).toMatchObject({ status: "failed" });
  });
});
