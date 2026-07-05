import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { GitLabApiError } from "../src/platforms/gitlab/client.js";
import { getPlatformBySlug } from "../src/platforms/platform-registry.js";
import { GitLabReviewPublicationAdapter } from "../src/platforms/gitlab/review-publication-adapter.js";
import type { HydratedMergeRequestContext } from "../src/platforms/gitlab/types.js";
import { createLogger } from "../src/logger.js";
import {
  buildProviderDiscussions,
  DiscussionReconciler,
} from "../src/reconcile/discussion-reconciler.js";
import { REVIEW_SUMMARY_NOTE_MARKER } from "../src/review/summary.js";
import type { ReviewSummaryContext } from "../src/review/types.js";
import { createFindingIdentityKey } from "../src/utils/ids.js";

describe("Discussion reconciler", () => {
  const logger = createLogger("silent");
  const platform = getPlatformBySlug("gitlab");
  if (!platform) {
    throw new Error("GitLab platform is not registered");
  }
  const tenant = {
    id: "tenant_1",
    key: "https://gitlab.example.com::123",
    platform: "gitlab",
    platformConnectionId: "connection-1",
    platformConfigJson: JSON.stringify({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      apiToken: "token",
      webhookSecret: "secret",
      botUserId: 999,
      botUsername: "review-bot",
    }),
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

  const createDiscussionAdapter = (
    context: HydratedMergeRequestContext,
    client: Record<string, unknown>,
  ) =>
    new GitLabReviewPublicationAdapter({
      tenant,
      context,
      client: client as never,
      logger,
      interactionRunId: "test-run",
    });

  it("does not render suggestions in replies to file-level GitLab threads", async () => {
    const filePosition = {
      base_sha: "base",
      start_sha: "start",
      head_sha: "head",
      position_type: "file" as const,
      old_path: "src/index.ts",
      new_path: "src/index.ts",
    };
    const context = createHydratedContext({
      discussions: [
        {
          id: "disc_file",
          individual_note: false,
          notes: [
            {
              id: 10,
              body: "**Old finding**\n\nOld body",
              author: {
                id: 999,
                username: "review-bot",
                name: "Review Bot",
              },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              system: false,
              resolvable: true,
              resolved: false,
              position: filePosition,
            },
          ],
        },
      ],
    });
    const replyToDiscussion = vi.fn(
      async (
        _projectId: number,
        _codeReviewId: number,
        _discussionId: string,
        body: string,
      ) => ({
        id: 12,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
        resolvable: true,
        resolved: false,
        position: filePosition,
      }),
    );

    await createDiscussionAdapter(context, {
      replyToDiscussion,
    }).mutateDiscussion({
      kind: "reply-finding",
      discussionId: "disc_file",
      finding: {
        title: "Follow-up finding",
        body: "Use the safer value here.",
        severity: "medium",
        category: "bug",
        anchor: {
          path: "src/index.ts",
          oldPath: "src/index.ts",
          startLine: 12,
          endLine: 12,
          side: "new",
        },
        suggestion: {
          replacement: "return saferValue;",
          startLine: 12,
          endLine: 12,
        },
      },
    });

    expect(replyToDiscussion).toHaveBeenCalledWith(
      123,
      7,
      "disc_file",
      expect.not.stringContaining("```suggestion"),
    );
  });

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
    const createCodeReviewComment = vi.fn(
      async (_projectId: number, _codeReviewId: number, body: string) => ({
        id: 90,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );
    const updateCodeReviewComment = vi.fn();
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
        codeReviewId: 7,
        identityKey: "identity",
        findingFingerprint: "old",
        title: "Old finding",
        severity: "medium",
        category: "bug",
        body: "**Old finding**\n\nOld body",
        platformDiscussionId: "disc_1",
        platformCommentId: 10,
        anchorJson: null,
        positionJson: null,
        botDiscussion: true,
        botComment: true,
        commentAuthorId: 999,
        commentAuthorUsername: "review-bot",
        status: "open" as const,
        lastInteractionRunId: "run_old",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const summary = await reconciler.reconcile({
      platform,
      tenant,
      context,
      mappings,
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
      reviewResult: {
        overview: {
          summary: "Found one issue",
          overallSeverity: "medium",
        },
        findings: [
          {
            priorDiscussionId: "map_1",
            title: "Old finding",
            body: "Updated body",
            severity: "medium",
            category: "bug",
          },
        ],
        priorDispositions: [],
      },
      publicationAdapter: createDiscussionAdapter(createHydratedContext(), {
        createCodeReviewComment,
        replyToDiscussion,
        updateCodeReviewComment,
        updateDiscussionNote,
        createCodeReviewDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(),
      }),
    });

    expect(summary.updated).toBe(1);
    expect(summary.summaryCommentAction).toBe("created");
    expect(replyToDiscussion).not.toHaveBeenCalled();
    expect(updateDiscussionNote).toHaveBeenCalledTimes(1);
    expect(createCodeReviewComment).toHaveBeenCalledTimes(1);
    expect(createCodeReviewComment.mock.calls[0]?.[2]).toContain(
      REVIEW_SUMMARY_NOTE_MARKER,
    );
    expect(createCodeReviewComment.mock.calls[0]?.[2]).toContain(
      "### Overall assessment",
    );
    expect(createCodeReviewComment.mock.calls[0]?.[2]).toContain(
      "\n\nFound one issue\n\n### Merge readiness",
    );
    expect(createCodeReviewComment.mock.calls[0]?.[2]).toContain(
      "- **Status:** Needs attention",
    );
    expect(createCodeReviewComment.mock.calls[0]?.[2]).toContain(
      "- **Confidence:** Medium",
    );
    expect(createCodeReviewComment.mock.calls[0]?.[2]).toContain(
      "<details><summary>Suggested fixes prompt</summary>",
    );
    expect(createCodeReviewComment.mock.calls[0]?.[2]).toContain(
      "\n\n```md\nReview and fix the issues called out for code review",
    );
    expect(createCodeReviewComment.mock.calls[0]?.[2]).toContain(
      "Findings to address (highest severity first):",
    );
    expect(createCodeReviewComment.mock.calls[0]?.[2]).toContain(
      "\n```\n\n</details>",
    );
    expect(storage.upsertDiscussionMapping).toHaveBeenCalledTimes(1);
    expect(
      createCodeReviewComment.mock.invocationCallOrder[0] ?? 0,
    ).toBeGreaterThan(updateDiscussionNote.mock.invocationCallOrder[0] ?? 0);
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
    const createCodeReviewComment = vi.fn(
      async (_projectId: number, _codeReviewId: number, body: string) => ({
        id: 91,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );
    const updateCodeReviewComment = vi.fn();
    const updateDiscussionNote = vi.fn();

    const context = createHydratedContext();
    const mappings = [
      {
        id: "map_1",
        tenantId: tenant.id,
        codeReviewId: 7,
        identityKey: "identity",
        findingFingerprint: "old",
        title: "Old finding",
        severity: "medium",
        category: "bug",
        body: "**Old finding**\n\nOld body",
        platformDiscussionId: "disc_1",
        platformCommentId: 10,
        anchorJson: null,
        positionJson: null,
        botDiscussion: true,
        botComment: true,
        commentAuthorId: 999,
        commentAuthorUsername: "review-bot",
        status: "open" as const,
        lastInteractionRunId: "run_old",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const summary = await reconciler.reconcile({
      platform,
      tenant,
      context,
      mappings,
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
      reviewResult: {
        overview: {
          summary: "Handled follow-up",
          overallSeverity: "medium",
        },
        findings: [],
        priorDispositions: [
          {
            discussionId: "map_1",
            action: "reply",
            replyBody: "Thanks, I reworded it.",
          },
        ],
      },
      publicationAdapter: createDiscussionAdapter(createHydratedContext(), {
        createCodeReviewComment,
        replyToDiscussion,
        updateCodeReviewComment,
        updateDiscussionNote,
        createCodeReviewDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(),
      }),
    });

    expect(summary.replied).toBe(1);
    expect(summary.summaryCommentAction).toBe("created");
    expect(createCodeReviewComment).toHaveBeenCalledTimes(1);
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
    const createCodeReviewComment = vi.fn(
      async (_projectId: number, _codeReviewId: number, body: string) => ({
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
        codeReviewId: 7,
        identityKey: "identity_old",
        findingFingerprint: "old",
        title: "Old finding",
        severity: "medium",
        category: "bug",
        body: "**Old finding**\n\nOld body",
        platformDiscussionId: "disc_1",
        platformCommentId: 10,
        anchorJson: null,
        positionJson: null,
        botDiscussion: true,
        botComment: true,
        commentAuthorId: 999,
        commentAuthorUsername: "review-bot",
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
      platform,
      tenant,
      context,
      mappings,
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
      reviewResult: {
        overview: {
          summary: "Found one replacement issue",
          overallSeverity: "medium",
        },
        findings: [
          {
            priorDiscussionId: "map_1",
            title: "Replacement finding",
            body: "New body",
            severity: "medium",
            category: "bug",
          },
        ],
        priorDispositions: [],
      },
      publicationAdapter: createDiscussionAdapter(createHydratedContext(), {
        createCodeReviewComment,
        replyToDiscussion: vi.fn(),
        updateCodeReviewComment: vi.fn(),
        updateDiscussionNote,
        createCodeReviewDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(),
      }),
    });

    expect(storage.upsertDiscussionMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        identityKey: nextIdentityKey,
        platformDiscussionId: "disc_1",
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
        async (_tenantId, _codeReviewId, identityKey: string, status) => {
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
            interactionJobId: "job-publication",
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
            interactionJobId: "job-publication",
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
    const createCodeReviewComment = vi.fn(
      async (_projectId: number, _codeReviewId: number, body: string) => ({
        id: 94,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );

    const context = createHydratedContext();

    await reconciler.reconcile({
      platform,
      tenant,
      context,
      mappings: [
        {
          id: "map_1",
          tenantId: tenant.id,
          codeReviewId: 7,
          identityKey: "identity_old",
          findingFingerprint: "old",
          title: "Old finding",
          severity: "medium",
          category: "bug",
          body: "**Old finding**\n\nOld body",
          platformDiscussionId: "disc_1",
          platformCommentId: 10,
          anchorJson: null,
          positionJson: null,
          botDiscussion: true,
          botComment: true,
          commentAuthorId: 999,
          commentAuthorUsername: "review-bot",
          status: "open" as const,
          lastInteractionRunId: "run_old",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
      reviewResult: {
        overview: {
          summary: "Found one replacement issue",
          overallSeverity: "medium",
        },
        findings: [
          {
            priorDiscussionId: "map_1",
            title: "Replacement finding",
            body: "New body",
            severity: "medium",
            category: "bug",
          },
        ],
        priorDispositions: [],
      },
      publicationAdapter: createDiscussionAdapter(context, {
        createCodeReviewComment,
        replyToDiscussion: vi.fn(),
        updateCodeReviewComment: vi.fn(),
        updateDiscussionNote,
        createCodeReviewDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(),
      }),
    });

    expect(createCodeReviewComment).toHaveBeenCalledOnce();
    expect(createCodeReviewComment.mock.calls[0]?.[2]).toContain(
      "Replacement finding",
    );
    expect(createCodeReviewComment.mock.calls[0]?.[2]).not.toContain(
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
          interactionJobId: "job-publication",
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
    const createCodeReviewComment = vi.fn(
      async (_projectId: number, _codeReviewId: number, body: string) => ({
        id: 93,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );

    const context = createHydratedContext();

    await reconciler.reconcile({
      platform,
      tenant,
      context,
      mappings: [
        {
          id: "map_1",
          tenantId: tenant.id,
          codeReviewId: 7,
          identityKey: "identity",
          findingFingerprint: "old",
          title: "Old finding",
          severity: "medium",
          category: "bug",
          body: "**Old finding**\n\nOld body",
          platformDiscussionId: "disc_1",
          platformCommentId: 10,
          anchorJson: null,
          positionJson: null,
          botDiscussion: true,
          botComment: true,
          commentAuthorId: 999,
          commentAuthorUsername: "review-bot",
          status: "open" as const,
          lastInteractionRunId: "run_old",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
      reviewResult: {
        overview: {
          summary: "Handled follow-up",
          overallSeverity: "low",
        },
        findings: [],
        priorDispositions: [
          {
            discussionId: "map_1",
            action: "resolve",
            resolution: "dismissed",
          },
        ],
      },
      publicationAdapter: createDiscussionAdapter(context, {
        createCodeReviewComment,
        updateCodeReviewComment: vi.fn(),
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        createCodeReviewDiscussion: vi.fn(),
        resolveDiscussion,
      }),
    });

    expect(resolveDiscussion).toHaveBeenCalledTimes(1);
    expect(storage.updateReviewFindingStatus).toHaveBeenCalledWith(
      tenant.id,
      7,
      "identity",
      "dismissed",
    );
    expect(createCodeReviewComment.mock.calls[0]?.[2]).toContain(
      "Remaining storage correctness fix",
    );
  });

  it("excludes persisted findings that the current review resolved from the summary comment", async () => {
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
        async (_tenantId, _codeReviewId, identityKey: string, status) => {
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
            interactionJobId: "job-publication",
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
            interactionJobId: "job-publication",
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

    const createCodeReviewComment = vi.fn(
      async (_projectId: number, _codeReviewId: number, body: string) => ({
        id: 94,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );

    const context = createHydratedContext();

    await reconciler.reconcile({
      platform,
      tenant,
      context,
      mappings: [
        {
          id: "map_1",
          tenantId: tenant.id,
          codeReviewId: 7,
          identityKey: "identity",
          findingFingerprint: "old",
          title: "Old finding",
          severity: "medium",
          category: "bug",
          body: "**Old finding**\n\nOld body",
          platformDiscussionId: "disc_1",
          platformCommentId: 10,
          anchorJson: null,
          positionJson: null,
          botDiscussion: true,
          botComment: true,
          commentAuthorId: 999,
          commentAuthorUsername: "review-bot",
          status: "open" as const,
          lastInteractionRunId: "run_old",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
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
            discussionId: "map_1",
            action: "resolve",
            resolution: "resolved",
          },
        ],
      },
      publicationAdapter: createDiscussionAdapter(context, {
        createCodeReviewComment,
        updateCodeReviewComment: vi.fn(),
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        createCodeReviewDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(async () => undefined),
      }),
    });

    expect(createCodeReviewComment).toHaveBeenCalledTimes(1);

    expect(createCodeReviewComment.mock.calls[0]?.[2]).toContain(
      "Remaining storage correctness fix",
    );
    expect(createCodeReviewComment.mock.calls[0]?.[2]).not.toContain(
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
      resolvable: true,
      resolved: true,
    }));
    const createCodeReviewComment = vi.fn(
      async (_projectId: number, _codeReviewId: number, body: string) => ({
        id: 92,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );
    const updateCodeReviewComment = vi.fn();
    const updateDiscussionNote = vi.fn();
    const resolveDiscussion = vi.fn(async () => undefined);
    const mappings = [
      {
        id: "map_1",
        tenantId: tenant.id,
        codeReviewId: 7,
        identityKey: "identity",
        findingFingerprint: "old",
        title: "Old finding",
        severity: "medium",
        category: "bug",
        body: "**Old finding**\n\nOld body",
        platformDiscussionId: "disc_1",
        platformCommentId: 10,
        anchorJson: null,
        positionJson: null,
        botDiscussion: true,
        botComment: true,
        commentAuthorId: 999,
        commentAuthorUsername: "review-bot",
        status: "resolved" as const,
        lastInteractionRunId: "run_old",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const context = createHydratedContext({
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
              resolvable: true,
              resolved: true,
            },
          ],
        },
      ],
    });

    const summary = await reconciler.reconcile({
      platform,
      tenant,
      context,
      mappings,
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
      reviewResult: {
        overview: {
          summary: "Handled resolved thread",
          overallSeverity: "medium",
        },
        findings: [
          {
            priorDiscussionId: "map_1",
            title: "Old finding",
            body: "Updated after resolution",
            severity: "medium",
            category: "bug",
          },
        ],
        priorDispositions: [],
      },
      publicationAdapter: createDiscussionAdapter(context, {
        createCodeReviewComment,
        replyToDiscussion,
        updateCodeReviewComment,
        updateDiscussionNote,
        createCodeReviewDiscussion: vi.fn(),
        resolveDiscussion,
      }),
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

  it("skips resolving an unresolvable prior thread instead of calling GitLab", async () => {
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

    const resolveDiscussion = vi.fn(async () => undefined);
    const createCodeReviewComment = vi.fn(
      async (_projectId: number, _codeReviewId: number, body: string) => ({
        id: 93,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );

    const context = createHydratedContext({
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
              resolvable: false,
              resolved: false,
            },
          ],
        },
      ],
    });

    const summary = await reconciler.reconcile({
      platform,
      tenant,
      context,
      mappings: [
        {
          id: "map_1",
          tenantId: tenant.id,
          codeReviewId: 7,
          identityKey: "identity",
          findingFingerprint: "old",
          title: "Old finding",
          severity: "medium",
          category: "bug",
          body: "**Old finding**\n\nOld body",
          platformDiscussionId: "disc_1",
          platformCommentId: 10,
          anchorJson: null,
          positionJson: null,
          botDiscussion: true,
          botComment: true,
          commentAuthorId: 999,
          commentAuthorUsername: "review-bot",
          status: "open" as const,
          lastInteractionRunId: "run_old",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
      reviewResult: {
        overview: {
          summary: "Handled follow-up",
          overallSeverity: "low",
        },
        findings: [],
        priorDispositions: [
          {
            discussionId: "map_1",
            action: "resolve",
            resolution: "dismissed",
          },
        ],
      },
      publicationAdapter: createDiscussionAdapter(context, {
        createCodeReviewComment,
        updateCodeReviewComment: vi.fn(),
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        createCodeReviewDiscussion: vi.fn(),
        resolveDiscussion,
      }),
    });

    expect(summary.resolved).toBe(0);
    expect(summary.skippedResolution).toBe(1);
    expect(resolveDiscussion).not.toHaveBeenCalled();
    expect(storage.upsertDiscussionMapping).toHaveBeenCalledWith(
      expect.objectContaining({ status: "open" }),
    );
    expect(storage.updateReviewFindingStatus).toHaveBeenCalledWith(
      tenant.id,
      7,
      "identity",
      "dismissed",
    );
  });

  it("keeps store resolution while reporting skipped platform resolution mutations", async () => {
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
    const mutateDiscussion = vi.fn(async () => ({
      skipped: true,
      skipReason: "Resource not accessible by integration",
    }));

    const summary = await reconciler.reconcile({
      platform,
      tenant,
      context: createHydratedContext({ discussions: [] }),
      mappings: [
        {
          id: "map_1",
          tenantId: tenant.id,
          codeReviewId: 7,
          identityKey: "identity",
          findingFingerprint: "old",
          title: "Old finding",
          severity: "medium",
          category: "bug",
          body: "**Old finding**\n\nOld body",
          platformDiscussionId: "PRRT_1",
          platformCommentId: 10,
          anchorJson: null,
          positionJson: null,
          botDiscussion: true,
          botComment: true,
          commentAuthorId: 999,
          commentAuthorUsername: "review-bot",
          status: "open" as const,
          lastInteractionRunId: "run_old",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
      reviewResult: {
        overview: {
          summary: "Resolved in store",
          overallSeverity: "low",
        },
        findings: [],
        priorDispositions: [
          {
            discussionId: "map_1",
            action: "resolve",
            resolution: "resolved",
          },
        ],
      },
      publicationAdapter: {
        loadDiscussions: vi.fn(async () => [
          {
            id: "PRRT_1",
            resolvable: true,
            resolved: false,
            comments: [
              {
                id: "10",
                body: "**Old finding**\n\nOld body",
                authorId: "999",
                authorUsername: "review-bot",
                isBot: true,
                resolvable: true,
                resolved: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                anchor: null,
                positionJson: null,
                url: null,
              },
            ],
          },
        ]),
        mutateDiscussion,
        publishFindings: vi.fn(),
        upsertSummary: vi.fn(async ({ body }) => ({
          action: "updated" as const,
          url: null,
          comment: {
            id: "summary",
            body,
            isBot: true,
            updatedAt: new Date().toISOString(),
            url: null,
          },
        })),
      },
    });

    expect(mutateDiscussion).toHaveBeenCalledWith({
      kind: "set-resolved",
      discussionId: "PRRT_1",
      resolved: true,
    });
    expect(summary.resolved).toBe(0);
    expect(summary.skippedResolution).toBe(1);
    expect(storage.upsertDiscussionMapping).toHaveBeenCalledWith(
      expect.objectContaining({ status: "open" }),
    );
    expect(storage.updateReviewFindingStatus).toHaveBeenCalledWith(
      tenant.id,
      7,
      "identity",
      "resolved",
    );
  });

  it("replies without reopening when the resolved thread is not resolvable", async () => {
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
      resolvable: false,
      resolved: true,
    }));
    const createCodeReviewComment = vi.fn(
      async (_projectId: number, _codeReviewId: number, body: string) => ({
        id: 94,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );
    const resolveDiscussion = vi.fn(async () => undefined);
    const mappings = [
      {
        id: "map_1",
        tenantId: tenant.id,
        codeReviewId: 7,
        identityKey: "identity",
        findingFingerprint: "old",
        title: "Old finding",
        severity: "medium",
        category: "bug",
        body: "**Old finding**\n\nOld body",
        platformDiscussionId: "disc_1",
        platformCommentId: 10,
        anchorJson: null,
        positionJson: null,
        botDiscussion: true,
        botComment: true,
        commentAuthorId: 999,
        commentAuthorUsername: "review-bot",
        status: "resolved" as const,
        lastInteractionRunId: "run_old",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const context = createHydratedContext({
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
              resolvable: false,
              resolved: true,
            },
          ],
        },
      ],
    });

    const summary = await reconciler.reconcile({
      platform,
      tenant,
      context,
      mappings,
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
      reviewResult: {
        overview: {
          summary: "Handled resolved thread",
          overallSeverity: "medium",
        },
        findings: [
          {
            priorDiscussionId: "map_1",
            title: "Old finding",
            body: "Updated after resolution",
            severity: "medium",
            category: "bug",
          },
        ],
        priorDispositions: [],
      },
      publicationAdapter: createDiscussionAdapter(context, {
        createCodeReviewComment,
        replyToDiscussion,
        updateCodeReviewComment: vi.fn(),
        updateDiscussionNote: vi.fn(),
        createCodeReviewDiscussion: vi.fn(),
        resolveDiscussion,
      }),
    });

    expect(summary.replied).toBe(1);
    expect(resolveDiscussion).not.toHaveBeenCalled();
    expect(replyToDiscussion).toHaveBeenCalledTimes(1);
    expect(storage.upsertDiscussionMapping).toHaveBeenCalledWith(
      expect.objectContaining({ status: "resolved" }),
    );
    expect(storage.updateReviewFindingStatus).toHaveBeenNthCalledWith(
      1,
      tenant.id,
      7,
      createFindingIdentityKey({
        title: "Old finding",
        category: "bug",
      }),
      "open",
    );
    expect(storage.updateReviewFindingStatus).toHaveBeenNthCalledWith(
      2,
      tenant.id,
      7,
      "identity",
      "resolved",
    );
  });

  it("updates the existing merge request review summary comment instead of creating a new one", async () => {
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

    const createCodeReviewComment = vi.fn();
    const updateCodeReviewComment = vi.fn(
      async (
        _projectId: number,
        _codeReviewId: number,
        commentId: number,
        body: string,
      ) => ({
        id: commentId,
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
      platform,
      tenant,
      context,
      mappings: [],
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
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
      publicationAdapter: createDiscussionAdapter(context, {
        createCodeReviewComment,
        updateCodeReviewComment,
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        createCodeReviewDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(),
      }),
    });

    expect(summary.summaryCommentAction).toBe("updated");
    expect(createCodeReviewComment).not.toHaveBeenCalled();
    expect(updateCodeReviewComment).toHaveBeenCalledTimes(1);
    expect(updateCodeReviewComment.mock.calls[0]?.[2]).toBe(70);
    expect(updateCodeReviewComment.mock.calls[0]?.[3]).toContain(
      "### Merge readiness",
    );
    expect(updateCodeReviewComment.mock.calls[0]?.[3]).toContain(
      "- **Status:** Ready",
    );
    expect(updateCodeReviewComment.mock.calls[0]?.[3]).toContain(
      "- **Confidence:** High",
    );
    expect(updateCodeReviewComment.mock.calls[0]?.[3]).toContain(
      "### Highlights",
    );
    expect(updateCodeReviewComment.mock.calls[0]?.[3]).not.toContain(
      "<details><summary>Suggested fixes prompt</summary>",
    );
  });

  it("keeps the summary comment in needs-attention when persisted open findings remain", async () => {
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
          interactionJobId: "job-publication",
          reviewedAt: new Date().toISOString(),
          headSha: "head-prev",
        },
      ]),
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger,
    });

    const createCodeReviewComment = vi.fn();
    const updateCodeReviewComment = vi.fn(
      async (
        _projectId: number,
        _codeReviewId: number,
        commentId: number,
        body: string,
      ) => ({
        id: commentId,
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
      platform,
      tenant,
      context,
      mappings: [],
      interactionRunId: "run_2",
      interactionJobId: "job-publication",
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
      publicationAdapter: createDiscussionAdapter(context, {
        createCodeReviewComment,
        updateCodeReviewComment,
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        createCodeReviewDiscussion: vi.fn(),
        resolveDiscussion: vi.fn(),
      }),
    });

    expect(summary.summaryCommentAction).toBe("updated");
    expect(createCodeReviewComment).not.toHaveBeenCalled();
    expect(updateCodeReviewComment).toHaveBeenCalledTimes(1);
    expect(updateCodeReviewComment.mock.calls[0]?.[2]).toBe(71);
    expect(updateCodeReviewComment.mock.calls[0]?.[3]).toContain(
      "- **Status:** Needs attention",
    );
    expect(updateCodeReviewComment.mock.calls[0]?.[3]).toContain(
      "- **Rationale:** Persisted open findings remain and should be reviewed before merge.",
    );
    expect(updateCodeReviewComment.mock.calls[0]?.[3]).toContain(
      "- **Overall severity:** Medium",
    );
    expect(updateCodeReviewComment.mock.calls[0]?.[3]).toContain(
      "Remaining storage correctness fix",
    );
    expect(updateCodeReviewComment.mock.calls[0]?.[3]).toContain(
      "<details><summary>Suggested fixes prompt</summary>",
    );
    expect(updateCodeReviewComment.mock.calls[0]?.[3]).not.toContain(
      "- **Status:** Ready",
    );
  });

  it("ignores stored mappings when the live root note is not bot-authored", () => {
    const threads = buildProviderDiscussions({
      discussions: [
        {
          id: "disc_human",
          resolvable: false,
          resolved: false,
          comments: [
            {
              id: "20",
              body: "Human thread",
              authorId: "1",
              authorUsername: "dev",
              isBot: false,
              resolvable: false,
              resolved: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              anchor: null,
              positionJson: null,
              url: null,
            },
          ],
        },
      ],
      mappings: [
        {
          id: "map_human",
          tenantId: tenant.id,
          codeReviewId: 7,
          identityKey: "identity",
          findingFingerprint: "fingerprint",
          title: "Stored thread",
          severity: "medium",
          category: "bug",
          body: "Stored body",
          platformDiscussionId: "disc_human",
          platformCommentId: 20,
          anchorJson: null,
          positionJson: null,
          botDiscussion: true,
          botComment: true,
          commentAuthorId: 999,
          commentAuthorUsername: "review-bot",
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
    const threads = buildProviderDiscussions({
      discussions: [
        {
          id: "disc_finding",
          resolvable: true,
          resolved: false,
          comments: [
            {
              id: "10",
              body: "**Finding**\n\nOriginal wording",
              authorId: "999",
              authorUsername: "review-bot",
              isBot: true,
              resolvable: true,
              resolved: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              anchor: null,
              positionJson: null,
              url: null,
            },
            {
              id: "11",
              body: "Please clarify this.",
              authorId: "1",
              authorUsername: "dev",
              isBot: false,
              resolvable: true,
              resolved: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              anchor: null,
              positionJson: null,
              url: null,
            },
          ],
        },
        {
          id: "disc_summary",
          resolvable: true,
          resolved: false,
          comments: [
            {
              id: "20",
              body: `${REVIEW_SUMMARY_NOTE_MARKER}\n\n## Review summary`,
              authorId: "999",
              authorUsername: "review-bot",
              isBot: true,
              resolvable: true,
              resolved: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              anchor: null,
              positionJson: null,
              url: null,
            },
            {
              id: "21",
              body: "Please rerun the review.",
              authorId: "1",
              authorUsername: "dev",
              isBot: false,
              resolvable: true,
              resolved: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              anchor: null,
              positionJson: null,
              url: null,
            },
          ],
        },
      ],
      mappings: [
        {
          id: "map_summary",
          tenantId: tenant.id,
          codeReviewId: 7,
          identityKey: "summary",
          findingFingerprint: "summary",
          title: "Summary thread",
          severity: "low",
          category: "maintainability",
          body: `${REVIEW_SUMMARY_NOTE_MARKER}\n\n## Review summary`,
          platformDiscussionId: "disc_summary",
          platformCommentId: 20,
          anchorJson: null,
          positionJson: null,
          botDiscussion: true,
          botComment: true,
          commentAuthorId: 999,
          commentAuthorUsername: "review-bot",
          status: "open",
          lastInteractionRunId: "run_old",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      discussionId: "discussion:disc_finding",
      platformDiscussionId: "disc_finding",
      title: "Finding",
    });
    expect(threads[0]?.humanReplies).toEqual([
      {
        platformCommentId: 11,
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
  ])("retries with a file position for $name", async ({ responseBody }) => {
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

    const createCodeReviewComment = vi.fn(
      async (_projectId: number, _codeReviewId: number, body: string) => ({
        id: 90,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );
    const createCodeReviewDraftNote = vi
      .fn()
      .mockRejectedValueOnce(
        new GitLabApiError(
          "GitLab form request failed for POST /projects/123/merge_requests/7/draft_notes with 400",
          400,
          responseBody,
          "https://gitlab.example.com/api/v4/projects/123/merge_requests/7/draft_notes",
        ),
      )
      .mockResolvedValueOnce({
        id: 501,
        author_id: 999,
        merge_request_id: 7,
        resolve_discussion: false,
        discussion_id: null,
        note: "**Broad finding**\n\nAnchor body",
        position: null,
      });
    const bulkPublishCodeReviewDraftNotes = vi.fn(async () => undefined);
    const listCodeReviewDiscussions = vi.fn(async () => [
      {
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
            position: {
              base_sha: "base",
              start_sha: "start",
              head_sha: "head",
              position_type: "file",
              old_path: "src/index.ts",
              new_path: "src/index.ts",
            },
          },
        ],
      },
    ]);

    const context = createHydratedContext({
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
    });

    const summary = await reconciler.reconcile({
      platform,
      tenant,
      context,
      mappings: [],
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
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
            suggestion: {
              replacement: "const value = compute();",
              startLine: 11,
              endLine: 13,
            },
          },
        ],
        priorDispositions: [],
      },
      publicationAdapter: createDiscussionAdapter(context, {
        createCodeReviewComment,
        createCodeReviewDraftNote,
        bulkPublishCodeReviewDraftNotes,
        listCodeReviewDiscussions,
        deleteCodeReviewDraftNote: vi.fn(),
        updateCodeReviewComment: vi.fn(),
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        resolveDiscussion: vi.fn(),
      }),
    });

    expect(summary.created).toBe(1);
    expect(createCodeReviewDraftNote).toHaveBeenCalledTimes(2);
    expect(createCodeReviewDraftNote).toHaveBeenNthCalledWith(1, 123, 7, {
      note: expect.stringMatching(
        /^\*\*Broad finding\*\*\n\nAnchor body[\s\S]*\[comment\]: <> \(reviewphin-review-discussion:gitlab:job-publication:/,
      ),
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
    expect(createCodeReviewDraftNote.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        note: expect.stringContaining(
          "```suggestion:-1+1\nconst value = compute();\n```",
        ),
      }),
    );
    expect(createCodeReviewDraftNote).toHaveBeenNthCalledWith(2, 123, 7, {
      note: expect.stringMatching(
        /^\*\*Broad finding\*\*\n\nAnchor body[\s\S]*\[comment\]: <> \(reviewphin-review-discussion:gitlab:job-publication:/,
      ),
      position: {
        base_sha: "base",
        start_sha: "start",
        head_sha: "head",
        position_type: "file",
        old_path: "src/index.ts",
        new_path: "src/index.ts",
      },
    });
    expect(createCodeReviewDraftNote.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({
        note: expect.not.stringContaining("```suggestion"),
      }),
    );
    expect(bulkPublishCodeReviewDraftNotes).toHaveBeenCalledTimes(1);
    expect(listCodeReviewDiscussions).toHaveBeenCalledTimes(1);
    expect(listCodeReviewDiscussions).toHaveBeenCalledWith(123, 7, {
      noCache: true,
    });
    expect(storage.upsertDiscussionMapping).toHaveBeenCalledTimes(1);
  });

  it("uses a file position when the anchor file is known but no diff line matches", async () => {
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

    const createCodeReviewComment = vi.fn(
      async (_projectId: number, _codeReviewId: number, body: string) => ({
        id: 90,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );
    const createCodeReviewDraftNote = vi.fn(async () => ({
      id: 501,
      author_id: 999,
      merge_request_id: 7,
      resolve_discussion: false,
      discussion_id: null,
      note: "**Broad finding**\n\nAnchor body",
      position: {
        base_sha: "base",
        start_sha: "start",
        head_sha: "head",
        position_type: "file",
        old_path: "src/index.ts",
        new_path: "src/index.ts",
      },
    }));
    const bulkPublishCodeReviewDraftNotes = vi.fn(async () => undefined);
    const listCodeReviewDiscussions = vi.fn(async () => [
      {
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
            position: {
              base_sha: "base",
              start_sha: "start",
              head_sha: "head",
              position_type: "file",
              old_path: "src/index.ts",
              new_path: "src/index.ts",
            },
          },
        ],
      },
    ]);

    const context = createHydratedContext({
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
          diff: "@@ -30,2 +30,3 @@\n context line\n+added line\n trailing context\n",
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ],
    });

    await reconciler.reconcile({
      platform,
      tenant,
      context,
      mappings: [],
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
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
            suggestion: {
              replacement: "const value = compute();",
              startLine: 11,
              endLine: 13,
            },
          },
        ],
        priorDispositions: [],
      },
      publicationAdapter: createDiscussionAdapter(context, {
        createCodeReviewComment,
        createCodeReviewDraftNote,
        bulkPublishCodeReviewDraftNotes,
        listCodeReviewDiscussions,
        deleteCodeReviewDraftNote: vi.fn(),
        updateCodeReviewComment: vi.fn(),
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        resolveDiscussion: vi.fn(),
      }),
    });

    expect(createCodeReviewDraftNote).toHaveBeenCalledTimes(1);
    expect(createCodeReviewDraftNote).toHaveBeenCalledWith(123, 7, {
      note: expect.stringMatching(
        /^\*\*Broad finding\*\*\n\nAnchor body[\s\S]*\[comment\]: <> \(reviewphin-review-discussion:gitlab:job-publication:/,
      ),
      position: {
        base_sha: "base",
        start_sha: "start",
        head_sha: "head",
        position_type: "file",
        old_path: "src/index.ts",
        new_path: "src/index.ts",
      },
    });
    expect(createCodeReviewDraftNote).toHaveBeenCalledWith(
      123,
      7,
      expect.objectContaining({
        note: expect.not.stringContaining("```suggestion"),
      }),
    );
  });

  it("matches the newest published draft discussion when duplicate candidates exist", async () => {
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

    const now = new Date();
    const olderCreatedAt = new Date(now.getTime() - 60_000).toISOString();
    const newerCreatedAt = now.toISOString();
    const createCodeReviewDraftNote = vi.fn(async () => ({
      id: 601,
      author_id: 999,
      merge_request_id: 7,
      resolve_discussion: false,
      discussion_id: null,
      note: "**New finding**\n\nAnchor body",
      position: null,
    }));
    const bulkPublishCodeReviewDraftNotes = vi.fn(async () => undefined);
    const listCodeReviewDiscussions = vi.fn(async () => [
      {
        id: "disc_older",
        individual_note: false,
        notes: [
          {
            id: 11,
            body: "**New finding**\n\nAnchor body",
            author: { id: 999, username: "review-bot", name: "Review Bot" },
            created_at: olderCreatedAt,
            updated_at: olderCreatedAt,
            system: false,
          },
        ],
      },
      {
        id: "disc_newer",
        individual_note: false,
        notes: [
          {
            id: 12,
            body: "**New finding**\n\nAnchor body",
            author: { id: 999, username: "review-bot", name: "Review Bot" },
            created_at: newerCreatedAt,
            updated_at: newerCreatedAt,
            system: false,
          },
        ],
      },
    ]);

    const context = createHydratedContext({ discussions: [] });

    await reconciler.reconcile({
      platform,
      tenant,
      context,
      mappings: [],
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
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
      publicationAdapter: createDiscussionAdapter(context, {
        createCodeReviewComment: vi.fn(
          async (_projectId: number, _codeReviewId: number, body: string) => ({
            id: 99,
            body,
            author: { id: 999, username: "review-bot", name: "Review Bot" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            system: false,
          }),
        ),
        createCodeReviewDraftNote,
        bulkPublishCodeReviewDraftNotes,
        listCodeReviewDiscussions,
        deleteCodeReviewDraftNote: vi.fn(),
        updateCodeReviewComment: vi.fn(),
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        resolveDiscussion: vi.fn(),
      }),
    });

    expect(listCodeReviewDiscussions).toHaveBeenCalledWith(123, 7, {
      noCache: true,
    });
    expect(storage.upsertDiscussionMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        platformDiscussionId: "disc_newer",
        platformCommentId: 12,
      }),
    );
  });

  it("matches a published draft discussion by hidden marker before body fallback", async () => {
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

    let createdDraftBody = "";
    const createCodeReviewDraftNote = vi.fn(
      async (
        _projectId: number,
        _codeReviewId: number,
        input: { note: string },
      ) => {
        createdDraftBody = input.note;
        return {
          id: 601,
          author_id: 999,
          merge_request_id: 7,
          resolve_discussion: false,
          discussion_id: null,
          note: input.note,
          position: null,
        };
      },
    );
    const bulkPublishCodeReviewDraftNotes = vi.fn(async () => undefined);
    const newerCreatedAt = new Date().toISOString();
    const olderCreatedAt = new Date(Date.now() - 60_000).toISOString();
    const listCodeReviewDiscussions = vi.fn(async () => [
      {
        id: "disc_wrong",
        individual_note: false,
        notes: [
          {
            id: 11,
            body: "**New finding**\n\nAnchor body",
            author: { id: 999, username: "review-bot", name: "Review Bot" },
            created_at: newerCreatedAt,
            updated_at: newerCreatedAt,
            system: false,
          },
        ],
      },
      {
        id: "disc_marked",
        individual_note: false,
        notes: [
          {
            id: 12,
            body: createdDraftBody,
            author: { id: 999, username: "review-bot", name: "Review Bot" },
            created_at: olderCreatedAt,
            updated_at: olderCreatedAt,
            system: false,
          },
        ],
      },
    ]);

    const context = createHydratedContext({ discussions: [] });

    await reconciler.reconcile({
      platform,
      tenant,
      context,
      mappings: [],
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
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
      publicationAdapter: createDiscussionAdapter(context, {
        createCodeReviewComment: vi.fn(
          async (_projectId: number, _codeReviewId: number, body: string) => ({
            id: 99,
            body,
            author: { id: 999, username: "review-bot", name: "Review Bot" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            system: false,
          }),
        ),
        createCodeReviewDraftNote,
        bulkPublishCodeReviewDraftNotes,
        listCodeReviewDiscussions,
        deleteCodeReviewDraftNote: vi.fn(),
        updateCodeReviewComment: vi.fn(),
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        resolveDiscussion: vi.fn(),
      }),
    });

    expect(storage.upsertDiscussionMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        platformDiscussionId: "disc_marked",
        platformCommentId: 12,
        body: "**New finding**\n\nAnchor body",
      }),
    );
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

    const createCodeReviewComment = vi.fn(
      async (_projectId: number, _codeReviewId: number, body: string) => ({
        id: 90,
        body,
        author: { id: 999, username: "review-bot", name: "Review Bot" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        system: false,
      }),
    );
    const createCodeReviewDraftNote = vi.fn(async () => ({
      id: 601,
      author_id: 999,
      merge_request_id: 7,
      resolve_discussion: false,
      discussion_id: null,
      note: "**New finding**\n\nAnchor body",
      position: null,
    }));
    const bulkPublishCodeReviewDraftNotes = vi.fn(async () => undefined);
    const listCodeReviewDiscussions = vi.fn(async () => [
      {
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
      },
    ]);

    const context = createHydratedContext({ discussions: [] });

    await reconciler.reconcile({
      platform,
      tenant,
      context,
      mappings: [],
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
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
      publicationAdapter: createDiscussionAdapter(context, {
        createCodeReviewComment,
        createCodeReviewDraftNote,
        bulkPublishCodeReviewDraftNotes,
        listCodeReviewDiscussions,
        deleteCodeReviewDraftNote: vi.fn(),
        updateCodeReviewComment: vi.fn(),
        replyToDiscussion: vi.fn(),
        updateDiscussionNote: vi.fn(),
        resolveDiscussion: vi.fn(),
      }),
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

    const createCodeReviewDraftNote = vi
      .fn()
      .mockRejectedValueOnce(
        new GitLabApiError(
          "GitLab form request failed for POST /projects/123/merge_requests/7/draft_notes with 400",
          400,
          '{"message":{"body":["is too long (maximum is 100000 characters)"]}}',
          "https://gitlab.example.com/api/v4/projects/123/merge_requests/7/draft_notes",
        ),
      );

    const context = createHydratedContext({
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
    });

    await expect(
      reconciler.reconcile({
        platform,
        tenant,
        context,
        mappings: [],
        interactionRunId: "run_1",
        interactionJobId: "job-publication",
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
        publicationAdapter: createDiscussionAdapter(context, {
          createCodeReviewComment: vi.fn(
            async (
              _projectId: number,
              _codeReviewId: number,
              body: string,
            ) => ({
              id: 99,
              body,
              author: { id: 999, username: "review-bot", name: "Review Bot" },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              system: false,
            }),
          ),
          createCodeReviewDraftNote,
          bulkPublishCodeReviewDraftNotes: vi.fn(),
          listCodeReviewDiscussions: vi.fn(),
          deleteCodeReviewDraftNote: vi.fn(),
          updateCodeReviewComment: vi.fn(),
          replyToDiscussion: vi.fn(),
          updateDiscussionNote: vi.fn(),
          resolveDiscussion: vi.fn(),
        }),
      }),
    ).rejects.toBeInstanceOf(GitLabApiError);

    expect(createCodeReviewDraftNote).toHaveBeenCalledTimes(1);
    expect(storage.upsertDiscussionMapping).not.toHaveBeenCalled();
  });

  it("cleans up created draft notes when publishing them fails", async () => {
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

    const createCodeReviewDraftNote = vi.fn(async () => ({
      id: 701,
      author_id: 999,
      merge_request_id: 7,
      resolve_discussion: false,
      discussion_id: null,
      note: "**New finding**\n\nAnchor body",
      position: null,
    }));
    const bulkPublishCodeReviewDraftNotes = vi.fn(
      async () => await Promise.reject(new Error("publish failed")),
    );
    const listCodeReviewDiscussions = vi.fn(async () => []);
    const deleteCodeReviewDraftNote = vi.fn(async () => undefined);

    const context = createHydratedContext({ discussions: [] });

    await expect(
      reconciler.reconcile({
        platform,
        tenant,
        context,
        mappings: [],
        interactionRunId: "run_1",
        interactionJobId: "job-publication",
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
        publicationAdapter: createDiscussionAdapter(context, {
          createCodeReviewComment: vi.fn(
            async (
              _projectId: number,
              _codeReviewId: number,
              body: string,
            ) => ({
              id: 99,
              body,
              author: { id: 999, username: "review-bot", name: "Review Bot" },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              system: false,
            }),
          ),
          createCodeReviewDraftNote,
          bulkPublishCodeReviewDraftNotes,
          listCodeReviewDiscussions,
          deleteCodeReviewDraftNote,
          updateCodeReviewComment: vi.fn(),
          replyToDiscussion: vi.fn(),
          updateDiscussionNote: vi.fn(),
          resolveDiscussion: vi.fn(),
        }),
      }),
    ).rejects.toThrow("publish failed");

    expect(deleteCodeReviewDraftNote).toHaveBeenCalledWith(123, 7, 701);
    expect(storage.upsertDiscussionMapping).not.toHaveBeenCalled();
  });

  it("recovers published draft threads using the pre-publish thread snapshot", async () => {
    const storage = {
      upsertDiscussionMapping: vi
        .fn()
        .mockRejectedValueOnce(new Error("persist failed"))
        .mockImplementation(async (input) => ({
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

    const publishedThread = {
      id: "disc_new",
      comments: [
        {
          id: "801",
          body: "**New finding**\n\nAnchor body",
          authorId: "999",
          authorUsername: "review-bot",
          isBot: true,
          resolvable: false,
          resolved: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          anchor: null,
          positionJson: null,
          url: null,
        },
      ],
      resolvable: false,
      resolved: false,
    };

    const loadDiscussions = vi.fn(async () => []);
    const publishFindings = vi.fn(async ({ findings }) => ({
      findings: [
        {
          identityKey: findings[0]!.identityKey,
          discussion: publishedThread,
          rootComment: publishedThread.comments[0]!,
          url: null,
        },
      ],
      links: [],
    }));
    const upsertSummary = vi.fn(async ({ body }) => ({
      action: "created" as const,
      url: null,
      comment: {
        id: "summary",
        body,
        isBot: true,
        updatedAt: null,
        url: null,
      },
    }));

    const context = createHydratedContext({ discussions: [] });

    const reconcileInput = {
      platform,
      tenant,
      context,
      mappings: [],
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
      reviewResult: {
        overview: {
          summary: "Found one issue",
          overallSeverity: "medium" as const,
        },
        findings: [
          {
            title: "New finding",
            body: "Anchor body",
            severity: "medium" as const,
            category: "bug" as const,
          },
        ],
        priorDispositions: [],
      },
      publicationAdapter: {
        loadDiscussions,
        mutateDiscussion: vi.fn(),
        publishFindings,
        upsertSummary,
      },
    };

    await expect(reconciler.reconcile(reconcileInput)).rejects.toThrow(
      "persist failed",
    );
    expect(upsertSummary).not.toHaveBeenCalled();
    const summary = await reconciler.reconcile({
      ...reconcileInput,
      interactionRunId: "run_2",
    });

    expect(summary.created).toBe(1);
    expect(loadDiscussions).toHaveBeenCalledTimes(2);
    expect(publishFindings).toHaveBeenCalledTimes(2);
    expect(storage.upsertDiscussionMapping).toHaveBeenCalledTimes(2);
    expect(storage.updateReviewFindingStatus).toHaveBeenCalledTimes(1);
    expect(upsertSummary).toHaveBeenCalledTimes(1);
    expect(
      storage.updateReviewFindingStatus.mock.invocationCallOrder[0] ?? 0,
    ).toBeLessThan(upsertSummary.mock.invocationCallOrder[0] ?? 0);
    expect(storage.upsertDiscussionMapping).toHaveBeenLastCalledWith(
      expect.objectContaining({
        platformDiscussionId: "disc_new",
        platformCommentId: 801,
      }),
    );
  });

  it("matches a persisted mapping by root comment when GitHub thread hydration is delayed", async () => {
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({
        id: "mapping-github",
        ...input,
      })),
      updateReviewFindingStatus: vi.fn(async () => true),
      listLatestReviewFindings: vi.fn(async () => []),
    };
    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger,
    });
    const mapping = {
      id: "mapping-github",
      tenantId: tenant.id,
      codeReviewId: 7,
      identityKey: "old-identity",
      findingFingerprint: "old-fingerprint",
      title: "Delayed inline finding",
      severity: "medium",
      category: "bug",
      body: "**Delayed inline finding**\n\nOld body",
      platformDiscussionId: "PRRT_600",
      platformCommentId: 600,
      anchorJson: null,
      positionJson: null,
      botDiscussion: true,
      botComment: true,
      commentAuthorId: 999,
      commentAuthorUsername: "review-bot",
      status: "open" as const,
      lastInteractionRunId: "run_old",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const syntheticDiscussion = {
      id: "review-comment:600",
      comments: [
        {
          id: "600",
          body: "**Delayed inline finding**\n\nOld body",
          authorId: "999",
          authorUsername: "review-bot",
          isBot: true,
          resolvable: false,
          resolved: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          anchor: null,
          positionJson: null,
          url: "https://github.com/octo/repo/pull/7#discussion_r600",
        },
      ],
      resolvable: false,
      resolved: false,
    };
    const mutateDiscussion = vi.fn(async () => ({
      comment: {
        ...syntheticDiscussion.comments[0]!,
        body: "**Delayed inline finding**\n\nUpdated body",
      },
    }));
    const publishFindings = vi.fn();
    const upsertSummary = vi.fn(async ({ body }) => ({
      action: "created" as const,
      url: null,
      comment: {
        id: "summary",
        body,
        isBot: true,
        updatedAt: null,
        url: null,
      },
    }));

    const summary = await reconciler.reconcile({
      platform,
      tenant,
      context: createHydratedContext({ discussions: [] }),
      mappings: [mapping],
      interactionRunId: "run_1",
      interactionJobId: "job-publication",
      reviewResult: {
        overview: {
          summary: "Updated one issue",
          overallSeverity: "medium",
        },
        findings: [
          {
            priorDiscussionId: "mapping-github",
            title: "Delayed inline finding",
            body: "Updated body",
            severity: "medium",
            category: "bug",
          },
        ],
        priorDispositions: [],
      },
      publicationAdapter: {
        loadDiscussions: vi.fn(async () => [syntheticDiscussion]),
        mutateDiscussion,
        publishFindings,
        upsertSummary,
      },
    });

    expect(summary.updated).toBe(1);
    expect(summary.created).toBe(0);
    expect(publishFindings).not.toHaveBeenCalled();
    expect(mutateDiscussion).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "update-finding",
        discussionId: "review-comment:600",
        commentId: "600",
      }),
    );
    expect(storage.upsertDiscussionMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "mapping-github",
        platformDiscussionId: "review-comment:600",
        platformCommentId: 600,
      }),
    );
  });
});

function createHydratedContext(overrides?: {
  notes?: HydratedMergeRequestContext["notes"];
  changes?: HydratedMergeRequestContext["changes"];
  latestVersion?: HydratedMergeRequestContext["latestVersion"];
  discussions?: HydratedMergeRequestContext["discussions"];
}): HydratedMergeRequestContext & ReviewSummaryContext {
  const changes = overrides?.changes ?? [];
  return {
    tenant: {
      id: "tenant_1",
      key: "https://gitlab.example.com::123",
      platform: "gitlab",
      platformConnectionId: "connection-1",
      platformConfigJson: JSON.stringify({
        baseUrl: "https://gitlab.example.com",
        projectId: 123,
        apiToken: "token",
        webhookSecret: "secret",
        botUserId: 999,
        botUsername: "review-bot",
      }),
      modelProfileName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    job: {
      id: "job_1",
      tenantId: "tenant_1",
      dedupeKey: "dedupe",
      codeReviewId: 7,
      commentId: 55,
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
    changes,
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
            resolvable: true,
            resolved: false,
          },
          {
            id: 11,
            body: "Can you clarify this?",
            author: { id: 1, username: "dev", name: "Developer" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            system: false,
            resolvable: true,
            resolved: false,
          },
        ],
      },
    ],
    workspace: {
      rootPath: join("tmp", "workspace"),
      cleanupRoot: join("tmp", "cleanup"),
      strategy: "archive",
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
      codeReviewId: 7,
      headSha: "abc123",
      codeReviewJson: "{}",
      versionsJson: "[]",
      changesJson: "[]",
      commentsJson: "[]",
      discussionsJson: "[]",
      instructionsJson: "[]",
      projectMemoryJson: null,
      workspaceStrategy: "archive",
      createdAt: new Date().toISOString(),
    },
    codeReview: {
      id: 7,
      title: "Add worker",
      description: "Adds worker",
      webUrl: "https://gitlab.example.com/group/project/-/merge_requests/7",
      authorUsername: "developer",
      sourceBranch: "feature",
      targetBranch: "main",
    },
  } as unknown as HydratedMergeRequestContext & ReviewSummaryContext;
}
