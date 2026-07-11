import { describe, expect, it, vi } from "vitest";

import { CodeReviewContextHydrator } from "../src/platforms/gitlab/hydrator.js";
import { createLogger } from "../src/logger.js";
import { tmpPath } from "./test-paths.js";

describe("CodeReviewContextHydrator project memory", () => {
  it("continues hydration with disabled memory when wiki access fails", async () => {
    const storage = {
      createCodeReviewSnapshot: vi.fn(async (input) => ({
        id: "snapshot_1",
        ...input,
        createdAt: new Date().toISOString(),
      })),
    };
    const workspaceMaterializer = {
      materialize: vi.fn(async () => ({
        rootPath: tmpPath("workspace"),
        cleanupRoot: tmpPath("cleanup"),
        strategy: "git" as const,
      })),
    };
    const hydrator = new CodeReviewContextHydrator({
      storage: storage as never,
      workspaceMaterializer: workspaceMaterializer as never,
      memoryEnabled: true,
      logger: createLogger("silent"),
    });

    const context = await hydrator.hydrate({
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
          botUserId: 1,
          botUsername: "review-bot",
        }),
        modelProfileName: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      job: {
        id: "job_1",
        availableAt: new Date().toISOString(),
        claimToken: null,
        claimedBy: null,
        claimExpiresAt: null,
        latestInteractionRunId: null,
        tenantId: "tenant_1",
        dedupeKey: "dedupe",
        codeReviewId: 7,
        commentId: 55,
        triggerJson: '{"kind":"comment","commentId":55}',
        headSha: "abc123",
        status: "queued",
        payloadJson: "{}",
        retryCount: 0,
        lastError: null,
        enqueuedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      },
      client: {
        getCodeReview: vi.fn(async () => ({
          id: 1,
          iid: 7,
          project_id: 123,
          title: "Example",
          description: "Description",
          web_url:
            "https://gitlab.example.com/group/project/-/merge_requests/7",
          source_branch: "feature",
          target_branch: "main",
          author: {
            id: 42,
            username: "developer",
            name: "Dev User",
          },
        })),
        listCodeReviewVersions: vi.fn(async () => []),
        getCodeReviewChanges: vi.fn(async () => []),
        listCodeReviewNotes: vi.fn(async () => []),
        listCodeReviewDiscussions: vi.fn(async () => []),
        getProjectWikiPage: vi.fn(async () => {
          throw new Error("wiki unavailable");
        }),
        listProjectWikiPages: vi.fn(async () => {
          throw new Error("wiki unavailable");
        }),
      } as never,
    });

    expect(context.projectMemory).toEqual({
      enabled: false,
      page: null,
      entries: [],
    });
    expect(storage.createCodeReviewSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectMemoryJson: JSON.stringify({
          enabled: false,
          page: null,
          entries: [],
        }),
        instructionsJson: "[]",
      }),
    );
  });
});
