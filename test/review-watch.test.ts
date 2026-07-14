import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ReviewWatchAbortedError,
  buildReviewWatchSummary,
  selectReviewAttempt,
  watchReviewJob,
} from "../src/cli/review-watch.js";
import { CliOutput, createStringWriter } from "../src/cli/output.js";
import type {
  InteractionJobRecord,
  InteractionRunRecord,
} from "../src/storage/contract/index.js";

describe("review job watcher", () => {
  it("selects attempts by active claim and latest run while queued", () => {
    const first = createRun("run_1", "claim_1", "2026-07-12T08:00:00.000Z");
    const second = createRun("run_2", "claim_2", "2026-07-12T09:00:00.000Z");

    expect(
      selectReviewAttempt(
        createJob({
          status: "in_progress",
          claimToken: "claim_2",
          latestInteractionRunId: "run_1",
        }),
        [first, second],
      )?.id,
    ).toBe("run_2");
    expect(
      selectReviewAttempt(
        createJob({
          status: "queued",
          claimToken: null,
          latestInteractionRunId: "run_1",
        }),
        [first, second],
      )?.id,
    ).toBe("run_1");
  });

  it("observes external transitions, tails logs, and counts selected findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-watch-"));
    const runDirectory = join(root, "run_2");
    await mkdir(runDirectory);
    await writeFile(
      join(runDirectory, "app.ndjson"),
      `${JSON.stringify({
        timestamp: "2026-07-12T09:00:00.000Z",
        level: "info",
        message: "review started",
        data: { attempt: 2 },
      })}\nmalformed\n`,
      "utf8",
    );
    let poll = 0;
    let currentJob = createJob();
    const run = createRun("run_2", "claim_2", "2026-07-12T09:00:00.000Z");
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const warnings = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const storage = {
      stores: {
        interactionJobs: {
          get: async () => {
            poll += 1;
            currentJob =
              poll === 1
                ? createJob()
                : poll === 2
                  ? createJob({
                      status: "in_progress",
                      claimToken: "claim_2",
                    })
                  : createJob({
                      status: "completed",
                      claimToken: null,
                      latestInteractionRunId: "run_2",
                    });
            return currentJob;
          },
        },
        interactionRuns: {
          list: async () =>
            currentJob.status === "queued"
              ? []
              : [
                  {
                    ...run,
                    status:
                      currentJob.status === "completed"
                        ? "completed"
                        : "in_progress",
                  },
                ],
        },
        reviewFindings: {
          list: async () => [{ id: "finding_1" }, { id: "finding_2" }],
        },
      },
    };

    const summary = await watchReviewJob({
      storage: storage as never,
      jobId: "job_1",
      created: true,
      runLogRoot: root,
      pollIntervalMs: 1,
      outputMode: "human",
      signal: new AbortController().signal,
    });

    expect(summary).toEqual(
      expect.objectContaining({
        jobStatus: "completed",
        runId: "run_2",
        runStatus: "completed",
        findingCount: 2,
        liveLogsAvailable: true,
      }),
    );
    expect(output.mock.calls.join("")).toContain(
      "waiting for an external runner",
    );
    expect(output.mock.calls.join("")).toContain(
      "INFO review started — attempt=2",
    );
    expect(warnings.mock.calls.join("")).toContain("malformed live log line");
  });

  it("waits for the selected run to settle after the job is terminal", async () => {
    let runPoll = 0;
    const job = createJob({
      status: "completed",
      latestInteractionRunId: "run_1",
    });
    const storage = {
      stores: {
        interactionJobs: { get: async () => job },
        interactionRuns: {
          list: async () => {
            runPoll += 1;
            return [
              {
                ...createRun("run_1", "claim_1", "2026-07-12T09:00:00.000Z"),
                status: runPoll === 1 ? "in_progress" : "completed",
              },
            ];
          },
        },
        reviewFindings: {
          list: vi.fn(async (options) => {
            expect(options.filters.interactionRunId.eq).toBe("run_1");
            return [{ id: "finding_1" }];
          }),
        },
      },
    };

    let jsonl = "";
    const summary = await watchReviewJob({
      storage: storage as never,
      jobId: "job_1",
      created: false,
      runLogRoot: "missing-run-logs",
      pollIntervalMs: 1,
      outputMode: "json",
      output: new CliOutput("json", {
        stdout: createStringWriter((text) => (jsonl += text)),
      }),
      signal: new AbortController().signal,
    });

    expect(runPoll).toBeGreaterThanOrEqual(2);
    expect(summary).toMatchObject({
      jobStatus: "completed",
      runStatus: "completed",
      findingCount: 1,
      liveLogsAvailable: false,
    });
    const events = jsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual([
      "review_submitted",
      "job_status",
      "run_status",
      "run_status",
      "review_completed",
    ]);
  });

  it("summarizes expiration before a first run", async () => {
    const storage = {
      stores: {
        interactionJobs: {
          get: async () =>
            createJob({
              status: "expired",
              lastError: "maximum queued age exceeded",
            }),
        },
        interactionRuns: { list: async () => [] },
        reviewFindings: { list: vi.fn() },
      },
    };

    const summary = await buildReviewWatchSummary({
      storage: storage as never,
      jobId: "job_1",
      created: true,
      runLogRoot: "run-logs",
    });

    expect(summary).toMatchObject({
      jobStatus: "expired",
      runId: null,
      runStatus: null,
      runLogDirectory: null,
      findingCount: 0,
      error: "maximum queued age exceeded",
      liveLogsAvailable: false,
    });
    expect(storage.stores.reviewFindings.list).not.toHaveBeenCalled();
  });

  it("restores the cursor and leaves a final summary in pretty TTY mode", async () => {
    const storage = {
      stores: {
        interactionJobs: {
          get: async () =>
            createJob({
              status: "completed",
              latestInteractionRunId: null,
            }),
        },
        interactionRuns: { list: async () => [] },
        reviewFindings: { list: vi.fn() },
      },
    };
    let terminal = "";
    const summary = await watchReviewJob({
      storage: storage as never,
      jobId: "job_1",
      created: true,
      runLogRoot: "run-logs",
      pollIntervalMs: 1,
      outputMode: "pretty",
      output: new CliOutput("pretty", {
        stdout: createStringWriter((text) => (terminal += text)),
        stdoutIsTTY: true,
        color: true,
        now: () => new Date("2026-07-12T09:00:00.000Z"),
      }),
      tenantKey: "https://gitlab.example.com::123",
      codeReviewId: 7,
      signal: new AbortController().signal,
    });

    expect(summary.jobStatus).toBe("completed");
    expect(terminal).toContain("\u001B[?25l");
    expect(terminal).toContain("\u001B[?25h");
    expect(terminal).toContain("Review completed");
    expect(terminal).toContain("0 finding(s)");
  });

  it("fails on a missing referenced run and aborts polling without mutation", async () => {
    const get = vi.fn(async () =>
      createJob({
        latestInteractionRunId: "missing-run",
      }),
    );
    const storage = {
      stores: {
        interactionJobs: { get },
        interactionRuns: { list: async () => [] },
        reviewFindings: { list: vi.fn() },
      },
    };
    await expect(
      buildReviewWatchSummary({
        storage: storage as never,
        jobId: "job_1",
        created: false,
        runLogRoot: "run-logs",
      }),
    ).rejects.toThrow("references missing run missing-run");

    const controller = new AbortController();
    const queuedStorage = {
      stores: {
        interactionJobs: { get: async () => createJob() },
        interactionRuns: { list: async () => [] },
        reviewFindings: { list: vi.fn() },
      },
    };
    const watching = watchReviewJob({
      storage: queuedStorage as never,
      jobId: "job_1",
      created: true,
      runLogRoot: "run-logs",
      pollIntervalMs: 60_000,
      outputMode: "json",
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();

    await expect(watching).rejects.toBeInstanceOf(ReviewWatchAbortedError);
    expect(queuedStorage.stores.reviewFindings.list).not.toHaveBeenCalled();
  });
});

function createJob(
  overrides: Partial<InteractionJobRecord> = {},
): InteractionJobRecord {
  return {
    id: "job_1",
    tenantId: "tenant_1",
    dedupeKey: "dedupe",
    codeReviewId: 7,
    commentId: null,
    triggerJson: "{}",
    headSha: "abc",
    status: "queued",
    payloadJson: "{}",
    retryCount: 0,
    lastError: null,
    enqueuedAt: "2026-07-12T08:00:00.000Z",
    availableAt: "2026-07-12T08:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    claimToken: null,
    claimedBy: null,
    claimExpiresAt: null,
    latestInteractionRunId: null,
    ...overrides,
  };
}

function createRun(
  id: string,
  interactionJobClaimToken: string,
  startedAt: string,
): InteractionRunRecord {
  return {
    id,
    interactionJobId: "job_1",
    interactionJobClaimToken,
    tenantId: "tenant_1",
    provider: "copilot",
    model: null,
    modelProfileName: null,
    providerBaseUrl: null,
    providerType: null,
    textGenerationModel: null,
    reviewReasoningEffort: null,
    textGenerationReasoningEffort: null,
    status: "in_progress",
    resultJson: null,
    error: null,
    startedAt,
    finishedAt: null,
  };
}
