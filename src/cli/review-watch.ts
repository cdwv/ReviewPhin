import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type {
  InteractionJobRecord,
  InteractionJobStatus,
  InteractionRunRecord,
  InteractionRunStatus,
} from "../storage/contract/index.js";
import { listAll, type StorageHelpers } from "../storage/storage-helpers.js";

const TERMINAL_JOB_STATUSES = new Set<InteractionJobStatus>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
const TERMINAL_RUN_STATUSES = new Set<InteractionRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export interface ReviewWatchSummary {
  jobId: string;
  created: boolean;
  jobStatus: InteractionJobStatus;
  runId: string | null;
  runStatus: InteractionRunStatus | null;
  runLogDirectory: string | null;
  findingCount: number;
  error: string | null;
  liveLogsAvailable: boolean;
}

export class ReviewWatchAbortedError extends Error {
  public constructor() {
    super("Review watch aborted.");
    this.name = "ReviewWatchAbortedError";
  }
}

export function selectReviewAttempt(
  job: InteractionJobRecord,
  runs: readonly InteractionRunRecord[],
): InteractionRunRecord | null {
  if (job.status === "in_progress") {
    if (!job.claimToken) {
      return null;
    }
    return (
      runs
        .filter((run) => run.interactionJobClaimToken === job.claimToken)
        .sort(compareRunsNewestFirst)[0] ?? null
    );
  }

  if (!job.latestInteractionRunId) {
    return null;
  }
  const selected =
    runs.find((run) => run.id === job.latestInteractionRunId) ?? null;
  if (!selected) {
    throw new Error(
      `Storage consistency error: interaction job ${job.id} references missing run ${job.latestInteractionRunId}.`,
    );
  }
  return selected;
}

export async function buildReviewWatchSummary(input: {
  storage: StorageHelpers;
  jobId: string;
  created: boolean;
  runLogRoot: string;
  liveLogsAvailable?: boolean | undefined;
}): Promise<ReviewWatchSummary> {
  const state = await loadReviewWatchState(input.storage, input.jobId);
  return summarizeReviewWatchState({
    ...input,
    ...state,
    liveLogsAvailable: input.liveLogsAvailable ?? false,
  });
}

export async function watchReviewJob(input: {
  storage: StorageHelpers;
  jobId: string;
  created: boolean;
  runLogRoot: string;
  pollIntervalMs: number;
  outputMode: "human" | "json";
  signal: AbortSignal;
}): Promise<ReviewWatchSummary> {
  let previousJobStatus: InteractionJobStatus | null = null;
  let previousRunStatus: InteractionRunStatus | null = null;
  let previousRunId: string | null = null;
  let tail = createLogTailState();

  for (;;) {
    throwIfAborted(input.signal);
    const state = await loadReviewWatchState(input.storage, input.jobId);
    if (
      input.outputMode === "human" &&
      state.job.status !== previousJobStatus
    ) {
      printJobStatus(state.job);
      previousJobStatus = state.job.status;
    }
    if (state.run?.id !== previousRunId) {
      previousRunId = state.run?.id ?? null;
      previousRunStatus = null;
      tail = createLogTailState();
    }
    if (
      input.outputMode === "human" &&
      state.run &&
      state.run.status !== previousRunStatus
    ) {
      process.stdout.write(`Run ${state.run.id}: ${state.run.status}\n`);
      previousRunStatus = state.run.status;
    }
    if (state.run) {
      await tailRunLog({
        tail,
        path: join(resolve(input.runLogRoot), state.run.id, "app.ndjson"),
        outputMode: input.outputMode,
      });
    }

    const jobTerminal = TERMINAL_JOB_STATUSES.has(state.job.status);
    const runSettled =
      state.run === null || TERMINAL_RUN_STATUSES.has(state.run.status);
    if (jobTerminal && runSettled) {
      const summary = await summarizeReviewWatchState({
        storage: input.storage,
        jobId: input.jobId,
        created: input.created,
        runLogRoot: input.runLogRoot,
        job: state.job,
        run: state.run,
        liveLogsAvailable: tail.liveLogsAvailable,
      });
      printFinalSummary(summary, input.outputMode);
      return summary;
    }

    await waitForNextPoll(input.pollIntervalMs, input.signal);
  }
}

async function loadReviewWatchState(
  storage: StorageHelpers,
  jobId: string,
): Promise<{
  job: InteractionJobRecord;
  run: InteractionRunRecord | null;
}> {
  const job = await storage.stores.interactionJobs.get(jobId);
  if (!job) {
    throw new Error(`Interaction job ${jobId} was not found in storage.`);
  }
  const runs = await listAll(storage.stores.interactionRuns, {
    filters: { interactionJobId: { eq: jobId } },
    order: [
      { field: "startedAt", direction: "desc" },
      { field: "id", direction: "desc" },
    ],
  });
  return { job, run: selectReviewAttempt(job, runs) };
}

