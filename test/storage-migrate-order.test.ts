import { describe, expect, it, vi } from "vitest";

const { initializeStorageRuntime } = vi.hoisted(() => ({
  initializeStorageRuntime: vi.fn(),
}));

vi.mock("../src/storage/runtime.js", () => ({
  initializeStorageRuntime,
}));

vi.mock("../src/env.js", () => ({
  loadLocalEnvFile: vi.fn(),
}));

import { runCli } from "../src/cli.js";

describe("storage migrate ordering", () => {
  it("pages source stores with deterministic per-store order", async () => {
    const orderCalls = {
      modelProfiles: [] as unknown[],
      platformConnections: [] as unknown[],
      tenants: [] as unknown[],
      interactionJobs: [] as unknown[],
      codeReviewSnapshots: [] as unknown[],
      interactionRuns: [] as unknown[],
      interactionRunMetrics: [] as unknown[],
      reviewFindings: [] as unknown[],
      discussionMappings: [] as unknown[],
    };

    const sourceRuntime = createRuntime({
      providerId: "source",
      moduleSpecifier: "source-module",
      stores: {
        modelProfiles: createSourceStore(
          [
            {
              name: "profile-1",
            },
          ],
          orderCalls.modelProfiles,
        ),
        platformConnections: createSourceStore(
          [{ id: "connection-1" }],
          orderCalls.platformConnections,
        ),
        tenants: createSourceStore(
          [
            {
              id: "tenant-1",
            },
          ],
          orderCalls.tenants,
        ),
        interactionJobs: createSourceStore(
          [
            {
              id: "job-1",
              tenantId: "tenant-1",
            },
          ],
          orderCalls.interactionJobs,
        ),
        codeReviewSnapshots: createSourceStore(
          [
            {
              id: "snapshot-1",
              interactionJobId: "job-1",
              tenantId: "tenant-1",
            },
          ],
          orderCalls.codeReviewSnapshots,
        ),
        interactionRuns: createSourceStore(
          [
            {
              id: "run-1",
              interactionJobId: "job-1",
              tenantId: "tenant-1",
            },
          ],
          orderCalls.interactionRuns,
        ),
        interactionRunMetrics: createSourceStore(
          [
            {
              id: "metrics-1",
              interactionRunId: "run-1",
            },
          ],
          orderCalls.interactionRunMetrics,
        ),
        reviewFindings: createSourceStore(
          [
            {
              id: "finding-1",
              interactionRunId: "run-1",
            },
          ],
          orderCalls.reviewFindings,
        ),
        discussionMappings: createSourceStore(
          [
            {
              id: "mapping-1",
              tenantId: "tenant-1",
              lastInteractionRunId: "run-1",
            },
          ],
          orderCalls.discussionMappings,
        ),
      },
    });
    const targetRuntime = createRuntime({
      providerId: "target",
      moduleSpecifier: "target-module",
      stores: {
        modelProfiles: createTargetStore(),
        platformConnections: createTargetStore(),
        tenants: createTargetStore(),
        interactionJobs: createTargetStore(),
        codeReviewSnapshots: createTargetStore(),
        interactionRuns: createTargetStore(),
        interactionRunMetrics: createTargetStore(),
        reviewFindings: createTargetStore(),
        discussionMappings: createTargetStore(),
      },
    });

    initializeStorageRuntime.mockImplementation(async ({ providerModule }) =>
      providerModule === "source-provider" ? sourceRuntime : targetRuntime,
    );

    const exitCode = await runCli([
      "storage",
      "migrate",
      "--from-storage-provider-module",
      "source-provider",
      "--to-storage-provider-module",
      "target-provider",
    ]);

    expect(exitCode).toBe(0);
    expect(orderCalls.modelProfiles).toEqual([
      [{ field: "name", direction: "asc" }],
      [{ field: "name", direction: "asc" }],
    ]);
    expect(orderCalls.tenants).toEqual([
      [{ field: "id", direction: "asc" }],
      [{ field: "id", direction: "asc" }],
    ]);
    expect(orderCalls.interactionJobs).toEqual([
      [{ field: "id", direction: "asc" }],
      [{ field: "id", direction: "asc" }],
    ]);
    expect(orderCalls.codeReviewSnapshots).toEqual([
      [{ field: "id", direction: "asc" }],
      [{ field: "id", direction: "asc" }],
    ]);
    expect(orderCalls.interactionRuns).toEqual([
      [{ field: "id", direction: "asc" }],
      [{ field: "id", direction: "asc" }],
    ]);
    expect(orderCalls.interactionRunMetrics).toEqual([
      [{ field: "id", direction: "asc" }],
      [{ field: "id", direction: "asc" }],
    ]);
    expect(orderCalls.reviewFindings).toEqual([
      [{ field: "id", direction: "asc" }],
      [{ field: "id", direction: "asc" }],
    ]);
    expect(orderCalls.discussionMappings).toEqual([
      [{ field: "id", direction: "asc" }],
      [{ field: "id", direction: "asc" }],
    ]);
  });
});

function createRuntime(input: {
  providerId: string;
  moduleSpecifier: string;
  stores: Record<string, unknown>;
}) {
  return {
    provider: {
      getProviderId: () => input.providerId,
      close: async () => {},
    },
    moduleSpecifier: input.moduleSpecifier,
    storage: {
      stores: input.stores,
    },
  };
}

function createSourceStore<TEntity>(
  entities: TEntity[],
  orderCalls: unknown[],
) {
  return {
    async list(input: { page: number; pageSize: number; order?: unknown }) {
      orderCalls.push(input.order ?? null);
      const start = (input.page - 1) * input.pageSize;
      return entities.slice(start, start + input.pageSize);
    },
  };
}

function createTargetStore() {
  return {
    async upsertMany<TEntity>(entities: TEntity[]) {
      return entities;
    },
  };
}
