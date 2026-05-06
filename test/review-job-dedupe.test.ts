import { describe, expect, it, vi } from "vitest";

import type { GitLabNoteHookPayload } from "../src/gitlab/types.js";
import { ReviewWorker } from "../src/jobs/review-worker.js";
import { createLogger } from "../src/logger.js";
import type { CreateInteractionJobInput } from "../src/storage/contract/index.js";
import { createInteractionJobDedupeKey } from "../src/utils/ids.js";
import { tmpPath } from "./test-paths.js";

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
  updatedAt: new Date().toISOString()
};

describe("review job dedupe", () => {
  it("includes note update revision details when creating review jobs from webhooks", async () => {
    const payload: GitLabNoteHookPayload = {
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
        note: "@review-bot please review this again",
        noteable_type: "MergeRequest",
        action: "update",
        updated_at: "2026-04-27T11:00:00.000Z",
        url: "https://gitlab.example.com/group/project/-/merge_requests/7#note_55"
      },
      user: {
        id: 42,
        username: "developer",
        name: "Dev User",
        web_url: "https://gitlab.example.com/developer"
      }
    };

    const storage = {
      createOrGetInteractionJob: vi.fn(async (input: CreateInteractionJobInput) => ({
        job: {
          id: "job_1",
          tenantId: tenant.id,
          dedupeKey: input.dedupeKey,
          projectId: input.projectId,
          mergeRequestIid: input.mergeRequestIid,
          noteId: input.noteId,
          headSha: input.headSha,
          status: "queued" as const,
          payloadJson: input.payloadJson,
          retryCount: 0,
          lastError: null,
          enqueuedAt: new Date().toISOString(),
          startedAt: null,
          finishedAt: null
        },
        created: false
      }))
    };

    const worker = new ReviewWorker({
      storage: storage as never,
      tenantRegistry: {} as never,
      hydrator: {} as never,
      workspaceMaterializer: {} as never,
      reviewProviderFactory: {} as never,
      chatterRunnerFactory: {} as never,
      reconciler: {} as never,
      logger: createLogger("silent"),
      runLogDir: tmpPath("run-logs"),
      maxJobRetries: 3,
      retryBackoffMs: 1000
    });

    await worker.createInteractionJobFromWebhook(payload, tenant, {
      kind: "direct-mention",
      note: {
        kind: "merge-request-note",
        noteId: 55
      }
    });

    expect(storage.createOrGetInteractionJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: createInteractionJobDedupeKey({
          baseUrl: tenant.baseUrl,
          projectId: tenant.projectId,
          mergeRequestIid: 7,
          noteId: 55,
          noteAction: "update",
          noteUpdatedAt: "2026-04-27T11:00:00.000Z",
          noteBody: "@review-bot please review this again"
        }),
        headSha: "abc123",
        noteId: 55
      })
    );
  });
});
