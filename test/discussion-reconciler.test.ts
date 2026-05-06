import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { GitLabApiError } from "../src/gitlab/client.js";
import type { HydratedMergeRequestContext } from "../src/gitlab/types.js";
import { createLogger } from "../src/logger.js";
import {
  buildProviderThreads,
  DiscussionReconciler,
} from "../src/reconcile/discussion-reconciler.js";
import { REVIEW_SUMMARY_NOTE_MARKER } from "../src/review/summary.js";
import { createFindingIdentityKey } from "../src/utils/ids.js";

describe("Discussion reconciler", () => {
  const logger = createLogger("silent");
  const tenant = {
    id: "tenant_1",
    key: "https://gitlab.example.com::123",
    baseUrl: "https://gitlab.example.com",
    projectId: 123,
    apiToken: "token",
    webhookSecret: "secret",
    botUserId: 999,
    botUsername: "review-bot",
    modelProfileName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("updates a bot-owned thread when the model revises the finding after a human reply", async () => {
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({
        id: "map_1",
        ...input,
      })),
      updateReviewFindingStatus: vi.fn(async () => true),
      listLatestReviewFindings: vi.fn(async () => []),
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger,
    });

    const replyToDiscussion = vi.fn();
    const createMergeRequestNote = vi.fn(
      async (_projectId: number, _mergeRequestIid: number, body: string) => ({
        id: 90,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );
    const updateMergeRequestNote = vi.fn();
    const updateDiscussionNote = vi.fn(async () => ({
      id: 10,
      body: "**Old finding**\n\nUpdated body",
      author: { id: 999, username: "review-bot", name: "Review Bot" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      system: false,
      resolved: false,
    }));

    const context = createHydratedContext();
    const mappings = [
      {
        id: "map_1",
        tenantId: tenant.id,
        projectId: tenant.projectId,
        mergeRequestIid: 7,
        identityKey: "identity",
        findingFingerprint: "old",
        title: "Old finding",
        severity: "medium",
        category: "bug",
        body: "**Old finding**\n\nOld body",
        gitlabDiscussionId: "disc_1",
        gitlabNoteId: 10,
        anchorJson: null,
        positionJson: null,
        botDiscussion: true,
        botNote: true,
        noteAuthorId: 999,
        noteAuthorUsername: "review-bot",
        status: "open" as const,
        lastInteractionRunId: "run_old",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const summary = await reconciler.reconcile({
      tenant,
      context,
      mappings,
      interactionRunId: "run_1",
      reviewResult: {
        overview: {
          summary: "Found one issue",
          overallSeverity: "medium",
        },
        findings: [
          {
            priorThreadId: "map_1",
            title: "Old finding",
            body: "Updated body",
            severity: "medium",
            category: "bug",
          },
        ],
        priorDispositions: [],
      },
      client: {
        createMergeRequestNote,
        replyToDiscussion,
        updateMergeRequestNote,
        updateDiscussionNote,
        createMergeRequestDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(),
      } as never,
    });

    expect(summary.updated).toBe(1);
    expect(summary.summaryNoteAction).toBe("created");
    expect(replyToDiscussion).not.toHaveBeenCalled();
    expect(updateDiscussionNote).toHaveBeenCalledTimes(1);
    expect(createMergeRequestNote).toHaveBeenCalledTimes(1);
    expect(createMergeRequestNote.mock.calls[0]?.[2]).toContain(
      REVIEW_SUMMARY_NOTE_MARKER,
    );
    expect(createMergeRequestNote.mock.calls[0]?.[2]).toContain(
      "### Overall assessment",
    );
    expect(createMergeRequestNote.mock.calls[0]?.[2]).toContain(
      "\n\nFound one issue\n\n### Merge readiness",
    );
    expect(createMergeRequestNote.mock.calls[0]?.[2]).toContain(
      "- **Status:** Needs attention",
    );
    expect(createMergeRequestNote.mock.calls[0]?.[2]).toContain(
      "- **Confidence:** Medium",
    );
    expect(createMergeRequestNote.mock.calls[0]?.[2]).toContain(
      "<details><summary>Suggested fixes prompt</summary>",
    );
    expect(createMergeRequestNote.mock.calls[0]?.[2]).toContain(
      "\n\n```md\nReview and fix the issues called out for merge request",
    );
    expect(createMergeRequestNote.mock.calls[0]?.[2]).toContain(
      "Findings to address (highest severity first):",
    );
    expect(createMergeRequestNote.mock.calls[0]?.[2]).toContain(
      "\n```\n\n</details>",
    );
    expect(storage.upsertDiscussionMapping).toHaveBeenCalledTimes(1);
    expect(
      createMergeRequestNote.mock.invocationCallOrder[0] ?? 0,
    ).toBeLessThan(
      updateDiscussionNote.mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );
  });

  it("replies in a bot-owned thread when the disposition explicitly asks for a reply", async () => {
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({
        id: "map_1",
        ...input,
      })),
      updateReviewFindingStatus: vi.fn(async () => true),
      listLatestReviewFindings: vi.fn(async () => []),
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger,
    });

    const replyToDiscussion = vi.fn(async () => ({
      id: 12,
      body: "Thanks, I reworded it.",
      author: { id: 999, username: "review-bot", name: "Review Bot" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      system: false,
      resolved: false,
    }));
    const createMergeRequestNote = vi.fn(
      async (_projectId: number, _mergeRequestIid: number, body: string) => ({
        id: 91,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );
    const updateMergeRequestNote = vi.fn();
    const updateDiscussionNote = vi.fn();

    const context = createHydratedContext();
    const mappings = [
      {
        id: "map_1",
        tenantId: tenant.id,
        projectId: tenant.projectId,
        mergeRequestIid: 7,
        identityKey: "identity",
        findingFingerprint: "old",
        title: "Old finding",
        severity: "medium",
        category: "bug",
        body: "**Old finding**\n\nOld body",
        gitlabDiscussionId: "disc_1",
        gitlabNoteId: 10,
        anchorJson: null,
        positionJson: null,
        botDiscussion: true,
        botNote: true,
        noteAuthorId: 999,
        noteAuthorUsername: "review-bot",
        status: "open" as const,
        lastInteractionRunId: "run_old",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const summary = await reconciler.reconcile({
      tenant,
      context,
      mappings,
      interactionRunId: "run_1",
      reviewResult: {
        overview: {
          summary: "Handled follow-up",
          overallSeverity: "medium",
        },
        findings: [],
        priorDispositions: [
          {
            threadId: "map_1",
            action: "reply",
            replyBody: "Thanks, I reworded it.",
          },
        ],
      },
      client: {
        createMergeRequestNote,
        replyToDiscussion,
        updateMergeRequestNote,
        updateDiscussionNote,
        createMergeRequestDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(),
      } as never,
    });

    expect(summary.replied).toBe(1);
    expect(summary.summaryNoteAction).toBe("created");
    expect(createMergeRequestNote).toHaveBeenCalledTimes(1);
    expect(replyToDiscussion).toHaveBeenCalledTimes(1);
    expect(updateDiscussionNote).not.toHaveBeenCalled();
  });

  it("retires the previous finding identity when a reused thread is replaced with a new finding", async () => {
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({
        id: "map_1",
        ...input,
      })),
      updateReviewFindingStatus: vi.fn(async () => true),
      listLatestReviewFindings: vi.fn(async () => []),
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger,
    });

    const updateDiscussionNote = vi.fn(async () => ({
      id: 10,
      body: "**Replacement finding**\n\nNew body",
      author: { id: 999, username: "review-bot", name: "Review Bot" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      system: false,
      resolved: false,
    }));
    const createMergeRequestNote = vi.fn(
      async (_projectId: number, _mergeRequestIid: number, body: string) => ({
        id: 92,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );

    const context = createHydratedContext();
    const mappings = [
      {
        id: "map_1",
        tenantId: tenant.id,
        projectId: tenant.projectId,
        mergeRequestIid: 7,
        identityKey: "identity_old",
        findingFingerprint: "old",
        title: "Old finding",
        severity: "medium",
        category: "bug",
        body: "**Old finding**\n\nOld body",
        gitlabDiscussionId: "disc_1",
        gitlabNoteId: 10,
        anchorJson: null,
        positionJson: null,
        botDiscussion: true,
        botNote: true,
        noteAuthorId: 999,
        noteAuthorUsername: "review-bot",
        status: "open" as const,
        lastInteractionRunId: "run_old",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const nextIdentityKey = createFindingIdentityKey({
      title: "Replacement finding",
      category: "bug",
    });

    await reconciler.reconcile({
      tenant,
      context,
      mappings,
      interactionRunId: "run_1",
      reviewResult: {
        overview: {
          summary: "Found one replacement issue",
          overallSeverity: "medium",
        },
        findings: [
          {
            priorThreadId: "map_1",
            title: "Replacement finding",
            body: "New body",
            severity: "medium",
            category: "bug",
          },
        ],
        priorDispositions: [],
      },
      client: {
        createMergeRequestNote,
        replyToDiscussion: vi.fn(),
        updateMergeRequestNote: vi.fn(),
        updateDiscussionNote,
        createMergeRequestDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(),
      } as never,
    });

    expect(storage.upsertDiscussionMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        identityKey: nextIdentityKey,
        gitlabDiscussionId: "disc_1",
      }),
    );
    expect(storage.updateReviewFindingStatus).toHaveBeenNthCalledWith(
      1,
      tenant.id,
      7,
      nextIdentityKey,
      "open",
    );
    expect(storage.updateReviewFindingStatus).toHaveBeenNthCalledWith(
      2,
      tenant.id,
      7,
      "identity_old",
      "resolved",
    );
  });

  it("builds the summary after replacement retirement so stale findings are excluded", async () => {
    const persistedStatuses = new Map<string, "open" | "resolved">([
      ["identity_old", "open"],
      ["identity_new", "open"],
    ]);
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({
        id: "map_1",
        ...input,
      })),
      updateReviewFindingStatus: vi.fn(
        async (_tenantId, _mergeRequestIid, identityKey: string, status) => {
          persistedStatuses.set(identityKey, status);
          return true;
        },
      ),
      listLatestReviewFindings: vi.fn(async () =>
        [
          {
            findingId: "finding_old",
            identityKey: "identity_old",
            status: persistedStatuses.get("identity_old") ?? "open",
            title: "Old finding",
            body: "Old body",
            severity: "medium",
            category: "bug",
            anchor: null,
            suggestion: null,
            interactionRunId: "run_prev",
            reviewedAt: new Date().toISOString(),
            headSha: "head-prev",
          },
          {
            findingId: "finding_new",
            identityKey: "identity_new",
            status: persistedStatuses.get("identity_new") ?? "open",
            title: "Replacement finding",
            body: "New body",
            severity: "medium",
            category: "bug",
            anchor: null,
            suggestion: null,
            interactionRunId: "run_1",
            reviewedAt: new Date().toISOString(),
            headSha: "head-new",
          },
        ].filter((finding) => finding.status === "open"),
      ),
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger,
    });

    const updateDiscussionNote = vi.fn(async () => ({
      id: 10,
      body: "**Replacement finding**\n\nNew body",
      author: { id: 999, username: "review-bot", name: "Review Bot" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      system: false,
      resolved: false,
    }));
    const createMergeRequestNote = vi.fn(
      async (_projectId: number, _mergeRequestIid: number, body: string) => ({
        id: 94,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );

    await reconciler.reconcile({
      tenant,
      context: createHydratedContext(),
      mappings: [
        {
          id: "map_1",
          tenantId: tenant.id,
          projectId: tenant.projectId,
          mergeRequestIid: 7,
          identityKey: "identity_old",
          findingFingerprint: "old",
          title: "Old finding",
          severity: "medium",
          category: "bug",
          body: "**Old finding**\n\nOld body",
          gitlabDiscussionId: "disc_1",
          gitlabNoteId: 10,
          anchorJson: null,
          positionJson: null,
          botDiscussion: true,
          botNote: true,
          noteAuthorId: 999,
          noteAuthorUsername: "review-bot",
          status: "open" as const,
          lastInteractionRunId: "run_old",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      interactionRunId: "run_1",
      reviewResult: {
        overview: {
          summary: "Found one replacement issue",
          overallSeverity: "medium",
        },
        findings: [
          {
            priorThreadId: "map_1",
            title: "Replacement finding",
            body: "New body",
            severity: "medium",
            category: "bug",
          },
        ],
        priorDispositions: [],
      },
      client: {
        createMergeRequestNote,
        replyToDiscussion: vi.fn(),
        updateMergeRequestNote: vi.fn(),
        updateDiscussionNote,
        createMergeRequestDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(),
      } as never,
    });

    expect(createMergeRequestNote).toHaveBeenCalledOnce();
    expect(createMergeRequestNote.mock.calls[0]?.[2]).toContain(
      "Replacement finding",
    );
    expect(createMergeRequestNote.mock.calls[0]?.[2]).not.toContain(
      "Old finding",
    );
  });

  it("persists dismissed status when a prior thread is resolved as not applicable", async () => {
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({
        id: "map_1",
        ...input,
      })),
      updateReviewFindingStatus: vi.fn(async () => true),
      listLatestReviewFindings: vi.fn(async () => [
        {
          findingId: "finding_open",
          identityKey: "identity_open",
          status: "open" as const,
          title: "Remaining storage correctness fix",
          body: "This still needs to be addressed.",
          severity: "medium",
          category: "correctness",
          anchor: null,
          suggestion: null,
          interactionRunId: "run_prev",
          reviewedAt: new Date().toISOString(),
          headSha: "head-prev",
        },
      ]),
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger,
    });

    const resolveDiscussion = vi.fn(async () => undefined);
    const createMergeRequestNote = vi.fn(
      async (_projectId: number, _mergeRequestIid: number, body: string) => ({
        id: 93,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );

    await reconciler.reconcile({
      tenant,
      context: createHydratedContext(),
      mappings: [
        {
          id: "map_1",
          tenantId: tenant.id,
          projectId: tenant.projectId,
          mergeRequestIid: 7,
          identityKey: "identity",
          findingFingerprint: "old",
          title: "Old finding",
          severity: "medium",
          category: "bug",
          body: "**Old finding**\n\nOld body",
          gitlabDiscussionId: "disc_1",
          gitlabNoteId: 10,
          anchorJson: null,
          positionJson: null,
          botDiscussion: true,
          botNote: true,
          noteAuthorId: 999,
          noteAuthorUsername: "review-bot",
          status: "open" as const,
          lastInteractionRunId: "run_old",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      interactionRunId: "run_1",
      reviewResult: {
        overview: {
          summary: "Handled follow-up",
          overallSeverity: "low",
        },
        findings: [],
        priorDispositions: [
          {
            threadId: "map_1",
            action: "resolve",
            resolution: "dismissed",
          },
        ],
      },
      client: {
        createMergeRequestNote,
        updateMergeRequestNote: vi.fn(),
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        createMergeRequestDiscussion: vi.fn(),
        resolveDiscussion,
      } as never,
    });

    expect(resolveDiscussion).toHaveBeenCalledTimes(1);
    expect(storage.updateReviewFindingStatus).toHaveBeenCalledWith(
      tenant.id,
      7,
      "identity",
      "dismissed",
    );
    expect(createMergeRequestNote.mock.calls[0]?.[2]).toContain(
      "Remaining storage correctness fix",
    );
  });

  it("excludes persisted findings that the current review resolved from the summary note", async () => {
    const persistedStatuses = new Map<string, "open" | "resolved">([
      ["identity", "open"],
      ["identity_open", "open"],
    ]);
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({
        id: "map_1",
        ...input,
      })),
      updateReviewFindingStatus: vi.fn(
        async (_tenantId, _mergeRequestIid, identityKey: string, status) => {
          persistedStatuses.set(identityKey, status);
          return true;
        },
      ),
      listLatestReviewFindings: vi.fn(async () =>
        [
          {
            findingId: "finding_resolved",
            identityKey: "identity",
            status: persistedStatuses.get("identity") ?? "open",
            title: "Resolved storage correctness fix",
            body: "This thread was resolved in the current rerun.",
            severity: "medium",
            category: "correctness",
            anchor: null,
            suggestion: null,
            interactionRunId: "run_prev",
            reviewedAt: new Date().toISOString(),
            headSha: "head-prev",
          },
          {
            findingId: "finding_open",
            identityKey: "identity_open",
            status: persistedStatuses.get("identity_open") ?? "open",
            title: "Remaining storage correctness fix",
            body: "This still needs to be addressed.",
            severity: "medium",
            category: "correctness",
            anchor: null,
            suggestion: null,
            interactionRunId: "run_prev",
            reviewedAt: new Date().toISOString(),
            headSha: "head-prev",
          },
        ].filter((finding) => finding.status === "open"),
      ),
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger,
    });

    const createMergeRequestNote = vi.fn(
      async (_projectId: number, _mergeRequestIid: number, body: string) => ({
        id: 94,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );

    await reconciler.reconcile({
      tenant,
      context: createHydratedContext(),
      mappings: [
        {
          id: "map_1",
          tenantId: tenant.id,
          projectId: tenant.projectId,
          mergeRequestIid: 7,
          identityKey: "identity",
          findingFingerprint: "old",
          title: "Old finding",
          severity: "medium",
          category: "bug",
          body: "**Old finding**\n\nOld body",
          gitlabDiscussionId: "disc_1",
          gitlabNoteId: 10,
          anchorJson: null,
          positionJson: null,
          botDiscussion: true,
          botNote: true,
          noteAuthorId: 999,
          noteAuthorUsername: "review-bot",
          status: "open" as const,
          lastInteractionRunId: "run_old",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      interactionRunId: "run_1",
      reviewResult: {
        overview: {
          summary: "The targeted rerun looks good.",
          overallAssessment: "The targeted rerun looks good.",
          overallSeverity: "low",
          mergeReadiness: {
            status: "ready",
            confidence: "high",
            summary: "No blocking issues were found in this rerun.",
          },
        },
        findings: [],
        priorDispositions: [
          {
            threadId: "map_1",
            action: "resolve",
            resolution: "resolved",
          },
        ],
      },
      client: {
        createMergeRequestNote,
        updateMergeRequestNote: vi.fn(),
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        createMergeRequestDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(async () => undefined),
      } as never,
    });

    expect(createMergeRequestNote).toHaveBeenCalledTimes(1);
    expect(createMergeRequestNote.mock.calls[0]?.[2]).toContain(
      "- **Findings snapshot:** 1 finding (1 medium)",
    );
    expect(createMergeRequestNote.mock.calls[0]?.[2]).toContain(
      "Remaining storage correctness fix",
    );
    expect(createMergeRequestNote.mock.calls[0]?.[2]).not.toContain(
      "Resolved storage correctness fix",
    );
  });

  it("replies instead of updating when the prior bot-owned thread is already resolved", async () => {
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({
        id: "map_1",
        ...input,
      })),
      updateReviewFindingStatus: vi.fn(async () => true),
      listLatestReviewFindings: vi.fn(async () => []),
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger,
    });

    const replyToDiscussion = vi.fn(async () => ({
      id: 13,
      body: "**Old finding**\n\nUpdated after resolution",
      author: { id: 999, username: "review-bot", name: "Review Bot" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      system: false,
      resolved: true,
    }));
    const createMergeRequestNote = vi.fn(
      async (_projectId: number, _mergeRequestIid: number, body: string) => ({
        id: 92,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );
    const updateMergeRequestNote = vi.fn();
    const updateDiscussionNote = vi.fn();
    const resolveDiscussion = vi.fn(async () => undefined);
    const mappings = [
      {
        id: "map_1",
        tenantId: tenant.id,
        projectId: tenant.projectId,
        mergeRequestIid: 7,
        identityKey: "identity",
        findingFingerprint: "old",
        title: "Old finding",
        severity: "medium",
        category: "bug",
        body: "**Old finding**\n\nOld body",
        gitlabDiscussionId: "disc_1",
        gitlabNoteId: 10,
        anchorJson: null,
        positionJson: null,
        botDiscussion: true,
        botNote: true,
        noteAuthorId: 999,
        noteAuthorUsername: "review-bot",
        status: "resolved" as const,
        lastInteractionRunId: "run_old",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const summary = await reconciler.reconcile({
      tenant,
      context: createHydratedContext({
        discussions: [
          {
            id: "disc_1",
            individual_note: false,
            notes: [
              {
                id: 10,
                body: "**Old finding**\n\nOld body",
                author: { id: 999, username: "review-bot", name: "Review Bot" },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                system: false,
                resolved: true,
              },
            ],
          },
        ],
      }),
      mappings,
      interactionRunId: "run_1",
      reviewResult: {
        overview: {
          summary: "Handled resolved thread",
          overallSeverity: "medium",
        },
        findings: [
          {
            priorThreadId: "map_1",
            title: "Old finding",
            body: "Updated after resolution",
            severity: "medium",
            category: "bug",
          },
        ],
        priorDispositions: [],
      },
      client: {
        createMergeRequestNote,
        replyToDiscussion,
        updateMergeRequestNote,
        updateDiscussionNote,
        createMergeRequestDiscussion: vi.fn(),
        resolveDiscussion,
      } as never,
    });

    expect(summary.replied).toBe(1);
    expect(resolveDiscussion).toHaveBeenCalledWith(
      tenant.projectId,
      7,
      "disc_1",
      false,
    );
    expect(replyToDiscussion).toHaveBeenCalledTimes(1);
    expect(updateDiscussionNote).not.toHaveBeenCalled();
    expect(storage.upsertDiscussionMapping).toHaveBeenCalledWith(
      expect.objectContaining({ status: "open" }),
    );
  });

  it("updates the existing merge request review summary note instead of creating a new one", async () => {
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({
        id: "map_1",
        ...input,
      })),
      updateReviewFindingStatus: vi.fn(async () => true),
      listLatestReviewFindings: vi.fn(async () => []),
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger,
    });

    const createMergeRequestNote = vi.fn();
    const updateMergeRequestNote = vi.fn(
      async (
        _projectId: number,
        _mergeRequestIid: number,
        noteId: number,
        body: string,
      ) => ({
        id: noteId,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );

    const context = createHydratedContext({
      notes: [
        {
          id: 70,
          body: `${REVIEW_SUMMARY_NOTE_MARKER}\n\nOld summary`,
          author: { id: 999, username: "review-bot", name: "Review Bot" },
          created_at: new Date(Date.now() - 60_000).toISOString(),
          updated_at: new Date(Date.now() - 60_000).toISOString(),
          system: false,
        },
      ],
    });

    const summary = await reconciler.reconcile({
      tenant,
      context,
      mappings: [],
      interactionRunId: "run_1",
      reviewResult: {
        overview: {
          summary: "Looks good overall",
          overallSeverity: "low",
          mergeReadiness: {
            status: "ready",
            confidence: "high",
            summary: "No blocking issues were found.",
          },
          highlights: ["No actionable findings in touched code paths."],
        },
        findings: [],
        priorDispositions: [],
      },
      client: {
        createMergeRequestNote,
        updateMergeRequestNote,
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        createMergeRequestDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(),
      } as never,
    });

    expect(summary.summaryNoteAction).toBe("updated");
    expect(createMergeRequestNote).not.toHaveBeenCalled();
    expect(updateMergeRequestNote).toHaveBeenCalledTimes(1);
    expect(updateMergeRequestNote.mock.calls[0]?.[2]).toBe(70);
    expect(updateMergeRequestNote.mock.calls[0]?.[3]).toContain(
      "### Merge readiness",
    );
    expect(updateMergeRequestNote.mock.calls[0]?.[3]).toContain(
      "- **Status:** Ready",
    );
    expect(updateMergeRequestNote.mock.calls[0]?.[3]).toContain(
      "- **Confidence:** High",
    );
    expect(updateMergeRequestNote.mock.calls[0]?.[3]).toContain(
      "### Highlights",
    );
    expect(updateMergeRequestNote.mock.calls[0]?.[3]).not.toContain(
      "<details><summary>Suggested fixes prompt</summary>",
    );
  });

  it("keeps the summary note in needs-attention when persisted open findings remain", async () => {
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({
        id: "map_1",
        ...input,
      })),
      updateReviewFindingStatus: vi.fn(async () => true),
      listLatestReviewFindings: vi.fn(async () => [
        {
          findingId: "finding_open",
          identityKey: "identity_open",
          status: "open" as const,
          title: "Remaining storage correctness fix",
          body: "This still needs to be addressed.",
          severity: "medium",
          category: "correctness",
          anchor: null,
          suggestion: null,
          interactionRunId: "run_prev",
          reviewedAt: new Date().toISOString(),
          headSha: "head-prev",
        },
      ]),
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger,
    });

    const createMergeRequestNote = vi.fn();
    const updateMergeRequestNote = vi.fn(
      async (
        _projectId: number,
        _mergeRequestIid: number,
        noteId: number,
        body: string,
      ) => ({
        id: noteId,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );

    const context = createHydratedContext({
      notes: [
        {
          id: 71,
          body: `${REVIEW_SUMMARY_NOTE_MARKER}\n\nOld summary`,
          author: { id: 999, username: "review-bot", name: "Review Bot" },
          created_at: new Date(Date.now() - 60_000).toISOString(),
          updated_at: new Date(Date.now() - 60_000).toISOString(),
          system: false,
        },
      ],
    });

    const summary = await reconciler.reconcile({
      tenant,
      context,
      mappings: [],
      interactionRunId: "run_2",
      reviewResult: {
        overview: {
          summary: "The targeted rerun looks good.",
          overallAssessment: "The targeted rerun looks good.",
          overallSeverity: "low",
          mergeReadiness: {
            status: "ready",
            confidence: "high",
            summary: "No blocking issues were found in this rerun.",
          },
          highlights: ["The rerun resolved the directly requested thread."],
        },
        findings: [],
        priorDispositions: [],
      },
      client: {
        createMergeRequestNote,
        updateMergeRequestNote,
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        createMergeRequestDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(),
      } as never,
    });

    expect(summary.summaryNoteAction).toBe("updated");
    expect(createMergeRequestNote).not.toHaveBeenCalled();
    expect(updateMergeRequestNote).toHaveBeenCalledTimes(1);
    expect(updateMergeRequestNote.mock.calls[0]?.[2]).toBe(71);
    expect(updateMergeRequestNote.mock.calls[0]?.[3]).toContain(
      "- **Status:** Needs attention",
    );
    expect(updateMergeRequestNote.mock.calls[0]?.[3]).toContain(
      "- **Rationale:** Persisted open findings remain and should be reviewed before merge.",
    );
    expect(updateMergeRequestNote.mock.calls[0]?.[3]).toContain(
      "- **Overall severity:** Medium",
    );
    expect(updateMergeRequestNote.mock.calls[0]?.[3]).toContain(
      "Remaining storage correctness fix",
    );
    expect(updateMergeRequestNote.mock.calls[0]?.[3]).toContain(
      "<details><summary>Suggested fixes prompt</summary>",
    );
    expect(updateMergeRequestNote.mock.calls[0]?.[3]).not.toContain(
      "- **Status:** Ready",
    );
  });

  it("ignores stored mappings when the live root note is not bot-authored", () => {
    const threads = buildProviderThreads({
      tenant,
      discussions: [
        {
          id: "disc_human",
          individual_note: false,
          notes: [
            {
              id: 20,
              body: "Human thread",
              author: { id: 1, username: "dev", name: "Developer" },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              system: false,
            },
          ],
        },
      ],
      mappings: [
        {
          id: "map_human",
          tenantId: tenant.id,
          projectId: tenant.projectId,
          mergeRequestIid: 7,
          identityKey: "identity",
          findingFingerprint: "fingerprint",
          title: "Stored thread",
          severity: "medium",
          category: "bug",
          body: "Stored body",
          gitlabDiscussionId: "disc_human",
          gitlabNoteId: 20,
          anchorJson: null,
          positionJson: null,
          botDiscussion: true,
          botNote: true,
          noteAuthorId: 999,
          noteAuthorUsername: "review-bot",
          status: "open",
          lastInteractionRunId: "run_old",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    expect(threads).toEqual([]);
  });

  it("excludes review summary discussions from provider threads", () => {
    const threads = buildProviderThreads({
      tenant,
      discussions: [
        {
          id: "disc_finding",
          individual_note: false,
          notes: [
            {
              id: 10,
              body: "**Finding**\n\nOriginal wording",
              author: { id: 999, username: "review-bot", name: "Review Bot" },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              system: false,
            },
            {
              id: 11,
              body: "Please clarify this.",
              author: { id: 1, username: "dev", name: "Developer" },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              system: false,
            },
          ],
        },
        {
          id: "disc_summary",
          individual_note: false,
          notes: [
            {
              id: 20,
              body: `${REVIEW_SUMMARY_NOTE_MARKER}\n\n## Review summary`,
              author: { id: 999, username: "review-bot", name: "Review Bot" },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              system: false,
            },
            {
              id: 21,
              body: "Please rerun the review.",
              author: { id: 1, username: "dev", name: "Developer" },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              system: false,
            },
          ],
        },
      ],
      mappings: [
        {
          id: "map_summary",
          tenantId: tenant.id,
          projectId: tenant.projectId,
          mergeRequestIid: 7,
          identityKey: "summary",
          findingFingerprint: "summary",
          title: "Summary thread",
          severity: "low",
          category: "maintainability",
          body: `${REVIEW_SUMMARY_NOTE_MARKER}\n\n## Review summary`,
          gitlabDiscussionId: "disc_summary",
          gitlabNoteId: 20,
          anchorJson: null,
          positionJson: null,
          botDiscussion: true,
          botNote: true,
          noteAuthorId: 999,
          noteAuthorUsername: "review-bot",
          status: "open",
          lastInteractionRunId: "run_old",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      discussionId: "disc_finding",
      title: "Finding",
    });
    expect(threads[0]?.humanReplies).toEqual([
      {
        noteId: 11,
        authorUsername: "dev",
        body: "Please clarify this.",
      },
    ]);
  });

  it.each([
    {
      name: "legacy line_code validation errors",
      responseBody:
        '{"message":"400 Bad request - Note {:line_code=>[\\"can\'t be blank\\", \\"must be a valid line code\\"]}"}',
    },
    {
      name: "structured position validation errors",
      responseBody: '{"message":{"position":["is incomplete"]}}',
    },
    {
      name: "string position validation errors",
      responseBody: '{"message":"position is invalid"}',
    },
  ])("retries without a diff position for $name", async ({ responseBody }) => {
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({
        id: "map_new",
        ...input,
      })),
      updateReviewFindingStatus: vi.fn(async () => true),
      listLatestReviewFindings: vi.fn(async () => []),
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger,
    });

    const createMergeRequestNote = vi.fn(
      async (_projectId: number, _mergeRequestIid: number, body: string) => ({
        id: 90,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );
    const createMergeRequestDiscussion = vi
      .fn()
      .mockRejectedValueOnce(
        new GitLabApiError(
          "GitLab form request failed for POST /projects/123/merge_requests/7/discussions with 400",
          400,
          responseBody,
          "https://gitlab.example.com/api/v4/projects/123/merge_requests/7/discussions",
        ),
      )
      .mockResolvedValueOnce({
        id: "disc_new",
        individual_note: false,
        notes: [
          {
            id: 12,
            body: "**Broad finding**\n\nAnchor body",
            author: { id: 999, username: "review-bot", name: "Review Bot" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            system: false,
          },
        ],
      });

    const summary = await reconciler.reconcile({
      tenant,
      context: createHydratedContext({
        latestVersion: {
          id: 1,
          base_commit_sha: "base",
          start_commit_sha: "start",
          head_commit_sha: "head",
          created_at: new Date().toISOString(),
        },
        changes: [
          {
            old_path: "src/index.ts",
            new_path: "src/index.ts",
            diff: "@@ -11,3 +11,4 @@\n context line\n+added line\n trailing context\n",
            new_file: false,
            renamed_file: false,
            deleted_file: false,
          },
        ],
      }),
      mappings: [],
      interactionRunId: "run_1",
      reviewResult: {
        overview: {
          summary: "Found one issue",
          overallSeverity: "medium",
        },
        findings: [
          {
            title: "Broad finding",
            body: "Anchor body",
            severity: "medium",
            category: "bug",
            anchor: {
              path: "src/index.ts",
              oldPath: "src/index.ts",
              startLine: 11,
              endLine: 13,
              side: "new",
            },
          },
        ],
        priorDispositions: [],
      },
      client: {
        createMergeRequestNote,
        createMergeRequestDiscussion,
        updateMergeRequestNote: vi.fn(),
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        resolveDiscussion: vi.fn(),
      } as never,
    });

    expect(summary.created).toBe(1);
    expect(createMergeRequestDiscussion).toHaveBeenCalledTimes(2);
    expect(createMergeRequestDiscussion).toHaveBeenNthCalledWith(1, 123, 7, {
      body: "**Broad finding**\n\nAnchor body",
      position: {
        base_sha: "base",
        start_sha: "start",
        head_sha: "head",
        position_type: "text",
        old_path: "src/index.ts",
        new_path: "src/index.ts",
        new_line: 12,
      },
    });
    expect(createMergeRequestDiscussion).toHaveBeenNthCalledWith(2, 123, 7, {
      body: "**Broad finding**\n\nAnchor body",
    });
    expect(storage.upsertDiscussionMapping).toHaveBeenCalledTimes(1);
  });

  it("does not warn when a new open finding status cannot be updated yet", async () => {
    const warn = vi.fn();
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({
        id: "map_new",
        ...input,
      })),
      updateReviewFindingStatus: vi.fn(async () => false),
      listLatestReviewFindings: vi.fn(async () => []),
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger: { warn } as never,
    });

    const createMergeRequestNote = vi.fn(
      async (_projectId: number, _mergeRequestIid: number, body: string) => ({
        id: 90,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );
    const createMergeRequestDiscussion = vi.fn(async () => ({
      id: "disc_new",
      individual_note: false,
      notes: [
        {
          id: 12,
          body: "**New finding**\n\nAnchor body",
          author: { id: 999, username: "review-bot", name: "Review Bot" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          system: false,
        },
      ],
    }));

    await reconciler.reconcile({
      tenant,
      context: createHydratedContext({ discussions: [] }),
      mappings: [],
      interactionRunId: "run_1",
      reviewResult: {
        overview: {
          summary: "Found one issue",
          overallSeverity: "medium",
        },
        findings: [
          {
            title: "New finding",
            body: "Anchor body",
            severity: "medium",
            category: "bug",
          },
        ],
        priorDispositions: [],
      },
      client: {
        createMergeRequestNote,
        createMergeRequestDiscussion,
        updateMergeRequestNote: vi.fn(),
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        resolveDiscussion: vi.fn(),
      } as never,
    });

    expect(storage.updateReviewFindingStatus).toHaveBeenCalledWith(
      tenant.id,
      7,
      createFindingIdentityKey({
        title: "New finding",
        category: "bug",
        path: undefined,
        startLine: undefined,
        endLine: undefined,
        side: undefined,
      }),
      "open",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not retry unrelated 400 discussion failures as overview threads", async () => {
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({
        id: "map_new",
        ...input,
      })),
      updateReviewFindingStatus: vi.fn(async () => true),
      listLatestReviewFindings: vi.fn(async () => []),
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger,
    });

    const createMergeRequestDiscussion = vi
      .fn()
      .mockRejectedValueOnce(
        new GitLabApiError(
          "GitLab form request failed for POST /projects/123/merge_requests/7/discussions with 400",
          400,
          '{"message":{"body":["is too long (maximum is 100000 characters)"]}}',
          "https://gitlab.example.com/api/v4/projects/123/merge_requests/7/discussions",
        ),
      );

    await expect(
      reconciler.reconcile({
        tenant,
        context: createHydratedContext({
          latestVersion: {
            id: 1,
            base_commit_sha: "base",
            start_commit_sha: "start",
            head_commit_sha: "head",
            created_at: new Date().toISOString(),
          },
          changes: [
            {
              old_path: "src/index.ts",
              new_path: "src/index.ts",
              diff: "@@ -11,3 +11,4 @@\n context line\n+added line\n trailing context\n",
              new_file: false,
              renamed_file: false,
              deleted_file: false,
            },
          ],
        }),
        mappings: [],
        interactionRunId: "run_1",
        reviewResult: {
          overview: {
            summary: "Found one issue",
            overallSeverity: "medium",
          },
          findings: [
            {
              title: "Broad finding",
              body: "Anchor body",
              severity: "medium",
              category: "bug",
              anchor: {
                path: "src/index.ts",
                oldPath: "src/index.ts",
                startLine: 11,
                endLine: 13,
                side: "new",
              },
            },
          ],
          priorDispositions: [],
        },
        client: {
          createMergeRequestNote: vi.fn(),
          createMergeRequestDiscussion,
          updateMergeRequestNote: vi.fn(),
          replyToDiscussion: vi.fn(),
          updateDiscussionNote: vi.fn(),
          resolveDiscussion: vi.fn(),
        } as never,
      }),
    ).rejects.toBeInstanceOf(GitLabApiError);

    expect(createMergeRequestDiscussion).toHaveBeenCalledTimes(1);
    expect(storage.upsertDiscussionMapping).not.toHaveBeenCalled();
  });
});

function createHydratedContext(overrides?: {
  notes?: HydratedMergeRequestContext["notes"];
  changes?: HydratedMergeRequestContext["changes"];
  latestVersion?: HydratedMergeRequestContext["latestVersion"];
  discussions?: HydratedMergeRequestContext["discussions"];
}): HydratedMergeRequestContext {
  return {
    tenant: {
      id: "tenant_1",
      key: "https://gitlab.example.com::123",
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot",
      modelProfileName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    job: {
      id: "job_1",
      tenantId: "tenant_1",
      dedupeKey: "dedupe",
      projectId: 123,
      mergeRequestIid: 7,
      noteId: 55,
      headSha: "abc123",
      status: "in_progress",
      payloadJson: "{}",
      retryCount: 0,
      lastError: null,
      enqueuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
    },
    mergeRequest: {
      id: 1,
      iid: 7,
      project_id: 123,
      title: "Add worker",
      description: "Adds worker",
      web_url: "https://gitlab.example.com/group/project/-/merge_requests/7",
      source_branch: "feature",
      target_branch: "main",
      author: {
        id: 42,
        username: "developer",
        name: "Developer",
      },
    },
    versions: [],
    latestVersion: overrides?.latestVersion ?? null,
    changes: overrides?.changes ?? [],
    notes: overrides?.notes ?? [],
    discussions: overrides?.discussions ?? [
      {
        id: "disc_1",
        individual_note: false,
        notes: [
          {
            id: 10,
            body: "**Old finding**\n\nOld body",
            author: { id: 999, username: "review-bot", name: "Review Bot" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            system: false,
            resolved: false,
          },
          {
            id: 11,
            body: "Can you clarify this?",
            author: { id: 1, username: "dev", name: "Developer" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            system: false,
            resolved: false,
          },
        ],
      },
    ],
    workspace: {
      rootPath: join("tmp", "workspace"),
      cleanupRoot: join("tmp", "cleanup"),
      strategy: "archive",
      instructionFiles: [],
    },
    projectMemory: {
      enabled: true,
      page: null,
      entries: [],
    },
    snapshot: {
      id: "snapshot_1",
      interactionJobId: "job_1",
      tenantId: "tenant_1",
      mergeRequestIid: 7,
      headSha: "abc123",
      mergeRequestJson: "{}",
      versionsJson: "[]",
      changesJson: "[]",
      notesJson: "[]",
      discussionsJson: "[]",
      instructionsJson: "[]",
      projectMemoryJson: null,
      workspaceStrategy: "archive",
      createdAt: new Date().toISOString(),
    },
  };
}
