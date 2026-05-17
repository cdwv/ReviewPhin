import { describe, expect, it, vi } from "vitest";

import { StoreBackedStorage } from "../src/storage/storage-helpers.js";
import type {
  InteractionJobRecord,
  InteractionRunRecord,
  MergeRequestSnapshotRecord,
  ReviewFindingRecord,
  StorageStores,
  TenantRecord,
} from "../src/storage/contract/index.js";

describe("StoreBackedStorage Flotiq MR lookup regression", () => {
  it("uses tenant-scoped MR lookup when loading prior review data", async () => {
    const tenant: TenantRecord = {
      id: "tenant-1",
      key: "https://gitlab.example.com::123",
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot",
      modelProfileName: null,
      createdAt: "2026-05-08T12:00:00.000Z",
      updatedAt: "2026-05-08T12:00:00.000Z",
    };
    const interactionJobs: InteractionJobRecord[] = [
      {
        id: "job-previous",
        tenantId: tenant.id,
        dedupeKey: "previous",
        projectId: tenant.projectId,
        mergeRequestIid: 18,
        noteId: 1,
        headSha: "head-previous",
        status: "completed",
        payloadJson: "{}",
        retryCount: 0,
        lastError: null,
        enqueuedAt: "2026-05-08T09:00:00.000Z",
        startedAt: "2026-05-08T09:00:01.000Z",
        finishedAt: "2026-05-08T09:05:00.000Z",
      },
      {
        id: "job-current",
        tenantId: tenant.id,
        dedupeKey: "current",
        projectId: tenant.projectId,
        mergeRequestIid: 18,
        noteId: 2,
        headSha: "head-current",
        status: "completed",
        payloadJson: "{}",
        retryCount: 0,
        lastError: null,
        enqueuedAt: "2026-05-08T10:00:00.000Z",
        startedAt: "2026-05-08T10:00:01.000Z",
        finishedAt: "2026-05-08T10:05:00.000Z",
      },
      {
        id: "job-other-tenant",
        tenantId: "tenant-2",
        dedupeKey: "other-tenant",
        projectId: tenant.projectId,
        mergeRequestIid: 18,
        noteId: 3,
        headSha: "head-other",
        status: "completed",
        payloadJson: "{}",
        retryCount: 0,
        lastError: null,
        enqueuedAt: "2026-05-08T08:00:00.000Z",
        startedAt: "2026-05-08T08:00:01.000Z",
        finishedAt: "2026-05-08T08:05:00.000Z",
      },
    ];
    const interactionRuns: InteractionRunRecord[] = [
      {
        id: "run-previous",
        interactionJobId: "job-previous",
        tenantId: tenant.id,
        provider: "copilot-sdk",
        model: "gpt-5.4",
        modelProfileName: null,
        providerBaseUrl: null,
        providerType: null,
        textGenerationModel: null,
        status: "completed",
        resultJson: '{"summary":"previous"}',
        error: null,
        startedAt: "2026-05-08T09:00:02.000Z",
        finishedAt: "2026-05-08T09:05:00.000Z",
      },
      {
        id: "run-other-tenant",
        interactionJobId: "job-other-tenant",
        tenantId: "tenant-2",
        provider: "copilot-sdk",
        model: "gpt-5.4",
        modelProfileName: null,
        providerBaseUrl: null,
        providerType: null,
        textGenerationModel: null,
        status: "completed",
        resultJson: '{"summary":"other tenant"}',
        error: null,
        startedAt: "2026-05-08T11:00:02.000Z",
        finishedAt: "2026-05-08T11:05:00.000Z",
      },
    ];
    const snapshots: MergeRequestSnapshotRecord[] = [
      {
        id: "snapshot-previous",
        interactionJobId: "job-previous",
        tenantId: tenant.id,
        mergeRequestIid: 18,
        headSha: "head-previous",
        mergeRequestJson: "{}",
        versionsJson: "[]",
        changesJson: "[]",
        notesJson: "[]",
        discussionsJson: "[]",
        instructionsJson: "[]",
        projectMemoryJson: null,
        workspaceStrategy: "git",
        createdAt: "2026-05-08T09:00:03.000Z",
      },
      {
        id: "snapshot-other-tenant",
        interactionJobId: "job-other-tenant",
        tenantId: "tenant-2",
        mergeRequestIid: 18,
        headSha: "head-other",
        mergeRequestJson: "{}",
        versionsJson: "[]",
        changesJson: "[]",
        notesJson: "[]",
        discussionsJson: "[]",
        instructionsJson: "[]",
        projectMemoryJson: null,
        workspaceStrategy: "git",
        createdAt: "2026-05-08T11:00:03.000Z",
      },
    ];
    const findings: ReviewFindingRecord[] = [
      {
        id: "finding-previous",
        interactionRunId: "run-previous",
        identityKey: "identity-1",
        severity: "medium",
        category: "correctness",
        title: "Persisted finding",
        body: "This should be reused",
        anchorJson: null,
        suggestionJson: null,
        status: "open",
        createdAt: "2026-05-08T09:05:00.000Z",
      },
    ];

    const interactionJobList = vi.fn(
      async (input?: { filters?: Record<string, unknown> }) => {
        const filters = input?.filters as
          | {
              tenantId?: { eq?: string };
              projectId?: { eq?: number };
              mergeRequestIid?: { eq?: number };
            }
          | undefined;

        return interactionJobs.filter(
          (job) =>
            (!filters?.tenantId || job.tenantId === filters.tenantId.eq) &&
            (!filters?.projectId || job.projectId === filters.projectId.eq) &&
            (!filters?.mergeRequestIid ||
              job.mergeRequestIid === filters.mergeRequestIid.eq),
        );
      },
    );

    const stores = {
      tenants: {
        get: vi.fn(async (id: string) => (id === tenant.id ? tenant : null)),
      },
      interactionJobs: {
        list: interactionJobList,
      },
      interactionRuns: {
        list: vi.fn(
          async (input?: {
            filters?: { interactionJobId?: { in?: readonly string[] } };
          }) =>
            interactionRuns.filter(
              (run) =>
                input?.filters?.interactionJobId?.in?.includes(
                  run.interactionJobId,
                ) ?? true,
            ),
        ),
      },
      mergeRequestSnapshots: {
        list: vi.fn(
          async (input?: {
            filters?: { interactionJobId?: { in?: readonly string[] } };
          }) =>
            snapshots.filter(
              (snapshot) =>
                input?.filters?.interactionJobId?.in?.includes(
                  snapshot.interactionJobId,
                ) ?? true,
            ),
        ),
      },
      reviewFindings: {
        list: vi.fn(
          async (input?: {
            filters?: { interactionRunId?: { in?: readonly string[] } };
          }) =>
            findings.filter(
              (finding) =>
                input?.filters?.interactionRunId?.in?.includes(
                  finding.interactionRunId,
                ) ?? true,
            ),
        ),
      },
    } as unknown as StorageStores;

    const storage = new StoreBackedStorage(stores);

    const previousInteraction =
      await storage.getLatestCompletedInteractionForMergeRequest(
        tenant.id,
        18,
        "job-current",
      );
    const priorFindings = await storage.listPriorReviewFindings(
      tenant.id,
      18,
      "job-current",
    );

    expect(previousInteraction).toMatchObject({
      interactionJobId: "job-previous",
      interactionRunId: "run-previous",
      headSha: "head-previous",
    });
    expect(priorFindings).toHaveLength(1);
    expect(priorFindings[0]).toMatchObject({
      interactionRunId: "run-previous",
      identityKey: "identity-1",
      headSha: "head-previous",
    });
    expect(interactionJobList).toHaveBeenCalled();
    for (const [input] of interactionJobList.mock.calls) {
      expect(input?.filters).toMatchObject({
        tenantId: { eq: tenant.id },
        mergeRequestIid: { eq: 18 },
      });
      expect(input?.filters).not.toHaveProperty("projectId");
    }
  });

  it("builds tenant deletion summaries from tenant-scoped interaction job lookup", async () => {
    const tenant: TenantRecord = {
      id: "tenant-1",
      key: "https://gitlab.example.com::123",
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot",
      modelProfileName: null,
      createdAt: "2026-05-08T12:00:00.000Z",
      updatedAt: "2026-05-08T12:00:00.000Z",
    };
    const interactionJobs: InteractionJobRecord[] = [
      {
        id: "job-tenant-1",
        tenantId: tenant.id,
        dedupeKey: "job-tenant-1",
        projectId: tenant.projectId,
        mergeRequestIid: 18,
        noteId: 1,
        headSha: "head-1",
        status: "completed",
        payloadJson: "{}",
        retryCount: 0,
        lastError: null,
        enqueuedAt: "2026-05-08T09:00:00.000Z",
        startedAt: "2026-05-08T09:00:01.000Z",
        finishedAt: "2026-05-08T09:05:00.000Z",
      },
      {
        id: "job-tenant-2",
        tenantId: "tenant-2",
        dedupeKey: "job-tenant-2",
        projectId: tenant.projectId,
        mergeRequestIid: 18,
        noteId: 2,
        headSha: "head-2",
        status: "completed",
        payloadJson: "{}",
        retryCount: 0,
        lastError: null,
        enqueuedAt: "2026-05-08T10:00:00.000Z",
        startedAt: "2026-05-08T10:00:01.000Z",
        finishedAt: "2026-05-08T10:05:00.000Z",
      },
    ];
    const interactionJobList = vi.fn(
      async (input?: { filters?: Record<string, unknown> }) => {
        const filters = input?.filters as
          | { tenantId?: { eq?: string } }
          | undefined;
        return interactionJobs.filter(
          (job) => !filters?.tenantId || job.tenantId === filters.tenantId.eq,
        );
      },
    );

    const stores = {
      tenants: {
        get: vi.fn(async (id: string) => (id === tenant.id ? tenant : null)),
        find: vi.fn(async () => tenant),
      },
      interactionJobs: {
        list: interactionJobList,
      },
      mergeRequestSnapshots: {
        list: vi.fn(async () => []),
      },
      interactionRuns: {
        list: vi.fn(async () => []),
      },
      discussionMappings: {
        list: vi.fn(async () => []),
      },
    } as unknown as StorageStores;

    const storage = new StoreBackedStorage(stores);

    const summary = await storage.getTenantDeletionSummary(
      tenant.baseUrl,
      tenant.projectId,
    );

    expect(summary).toMatchObject({
      interactionJobCount: 1,
      interactionRunCount: 0,
      mergeRequestSnapshotCount: 0,
      discussionMappingCount: 0,
      interactionJobIds: ["job-tenant-1"],
    });
    expect(interactionJobList).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: {
          tenantId: { eq: tenant.id },
        },
      }),
    );
  });
});
