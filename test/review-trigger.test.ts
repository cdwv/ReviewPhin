import { describe, expect, it } from "vitest";

import { buildReviewTriggerContext, isFollowUpInstructionWebhook } from "../src/review/trigger.js";

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
    const accepted = await isFollowUpInstructionWebhook({
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
                body: "**Finding**\n\nOriginal wording",
                author: { id: 999, username: "review-bot", name: "Review Bot" },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                system: false
              },
              {
                id: 55,
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

    expect(accepted).toBe(true);
  });

  it("extracts explicit trigger context for follow-up comments and review commands", () => {
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
          note: "/review please make the descriptions more human",
          noteable_type: "MergeRequest"
        },
        user: {
          id: 42,
          username: "developer",
          name: "Dev User"
        }
      },
      priorThreads
    });

    expect(reviewCommandTrigger).toMatchObject({
      kind: "review-command",
      instruction: "please make the descriptions more human",
      targetThreadId: null
    });
  });
});
