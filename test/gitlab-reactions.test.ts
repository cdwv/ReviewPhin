import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitLabClient } from "../src/platforms/gitlab/client.js";
import type {
  GitLabDiscussion,
  GitLabNoteHookPayload,
} from "../src/platforms/gitlab/types.js";
import { ReviewWorker } from "../src/jobs/review-worker.js";
import { createLogger } from "../src/logger.js";
import { createGitLabConnectionRecord } from "./helpers/gitlab-tenant.js";
import { createClaimContext } from "./helpers/claim.js";
import { wrapGitLabPlatformContext } from "./helpers/platform-context.js";
import { overridePlatformRuntime } from "./helpers/platform-runtime.js";

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
const connection = createGitLabConnectionRecord();

const directMentionPayload: GitLabNoteHookPayload = {
  object_kind: "note",
  project: {
    id: 123,
    web_url: "https://gitlab.example.com/group/project",
    path_with_namespace: "group/project",
  },
  repository: {
    homepage: "https://gitlab.example.com/group/project",
  },
  merge_request: {
    iid: 7,
    title: "Add worker",
    description: "Adds the worker",
    source_branch: "feature",
    target_branch: "main",
    last_commit: {
      id: "abc123",
    },
  },
  object_attributes: {
    id: 55,
    note: "@review-bot please review this",
    noteable_type: "MergeRequest",
    url: "https://gitlab.example.com/group/project/-/merge_requests/7#note_55",
  },
  user: {
    id: 42,
    username: "developer",
    name: "Dev User",
    web_url: "https://gitlab.example.com/developer",
  },
};

const followUpPayload: GitLabNoteHookPayload = {
  ...directMentionPayload,
  object_attributes: {
    id: 56,
    note: "Please make this more human.",
    noteable_type: "MergeRequest",
    url: "https://gitlab.example.com/group/project/-/merge_requests/7#note_56",
  },
};

