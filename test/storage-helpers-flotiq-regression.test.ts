import { describe, expect, it, vi } from "vitest";

import { StoreBackedStorage } from "../src/storage/storage-helpers.js";
import type {
  InteractionJobRecord,
  InteractionRunRecord,
  CodeReviewSnapshotRecord,
  ReviewFindingRecord,
  StorageStores,
  TenantRecord,
} from "../src/storage/contract/index.js";
import { createGitLabTenantRecord } from "./helpers/gitlab-tenant.js";

describe("StoreBackedStorage Flotiq MR lookup regression", () => {
  it("uses tenant-scoped MR lookup when loading prior review data", async () => {
    const tenant: TenantRecord = createGitLabTenantRecord();
    const interactionJobs: InteractionJobRecord[] = [
      {
        id: "job-previous",
        tenantId: tenant.id,
        dedupeKey: "previous",
        codeReviewId: 18,
        commentId: 1,
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
        codeReviewId: 18,
        commentId: 2,
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
        codeReviewId: 18,
        commentId: 3,
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
    const snapshots: CodeReviewSnapshotRecord[] = [
      {
        id: "snapshot-previous",
        interactionJobId: "job-previous",
        tenantId: tenant.id,
        codeReviewId: 18,
        headSha: "head-previous",
        codeReviewJson: "{}",
        versionsJson: "[]",
        changesJson: "[]",
        commentsJson: "[]",
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
        codeReviewId: 18,
        headSha: "head-other",
        codeReviewJson: "{}",
        versionsJson: "[]",
        changesJson: "[]",
        commentsJson: "[]",
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
              codeReviewId?: { eq?: number };
            }
          | undefined;

        return interactionJobs.filter(
          (job) =>
            (!filters?.tenantId || job.tenantId === filters.tenantId.eq) &&
            (!filters?.codeReviewId ||
              job.codeReviewId === filters.codeReviewId.eq),
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
      codeReviewSnapshots: {
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
      await storage.getLatestCompletedInteractionForCodeReview(
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
        codeReviewId: { eq: 18 },
      });
      expect(input?.filters).not.toHaveProperty("repositoryId");
    }
  });

  it("builds tenant deletion summaries from tenant-scoped interaction job lookup", async () => {
    const tenant: TenantRecord = createGitLabTenantRecord();
    const interactionJobs: InteractionJobRecord[] = [
      {
        id: "job-tenant-1",
        tenantId: tenant.id,
        dedupeKey: "job-tenant-1",
        codeReviewId: 18,
        commentId: 1,
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
        codeReviewId: 18,
        commentId: 2,
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
      codeReviewSnapshots: {
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

    const summary = await storage.getTenantDeletionSummary(tenant.key);

    expect(summary).toMatchObject({
      interactionJobCount: 1,
      interactionRunCount: 0,
      codeReviewSnapshotCount: 0,
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
