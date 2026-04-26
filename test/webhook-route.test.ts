import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";

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

function createPayload(note: string) {
  return {
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
      target_branch: "main",
      last_commit: {
        id: "abc123"
      }
    },
    object_attributes: {
      id: 55,
      note,
      noteable_type: "MergeRequest",
      url: "https://gitlab.example.com/group/project/-/merge_requests/7#note_55"
    },
    user: {
      id: 42,
      username: "developer",
      name: "Dev User",
      web_url: "https://gitlab.example.com/developer"
    }
  };
}

describe("GitLab webhook route", () => {
  const logger = createLogger("silent");
  const tenantRegistry = {
    resolveWebhookTenant: vi.fn(async () => tenant)
  };
  const reviewWorker = {
    shouldHandleFollowUpWebhook: vi.fn(async () => false),
    createReviewJobFromWebhook: vi.fn(async () => ({
      job: { id: "job_1" },
      created: true
    }))
  };
  const queue = {
    enqueue: vi.fn()
  };

  let appPromise = createApp({
    logger,
    tenantRegistry: tenantRegistry as never,
    reviewWorker: reviewWorker as never,
    queue: queue as never
  });

  afterEach(async () => {
    const app = await appPromise;
    await app.close();
    tenantRegistry.resolveWebhookTenant.mockClear();
    reviewWorker.shouldHandleFollowUpWebhook.mockClear();
    reviewWorker.createReviewJobFromWebhook.mockClear();
    queue.enqueue.mockClear();
    appPromise = createApp({
      logger,
      tenantRegistry: tenantRegistry as never,
      reviewWorker: reviewWorker as never,
      queue: queue as never
    });
  });

  it("queues a review job for /review comments", async () => {
    const app = await appPromise;

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/gitlab/note",
      headers: {
        "x-gitlab-token": "secret"
      },
      payload: createPayload("please /review this")
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      accepted: true,
      jobId: "job_1",
      deduplicated: false
    });
    expect(reviewWorker.createReviewJobFromWebhook).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith("job_1");
  });

  it("queues a review job for follow-up comments in bot-owned threads", async () => {
    const app = await appPromise;
    reviewWorker.shouldHandleFollowUpWebhook.mockResolvedValueOnce(true);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/gitlab/note",
      headers: {
        "x-gitlab-token": "secret"
      },
      payload: createPayload("Can you make this wording more human?")
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      accepted: true,
      jobId: "job_1",
      deduplicated: false
    });
    expect(reviewWorker.shouldHandleFollowUpWebhook).toHaveBeenCalledTimes(1);
    expect(reviewWorker.createReviewJobFromWebhook).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith("job_1");
  });

  it("ignores non-review comments", async () => {
    const app = await appPromise;

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/gitlab/note",
      headers: {
        "x-gitlab-token": "secret"
      },
      payload: createPayload("looks good to me")
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      accepted: false,
      reason: "no-review-command"
    });
    expect(reviewWorker.shouldHandleFollowUpWebhook).toHaveBeenCalledTimes(1);
    expect(reviewWorker.createReviewJobFromWebhook).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
