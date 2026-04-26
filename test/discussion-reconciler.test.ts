import { describe, expect, it, vi } from "vitest";

import type { HydratedMergeRequestContext } from "../src/gitlab/types.js";
import { createLogger } from "../src/logger.js";
import { buildProviderThreads, DiscussionReconciler } from "../src/reconcile/discussion-reconciler.js";

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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  it("updates a bot-owned thread when the model revises the finding after a human reply", async () => {
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({ id: "map_1", ...input }))
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger
    });

    const replyToDiscussion = vi.fn();
    const updateDiscussionNote = vi.fn(async () => ({
      id: 10,
      body: "**Old finding**\n\nUpdated body",
      author: { id: 999, username: "review-bot", name: "Review Bot" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      system: false,
      resolved: false
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
        lastReviewRunId: "run_old",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];

    const summary = await reconciler.reconcile({
      tenant,
      context,
      mappings,
      reviewRunId: "run_1",
      reviewResult: {
        overview: {
          summary: "Found one issue",
          overallSeverity: "medium"
        },
        findings: [
          {
            priorThreadId: "map_1",
            title: "Old finding",
            body: "Updated body",
            severity: "medium",
            category: "bug"
          }
        ],
        priorDispositions: []
      },
      client: {
        replyToDiscussion,
        updateDiscussionNote,
        createMergeRequestDiscussion: vi.fn(),
        resolveDiscussion: vi.fn()
      } as never
    });

    expect(summary.updated).toBe(1);
    expect(replyToDiscussion).not.toHaveBeenCalled();
    expect(updateDiscussionNote).toHaveBeenCalledTimes(1);
    expect(storage.upsertDiscussionMapping).toHaveBeenCalledTimes(1);
  });

  it("replies in a bot-owned thread when the disposition explicitly asks for a reply", async () => {
    const storage = {
      upsertDiscussionMapping: vi.fn(async (input) => ({ id: "map_1", ...input }))
    };

    const reconciler = new DiscussionReconciler({
      storage: storage as never,
      logger
    });

    const replyToDiscussion = vi.fn(async () => ({
      id: 12,
      body: "Thanks, I reworded it.",
      author: { id: 999, username: "review-bot", name: "Review Bot" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      system: false,
      resolved: false
    }));
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
        lastReviewRunId: "run_old",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];

    const summary = await reconciler.reconcile({
      tenant,
      context,
      mappings,
      reviewRunId: "run_1",
      reviewResult: {
        overview: {
          summary: "Handled follow-up",
          overallSeverity: "medium"
        },
        findings: [],
        priorDispositions: [
          {
            threadId: "map_1",
            action: "reply",
            replyBody: "Thanks, I reworded it."
          }
        ]
      },
      client: {
        replyToDiscussion,
        updateDiscussionNote,
        createMergeRequestDiscussion: vi.fn(),
        resolveDiscussion: vi.fn()
      } as never
    });

    expect(summary.replied).toBe(1);
    expect(replyToDiscussion).toHaveBeenCalledTimes(1);
    expect(updateDiscussionNote).not.toHaveBeenCalled();
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
              system: false
            }
          ]
        }
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
          lastReviewRunId: "run_old",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]
    });

    expect(threads).toEqual([]);
  });
});

function createHydratedContext(): HydratedMergeRequestContext {
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
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
      finishedAt: null
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
        name: "Developer"
      }
    },
    versions: [],
    latestVersion: null,
    changes: [],
    notes: [],
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
            resolved: false
          },
          {
            id: 11,
            body: "Can you clarify this?",
            author: { id: 1, username: "dev", name: "Developer" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            system: false,
            resolved: false
          }
        ]
      }
    ],
    workspace: {
      rootPath: "H:\\tmp\\workspace",
      cleanupRoot: "H:\\tmp\\cleanup",
      strategy: "archive",
      instructionFiles: []
    },
    snapshot: {
      id: "snapshot_1",
      reviewJobId: "job_1",
      tenantId: "tenant_1",
      mergeRequestIid: 7,
      headSha: "abc123",
      mergeRequestJson: "{}",
      versionsJson: "[]",
      changesJson: "[]",
      notesJson: "[]",
      discussionsJson: "[]",
      instructionsJson: "[]",
      workspaceStrategy: "archive",
      createdAt: new Date().toISOString()
    }
  };
}
