import { describe, expect, it } from "vitest";

import { buildReviewTriggerContext, classifyWebhookTrigger } from "../src/review/trigger.js";
import { REVIEW_SUMMARY_NOTE_MARKER } from "../src/review/summary.js";
import { createReviewJobDedupeKey } from "../src/utils/ids.js";

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

describe("review trigger helpers", () => {
  it("treats human comments in bot-owned threads as follow-up instructions", async () => {
    const trigger = await classifyWebhookTrigger({
      tenant,
      payload: {
        object_kind: "note",
        project: {
          id: 123,
          web_url: "https://gitlab.example.com/group/project"
        },
        repository: {
          homepage: "https://gitlab.example.com/group/project"
        },
        merge_request: {
          iid: 7,
          title: "Add worker",
          description: "Adds the worker",
          source_branch: "feature",
          target_branch: "main"
        },
        object_attributes: {
          id: 55,
          note: "Please make this more human.",
          noteable_type: "MergeRequest"
        },
        user: {
          id: 42,
          username: "developer",
          name: "Dev User"
        }
      },
      client: {
        listMergeRequestDiscussions: async () => [
          {
            id: "disc_1",
            individual_note: false,
            notes: [
              {
                id: 10,
                type: "DiscussionNote",
                body: "**Finding**\n\nOriginal wording",
                author: { id: 999, username: "review-bot", name: "Review Bot" },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                system: false
              },
              {
                id: 55,
                type: "DiscussionNote",
                body: "Please make this more human.",
                author: { id: 42, username: "developer", name: "Dev User" },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                system: false
              }
            ]
          }
        ]
      }
    });

    expect(trigger).toEqual({
      kind: "follow-up-comment",
      note: {
        kind: "discussion-note",
        discussionId: "disc_1",
        noteId: 55
      }
    });
  });

  it("treats direct bot mentions as explicit triggers", async () => {
    const trigger = await classifyWebhookTrigger({
      tenant,
      payload: {
        object_kind: "note",
        project: {
          id: 123,
          web_url: "https://gitlab.example.com/group/project"
        },
        repository: {
          homepage: "https://gitlab.example.com/group/project"
        },
        merge_request: {
          iid: 7,
          title: "Add worker",
          description: "Adds the worker",
          source_branch: "feature",
          target_branch: "main"
        },
        object_attributes: {
          id: 56,
          note: "@review-bot please make the descriptions more human",
          noteable_type: "MergeRequest"
        },
        user: {
          id: 42,
          username: "developer",
          name: "Dev User"
        }
      },
      client: {
        listMergeRequestDiscussions: async () => []
      }
    });

    expect(trigger).toEqual({
      kind: "direct-mention",
      note: {
        kind: "merge-request-note",
        noteId: 56
      }
    });
  });

  it("does not treat replies on the review summary note as follow-up instructions", async () => {
    const trigger = await classifyWebhookTrigger({
      tenant,
      payload: {
        object_kind: "note",
        project: {
          id: 123,
          web_url: "https://gitlab.example.com/group/project"
        },
        repository: {
          homepage: "https://gitlab.example.com/group/project"
        },
        merge_request: {
          iid: 7,
          title: "Add worker",
          description: "Adds the worker",
          source_branch: "feature",
          target_branch: "main"
        },
        object_attributes: {
          id: 58,
          note: "Please rerun the review.",
          noteable_type: "MergeRequest"
        },
        user: {
          id: 42,
          username: "developer",
          name: "Dev User"
        }
      },
      client: {
        listMergeRequestDiscussions: async () => [
          {
            id: "disc_summary",
            individual_note: false,
            notes: [
              {
                id: 20,
                type: "DiscussionNote",
                body: `${REVIEW_SUMMARY_NOTE_MARKER}\n\n## Review summary`,
                author: { id: 999, username: "review-bot", name: "Review Bot" },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                system: false
              },
              {
                id: 58,
                type: "DiscussionNote",
                body: "Please rerun the review.",
                author: { id: 42, username: "developer", name: "Dev User" },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                system: false
              }
            ]
          }
        ]
      }
    });

    expect(trigger).toBeNull();
  });

  it("does not treat longer usernames with the bot prefix as direct mentions", async () => {
    const trigger = await classifyWebhookTrigger({
      tenant,
      payload: {
        object_kind: "note",
        project: {
          id: 123,
          web_url: "https://gitlab.example.com/group/project"
        },
        repository: {
          homepage: "https://gitlab.example.com/group/project"
        },
        merge_request: {
          iid: 7,
          title: "Add worker",
          description: "Adds the worker",
          source_branch: "feature",
          target_branch: "main"
        },
        object_attributes: {
          id: 57,
          note: "@review-bot-helper please make the descriptions more human",
          noteable_type: "MergeRequest"
        },
        user: {
          id: 42,
          username: "developer",
          name: "Dev User"
        }
      },
      client: {
        listMergeRequestDiscussions: async () => []
      }
    });

    expect(trigger).toBeNull();
  });

  it("extracts explicit trigger context for follow-up comments and direct mentions", async () => {
    const priorThreads = [
      {
        threadId: "map_1",
        discussionId: "disc_1",
        noteId: 10,
        title: "Old finding",
        body: "**Old finding**\n\nOriginal wording",
        anchor: null,
        resolved: false,
        humanReplies: [
          {
            noteId: 55,
            authorUsername: "developer",
            body: "Please make this more human."
          }
        ]
      }
    ];

    const followUpTrigger = buildReviewTriggerContext({
      payload: {
        object_kind: "note",
        project: {
          id: 123,
          web_url: "https://gitlab.example.com/group/project"
        },
        repository: {
          homepage: "https://gitlab.example.com/group/project"
        },
        merge_request: {
          iid: 7,
          title: "Add worker",
          description: "Adds the worker",
          source_branch: "feature",
          target_branch: "main"
        },
        object_attributes: {
          id: 55,
          note: "Please make this more human.",
          noteable_type: "MergeRequest"
        },
        user: {
          id: 42,
          username: "developer",
          name: "Dev User"
        }
      },
      tenant,
      priorThreads
    });

    expect(followUpTrigger).toMatchObject({
      kind: "follow-up-comment",
      instruction: "Please make this more human.",
      targetThreadId: "map_1",
      targetDiscussionId: "disc_1",
      targetThreadTitle: "Old finding"
    });

    const reviewCommandTrigger = buildReviewTriggerContext({
      payload: {
        object_kind: "note",
        project: {
          id: 123,
          web_url: "https://gitlab.example.com/group/project"
        },
        repository: {
          homepage: "https://gitlab.example.com/group/project"
        },
        merge_request: {
          iid: 7,
          title: "Add worker",
          description: "Adds the worker",
          source_branch: "feature",
          target_branch: "main"
        },
        object_attributes: {
          id: 56,
          note: "@review-bot please make the descriptions more human",
          noteable_type: "MergeRequest"
        },
        user: {
          id: 42,
          username: "developer",
          name: "Dev User"
        }
      },
      tenant,
      priorThreads
    });

    expect(reviewCommandTrigger).toMatchObject({
      kind: "direct-mention",
      instruction: "please make the descriptions more human",
      targetThreadId: null
    });
  });

  it("treats note updates as distinct dedupe identities for the same trigger comment", () => {
    const createKey = createReviewJobDedupeKey({
      baseUrl: tenant.baseUrl,
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 55
    });

    const firstUpdateKey = createReviewJobDedupeKey({
      baseUrl: tenant.baseUrl,
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 55,
      noteAction: "update",
      noteUpdatedAt: "2026-04-27T11:00:00.000Z",
      noteBody: "@review-bot please review this again"
    });

    const secondUpdateKey = createReviewJobDedupeKey({
      baseUrl: tenant.baseUrl,
      projectId: tenant.projectId,
      mergeRequestIid: 7,
      noteId: 55,
      noteAction: "update",
      noteUpdatedAt: "2026-04-27T11:05:00.000Z",
      noteBody: "@review-bot please review this again"
    });

    expect(createKey).not.toBe(firstUpdateKey);
    expect(firstUpdateKey).not.toBe(secondUpdateKey);
    expect(firstUpdateKey).toBe(
      createReviewJobDedupeKey({
        baseUrl: tenant.baseUrl,
        projectId: tenant.projectId,
        mergeRequestIid: 7,
        noteId: 55,
        noteAction: "update",
        noteUpdatedAt: "2026-04-27T11:00:00.000Z",
        noteBody: "@review-bot please review this again"
      })
    );
  });

  it("falls back to the note body when an update webhook omits updated_at", () => {
    expect(
      createReviewJobDedupeKey({
        baseUrl: tenant.baseUrl,
        projectId: tenant.projectId,
        mergeRequestIid: 7,
        noteId: 55,
        noteAction: "update",
        noteBody: "@review-bot first edit"
      })
    ).not.toBe(
      createReviewJobDedupeKey({
        baseUrl: tenant.baseUrl,
        projectId: tenant.projectId,
        mergeRequestIid: 7,
        noteId: 55,
        noteAction: "update",
        noteBody: "@review-bot second edit"
      })
    );
  });
});