describe("GitLab reactions", () => {
  const originalFetch = globalThis.fetch;

  function createFreshTriggerNoteListResponse(noteId: number): Response {
    return new Response(
      JSON.stringify([
        {
          id: noteId,
          body:
            noteId === followUpPayload.object_attributes.id
              ? followUpPayload.object_attributes.note
              : directMentionPayload.object_attributes.note,
          author: directMentionPayload.user,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          system: false,
        },
      ]),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("lists and creates merge request note award emojis", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "GET") {
          expect(url).toBe(
            "https://gitlab.example.com/api/v4/projects/123/merge_requests/7/notes/55/award_emoji?page=1&per_page=100",
          );
          return new Response("[]", {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }

        expect(init?.method).toBe("POST");
        expect(url).toBe(
          "https://gitlab.example.com/api/v4/projects/123/merge_requests/7/notes/55/award_emoji",
        );
        expect(new Headers(init?.headers).get("content-type")).toBe(
          "application/x-www-form-urlencoded",
        );
        expect(String(init?.body)).toContain("name=eyes");

        return new Response(
          JSON.stringify({
            id: 1,
            name: "eyes",
            user: {
              id: 999,
              username: "review-bot",
              name: "Review Bot",
            },
            created_at: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    );

    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    const existing = await client.listCodeReviewNoteAwardEmojis(123, 7, 55);
    expect(existing).toEqual([]);

    const created = await client.createCodeReviewNoteAwardEmoji(
      123,
      7,
      55,
      "eyes",
    );
    expect(created.name).toBe("eyes");
  });

  it("adds reactions to direct mention trigger notes when a review starts and completes", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (
          init?.method === "GET" &&
          url.includes("/merge_requests/7/notes?")
        ) {
          return createFreshTriggerNoteListResponse(55);
        }

        if (init?.method === "GET" && url.includes("/discussions?")) {
          return new Response("[]", {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }

        if (init?.method === "GET" && url.includes("/notes/55/award_emoji")) {
          return new Response("[]", {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }

        const body = String(init?.body);
        const reactionName = body.includes("white_check_mark")
          ? "white_check_mark"
          : "eyes";
        return new Response(
          JSON.stringify({
            id: reactionName === "eyes" ? 1 : 2,
            name: reactionName,
            user: {
              id: 999,
              username: "review-bot",
              name: "Review Bot",
            },
            created_at: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    );
    globalThis.fetch = fetchMock;

    const { worker, job } = createWorker({
      payload: directMentionPayload,
      discussions: [],
    });

    await worker.createInteractionJobFromWebhook(
      directMentionPayload,
      { tenant, connection },
      {
        kind: "direct-mention",
        comment: {
          kind: "code-review-comment",
          commentId: 55,
        },
      },
    );
    await worker.processClaimedJob(job as never, createClaimContext(job.id));

    const postedUrls = fetchMock.mock.calls
      .filter(
        ([input, init]) =>
          init?.method === "POST" && String(input).includes("/award_emoji"),
      )
      .map(([input]) => String(input));
    const postedBodies = fetchMock.mock.calls
      .filter(
        ([input, init]) =>
          init?.method === "POST" && String(input).includes("/award_emoji"),
      )
      .map(([, init]) => String(init?.body));

    expect(
      postedUrls.every((url) =>
        url.includes("/merge_requests/7/notes/55/award_emoji"),
      ),
    ).toBe(true);
    expect(postedBodies.some((body) => body.includes("name=eyes"))).toBe(true);
    expect(
      postedBodies.some((body) => body.includes("name=white_check_mark")),
    ).toBe(true);
  });

  it("processes migrated GitLab jobs with legacy comment trigger JSON", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "GET" && url.includes("/discussions?")) {
          return new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (
          init?.method === "GET" &&
          url.includes("/merge_requests/7/notes?")
        ) {
          return createFreshTriggerNoteListResponse(55);
        }
        if (init?.method === "GET" && url.includes("/notes/55/award_emoji")) {
          return new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        const body = String(init?.body);
        const reactionName = body.includes("white_check_mark")
          ? "white_check_mark"
          : "eyes";
        return new Response(
          JSON.stringify({
            id: reactionName === "eyes" ? 1 : 2,
            name: reactionName,
            user: {
              id: 999,
              username: "review-bot",
              name: "Review Bot",
            },
            created_at: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    globalThis.fetch = fetchMock;

    const { worker, job } = createWorker({
      payload: directMentionPayload,
      discussions: [],
      triggerJson: '{"kind":"comment","commentId":55}',
    });

    await worker.processClaimedJob(job as never, createClaimContext(job.id));

    const postedBodies = fetchMock.mock.calls
      .filter(
        ([input, init]) =>
          init?.method === "POST" && String(input).includes("/award_emoji"),
      )
      .map(([, init]) => String(init?.body));
    expect(postedBodies.some((body) => body.includes("name=eyes"))).toBe(true);
    expect(
      postedBodies.some((body) => body.includes("name=white_check_mark")),
    ).toBe(true);
  });

  it("adds a friendly failure reaction to direct mention trigger notes on terminal failure", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (
          init?.method === "GET" &&
          url.includes("/merge_requests/7/notes?")
        ) {
          return createFreshTriggerNoteListResponse(55);
        }

        if (init?.method === "GET" && url.includes("/discussions?")) {
          return new Response("[]", {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }

        if (init?.method === "GET" && url.includes("/notes/55/award_emoji")) {
          return new Response("[]", {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }

        const body = String(init?.body);
        const reactionName = body.includes("confounded")
          ? "confounded"
          : "eyes";
        return new Response(
          JSON.stringify({
            id: reactionName === "eyes" ? 1 : 2,
            name: reactionName,
            user: {
              id: 999,
              username: "review-bot",
              name: "Review Bot",
            },
            created_at: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    );
    globalThis.fetch = fetchMock;

    const { worker, job, transitionClaim } = createWorker({
      payload: directMentionPayload,
      discussions: [],
      jobRetryCount: 3,
      reviewError: new Error("final failure"),
    });

    await worker.createInteractionJobFromWebhook(
      directMentionPayload,
      { tenant, connection },
      {
        kind: "direct-mention",
        comment: {
          kind: "code-review-comment",
          commentId: 55,
        },
      },
    );

    await expect(
      worker.processClaimedJob(job as never, createClaimContext(job.id)),
    ).resolves.toBeUndefined();
    expect(transitionClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        status: "failed",
        retryCount: 4,
        lastError: "final failure",
      }),
    );

    const postedBodies = fetchMock.mock.calls
      .filter(
        ([input, init]) =>
          init?.method === "POST" && String(input).includes("/award_emoji"),
      )
      .map(([, init]) => String(init?.body));

    expect(postedBodies.some((body) => body.includes("name=eyes"))).toBe(true);
    expect(postedBodies.some((body) => body.includes("name=confounded"))).toBe(
      true,
    );
    expect(
      postedBodies.some((body) => body.includes("name=white_check_mark")),
    ).toBe(false);
  });

  it("does not add the failure reaction while retries remain", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (
          init?.method === "GET" &&
          url.includes("/merge_requests/7/notes?")
        ) {
          return createFreshTriggerNoteListResponse(55);
        }

        if (init?.method === "GET" && url.includes("/discussions?")) {
          return new Response("[]", {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }

        if (init?.method === "GET" && url.includes("/notes/55/award_emoji")) {
          return new Response("[]", {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }

        return new Response(
          JSON.stringify({
            id: 1,
            name: "eyes",
            user: {
              id: 999,
              username: "review-bot",
              name: "Review Bot",
            },
            created_at: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    );
    globalThis.fetch = fetchMock;

    const { worker, job, transitionClaim } = createWorker({
      payload: directMentionPayload,
      discussions: [],
      jobRetryCount: 0,
      reviewError: new Error("retryable failure"),
    });

    await worker.createInteractionJobFromWebhook(
      directMentionPayload,
      { tenant, connection },
      {
        kind: "direct-mention",
        comment: {
          kind: "code-review-comment",
          commentId: 55,
        },
      },
    );

    await expect(
      worker.processClaimedJob(job as never, createClaimContext(job.id)),
    ).resolves.toBeUndefined();
    expect(transitionClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        status: "queued",
        retryCount: 1,
        lastError: "retryable failure",
        finishedAt: null,
      }),
    );

    const postedBodies = fetchMock.mock.calls
      .filter(
        ([input, init]) =>
          init?.method === "POST" && String(input).includes("/award_emoji"),
      )
      .map(([, init]) => String(init?.body));

    expect(postedBodies.some((body) => body.includes("name=eyes"))).toBe(true);
    expect(postedBodies.some((body) => body.includes("name=confounded"))).toBe(
      false,
    );
  });

  it("adds reactions to follow-up discussion notes", async () => {
    const discussions = [
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
            system: false,
          },
          {
            id: 56,
            type: "DiscussionNote",
            body: "Please make this more human.",
            author: { id: 42, username: "developer", name: "Dev User" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            system: false,
          },
        ],
      },
    ] satisfies GitLabDiscussion[];

    const deliveredReactions = new Set<string>();
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (
          init?.method === "GET" &&
          url.includes("/merge_requests/7/notes?")
        ) {
          return createFreshTriggerNoteListResponse(56);
        }

        if (init?.method === "GET" && url.includes("/discussions?")) {
          return new Response(JSON.stringify(discussions), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }

        if (init?.method === "GET" && url.includes("/award_emoji")) {
          return new Response(
            JSON.stringify(
              [...deliveredReactions].map((name, index) => ({
                id: index + 1,
                name,
                user: {
                  id: 999,
                  username: "review-bot",
                  name: "Review Bot",
                },
                created_at: new Date().toISOString(),
              })),
            ),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        const body = String(init?.body);
        const reactionName = body.includes("white_check_mark")
          ? "white_check_mark"
          : "eyes";
        deliveredReactions.add(reactionName);
        return new Response(
          JSON.stringify({
            id: reactionName === "eyes" ? 1 : 2,
            name: reactionName,
            user: {
              id: 999,
              username: "review-bot",
              name: "Review Bot",
            },
            created_at: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    );
    globalThis.fetch = fetchMock;

    const { worker, job } = createWorker({
      payload: followUpPayload,
      discussions,
    });

    await worker.createInteractionJobFromWebhook(
      followUpPayload,
      { tenant, connection },
      {
        kind: "follow-up-comment",
        comment: {
          kind: "discussion-comment",
          discussionId: "disc_1",
          commentId: 56,
        },
      },
    );
    await worker.processClaimedJob(job as never, createClaimContext(job.id));

    const awardEmojiPosts = fetchMock.mock.calls.filter(
      ([input, init]) =>
        init?.method === "POST" && String(input).includes("/award_emoji"),
    );
    expect(awardEmojiPosts.map(([input]) => String(input))).toEqual([
      expect.stringContaining("/discussions/disc_1/notes/56/award_emoji"),
      expect.stringContaining("/discussions/disc_1/notes/56/award_emoji"),
    ]);
    expect(awardEmojiPosts.map(([, init]) => String(init?.body))).toEqual([
      expect.stringContaining("name=eyes"),
      expect.stringContaining("name=white_check_mark"),
    ]);
  });

  it("does not fail job creation when a lifecycle update fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("GitLab unavailable");
    });
    const { worker } = createWorker({
      payload: directMentionPayload,
      discussions: [],
    });

    await expect(
      worker.createInteractionJobFromWebhook(
        directMentionPayload,
        { tenant, connection },
        {
          kind: "direct-mention",
          comment: {
            kind: "code-review-comment",
            commentId: 55,
          },
        },
      ),
    ).resolves.toMatchObject({
      created: true,
      job: { id: "job_1" },
    });
  });
});

function createWorker(input: {
  payload: GitLabNoteHookPayload;
  discussions: GitLabDiscussion[];
  triggerJson?: string;
  jobRetryCount?: number;
  reviewError?: Error;
}) {
  const job = {
    id: "job_1",
    tenantId: tenant.id,
    dedupeKey: "dedupe",
    projectId: tenant.projectId,
    codeReviewId: 7,
    commentId: input.payload.object_attributes.id,
    triggerJson:
      input.triggerJson ??
      JSON.stringify({
        kind: "gitlab-comment",
        comment: {
          kind: input.discussions.some((discussion) =>
            discussion.notes.some(
              (note) => note.id === input.payload.object_attributes.id,
            ),
          )
            ? "discussion-comment"
            : "code-review-comment",
          ...(input.discussions.find((discussion) =>
            discussion.notes.some(
              (note) => note.id === input.payload.object_attributes.id,
            ),
          )
            ? {
                discussionId: input.discussions.find((discussion) =>
                  discussion.notes.some(
                    (note) => note.id === input.payload.object_attributes.id,
                  ),
                )!.id,
              }
            : {}),
          commentId: input.payload.object_attributes.id,
        },
      }),
    headSha: "abc123",
    status: "queued" as const,
    payloadJson: JSON.stringify(input.payload),
    retryCount: input.jobRetryCount ?? 0,
    lastError: null,
    enqueuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };

  const transitionClaim = vi.fn(async () => true);
  const storage = {
    stores: {
      platformConnections: {
        get: vi.fn(async () => connection),
      },
      interactionJobs: {
        get: vi.fn(async () => job),
        createInteractionRunForClaim: vi.fn(async () => ({
          id: "run_1",
          interactionJobId: "job_1",
          tenantId: tenant.id,
          provider: "copilot-sdk",
          model: null,
          modelProfileName: null,
          providerBaseUrl: null,
          providerType: null,
          textGenerationModel: null,
          status: "in_progress" as const,
          resultJson: null,
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        })),
        replaceReviewFindingsForClaim: vi.fn(async () => true),
        transitionInteractionRunForClaim: vi.fn(async () => true),
        upsertInteractionRunMetricsForClaim: vi.fn(async () => true),
        transitionClaim,
      },
      discussionMappings: {
        list: vi.fn(async () => []),
      },
      modelProfiles: {
        get: vi.fn(async () => null),
        find: vi.fn(async () => null),
      },
    },
    createOrGetInteractionJob: vi.fn(async () => ({
      job,
      created: true,
    })),
    getInteractionJobById: vi.fn(async () => job),
    listDiscussionMappings: vi.fn(async () => []),
    getModelProfileByName: vi.fn(async () => null),
    getDefaultModelProfile: vi.fn(async () => null),
    getLatestCompletedInteractionForCodeReview: vi.fn(async () => null),
    listPriorReviewFindings: vi.fn(async () => []),
  };
  const loadRoutingContext = vi.fn(async () =>
    wrapGitLabPlatformContext({
      tenant,
      job,
      mergeRequest: {
        id: 1,
        iid: 7,
        project_id: tenant.projectId,
        title: "Add worker",
        description: "Adds the worker",
        web_url: "https://gitlab.example.com/group/project/-/merge_requests/7",
        source_branch: "feature",
        target_branch: "main",
        author: {
          id: 42,
          username: "developer",
          name: "Dev User",
        },
      },
      changes: [],
      notes: [],
      discussions: input.discussions,
      workspace: {
        rootPath: join("tmp", "workspace-routing"),
        cleanupRoot: join("tmp", "cleanup-routing"),
        strategy: "git",
      },
      projectMemory: {
        enabled: true,
        page: null,
        entries: [],
      },
    }),
  );
  const hydrate = vi.fn(async () =>
    wrapGitLabPlatformContext({
      tenant,
      job,
      mergeRequest: {
        id: 1,
        iid: 7,
        project_id: tenant.projectId,
        title: "Add worker",
        description: "Adds the worker",
        web_url: "https://gitlab.example.com/group/project/-/merge_requests/7",
        source_branch: "feature",
        target_branch: "main",
        author: {
          id: 42,
          username: "developer",
          name: "Dev User",
        },
      },
      versions: [],
      latestVersion: null,
      changes: [],
      notes: [],
      discussions: input.discussions,
      workspace: {
        rootPath: join("tmp", "workspace"),
        cleanupRoot: join("tmp", "cleanup"),
        strategy: "targeted-files",
      },
      projectMemory: {
        enabled: true,
        page: null,
        entries: [],
      },
      snapshot: {
        id: "snapshot_1",
        interactionJobId: "job_1",
        tenantId: tenant.id,
        codeReviewId: 7,
        headSha: "abc123",
        codeReviewJson: "{}",
        versionsJson: "[]",
        changesJson: "[]",
        notesJson: "[]",
        discussionsJson: "[]",
        instructionsJson: "[]",
        projectMemoryJson: null,
        workspaceStrategy: "targeted-files",
        createdAt: new Date().toISOString(),
      },
    }),
  );
  const cleanupWorkspace = vi.fn(async () => {});

  const worker = new ReviewWorker({
    storage: storage as never,
    tenantRegistry: {
      getResolvedTenantById: vi.fn(async () => ({ tenant, connection })),
    } as never,
    reviewRuntimeFactory: ({ platform, ...runtimeInput }) =>
      overridePlatformRuntime(platform.createReviewRuntime(runtimeInput), {
        loadRoutingContext,
        hydrate,
        cleanupWorkspace,
      }),
    reviewProviderFactory: {
      createProvider: vi.fn(() => ({
        name: "copilot-sdk",
        review: vi.fn(async () => {
          if (input.reviewError) {
            throw input.reviewError;
          }

          return {
            overview: {
              summary: "Done",
              overallSeverity: "low" as const,
            },
            findings: [],
            priorDispositions: [],
          };
        }),
      })),
    },
    chatterRunnerFactory: {
      createRunner: vi.fn(() => ({
        run: vi.fn(async () => ({
          memory: {
            status: "skipped" as const,
            summary: "No durable memory detected.",
          },
          replies: [],
        })),
      })),
    } as never,
    reconciler: {
      reconcile: vi.fn(async () => ({
        created: 0,
        updated: 0,
        replied: 0,
        resolved: 0,
        skippedResolution: 0,
        kept: 0,
        summaryNoteAction: "created" as const,
      })),
    } as never,
    logger: createLogger("silent"),
    runLogDir: join("tmp", "run-logs"),
    maxJobRetries: 3,
    retryBackoffMs: 5000,
  });
  return { worker, job, transitionClaim };
}
