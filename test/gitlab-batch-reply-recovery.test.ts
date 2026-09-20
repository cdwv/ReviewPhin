import { afterEach, expect, it, vi } from "vitest";
import GitLabPlatform from "../src/platforms/gitlab/platform.js";
import { createLogger } from "../src/logger.js";
import { replyPublicationMarker } from "../src/review/batch-checkpoint.js";
import {
  createGitLabConnectionRecord,
  createGitLabTenantRecord,
} from "./helpers/gitlab-tenant.js";
import { batchRequest } from "./helpers/batch-request.js";

afterEach(() => vi.restoreAllMocks());

it("recovers a reply accepted by GitLab before local acknowledgement", async () => {
  const marker = replyPublicationMarker("batch", ["request-1"]);
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("cache-control")).toBe("no-cache");
      return Response.json([
        {
          id: 701,
          body: "Saved answer\n" + marker,
          author: { id: 999, username: "review-bot", name: "Review Bot" },
          system: false,
          created_at: "2026-09-19T00:00:00Z",
          updated_at: "2026-09-19T00:00:00Z",
        },
      ]);
    });
  const logger = createLogger("silent");
  const runtime = new GitLabPlatform(logger).createReviewRuntime({
    storage: {} as never,
    logger,
    resolvedTenant: {
      tenant: createGitLabTenantRecord(),
      connection: createGitLabConnectionRecord(),
    },
    interactionJobId: "batch",
    workspaceRoot: "tmp",
    memoryEnabled: false,
  });
  const target = batchRequest(1, "Why?").trigger.responseTarget;
  const outcomes = await runtime.publishChatterReplies({
    codeReviewId: 7,
    plannedTargets: [target],
    result: {
      memory: null,
      replies: [{ target, replyBody: "Saved answer\n" + marker }],
    },
    guard: { assertOwned() {} },
  });
  expect(outcomes).toEqual([{ target, status: "published", commentId: 701 }]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