async function summarizeReviewWatchState(input: {
  storage: StorageHelpers;
  jobId: string;
  created: boolean;
  runLogRoot: string;
  job: InteractionJobRecord;
  run: InteractionRunRecord | null;
  liveLogsAvailable: boolean;
}): Promise<ReviewWatchSummary> {
  const findings = input.run
    ? await listAll(input.storage.stores.reviewFindings, {
        filters: { interactionRunId: { eq: input.run.id } },
      })
    : [];
  const runLogDirectory = input.run
    ? resolveRunLogDirectory(input.runLogRoot, input.run.id)
    : null;
  return {
    jobId: input.jobId,
    created: input.created,
    jobStatus: input.job.status,
    runId: input.run?.id ?? null,
    runStatus: input.run?.status ?? null,
    runLogDirectory,
    findingCount: findings.length,
    error: input.job.lastError ?? input.run?.error ?? null,
    liveLogsAvailable: input.liveLogsAvailable,
  };
}

interface LogTailState {
  byteOffset: number;
  bufferedText: string;
  decoder: StringDecoder;
  liveLogsAvailable: boolean;
}

function createLogTailState(): LogTailState {
  return {
    byteOffset: 0,
    bufferedText: "",
    decoder: new StringDecoder("utf8"),
    liveLogsAvailable: false,
  };
}

async function tailRunLog(input: {
  tail: LogTailState;
  path: string;
  outputMode: "human" | "json";
}): Promise<void> {
  let file;
  try {
    file = await open(input.path, "r");
    input.tail.liveLogsAvailable = true;
  } catch (error) {
    if (isUnavailableLogError(error)) {
      return;
    }
    throw error;
  }

  let chunk: Buffer;
  try {
    const { size } = await file.stat();
    if (size < input.tail.byteOffset) {
      input.tail.byteOffset = 0;
      input.tail.bufferedText = "";
      input.tail.decoder = new StringDecoder("utf8");
    }
    if (size === input.tail.byteOffset) {
      return;
    }

    chunk = Buffer.allocUnsafe(size - input.tail.byteOffset);
    let totalBytesRead = 0;
    while (totalBytesRead < chunk.length) {
      const { bytesRead } = await file.read(
        chunk,
        totalBytesRead,
        chunk.length - totalBytesRead,
        input.tail.byteOffset + totalBytesRead,
      );
      if (bytesRead === 0) {
        break;
      }
      totalBytesRead += bytesRead;
    }
    chunk = chunk.subarray(0, totalBytesRead);
    input.tail.byteOffset += totalBytesRead;
  } finally {
    await file.close();
  }

  if (chunk.length === 0) {
    return;
  }
  input.tail.bufferedText += input.tail.decoder.write(chunk);
  const lines = input.tail.bufferedText.split(/\r?\n/);
  input.tail.bufferedText = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const entry = parseLogEntry(line);
      if (input.outputMode === "human") {
        const data =
          entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`;
        process.stdout.write(
          `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.message}${data}\n`,
        );
      }
    } catch {
      process.stderr.write(
        `Warning: skipped malformed live log line from ${input.path}.\n`,
      );
    }
  }
}

function parseLogEntry(line: string): {
  timestamp: string;
  level: string;
  message: string;
  data?: unknown;
} {
  const value: unknown = JSON.parse(line);
  if (
    !value ||
    typeof value !== "object" ||
    !("timestamp" in value) ||
    typeof value.timestamp !== "string" ||
    !("level" in value) ||
    typeof value.level !== "string" ||
    !("message" in value) ||
    typeof value.message !== "string"
  ) {
    throw new Error("Invalid live log entry.");
  }
  return {
    timestamp: value.timestamp,
    level: value.level,
    message: value.message,
    ...("data" in value ? { data: value.data } : {}),
  };
}

function printJobStatus(job: InteractionJobRecord): void {
  if (job.status === "queued") {
    process.stdout.write(
      `Job ${job.id}: queued; waiting for an external runner connected to the same storage backend.\n`,
    );
    return;
  }
  process.stdout.write(`Job ${job.id}: ${job.status}\n`);
}

function printFinalSummary(
  summary: ReviewWatchSummary,
  outputMode: "human" | "json",
): void {
  if (outputMode === "json") {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }
  process.stdout.write(
    `Review ${summary.jobStatus}: ${summary.findingCount} finding(s)${
      summary.runId ? ` in run ${summary.runId}` : ""
    }.\n`,
  );
  if (summary.error) {
    process.stdout.write(`Error: ${summary.error}\n`);
  }
  if (summary.jobStatus === "expired") {
    process.stdout.write(
      "The job exceeded the configured maximum queued age.\n",
    );
  }
}

function resolveRunLogDirectory(runLogRoot: string, runId: string): string {
  const root = isAbsolute(runLogRoot) ? runLogRoot : resolve(runLogRoot);
  return resolve(root, runId);
}

function compareRunsNewestFirst(
  left: InteractionRunRecord,
  right: InteractionRunRecord,
): number {
  return (
    right.startedAt.localeCompare(left.startedAt) ||
    right.id.localeCompare(left.id)
  );
}

function waitForNextPoll(
  pollIntervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, pollIntervalMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new ReviewWatchAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ReviewWatchAbortedError();
  }
}

function isUnavailableLogError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "EACCES", "EPERM", "EISDIR"].includes(String(error.code))
  );
}
