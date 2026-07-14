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
import {
  CliOutput,
  formatDuration,
  formatKeyValues,
  type OutputMode,
} from "./output.js";

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

export type ReviewWatchEvent =
  | {
      readonly type: "review_submitted";
      readonly jobId: string;
      readonly created: boolean;
      readonly tenantKey: string | null;
      readonly codeReviewId: number | null;
      readonly timestamp: string;
    }
  | {
      readonly type: "job_status";
      readonly jobId: string;
      readonly status: InteractionJobStatus;
      readonly timestamp: string;
    }
  | {
      readonly type: "run_status";
      readonly jobId: string;
      readonly runId: string;
      readonly status: InteractionRunStatus;
      readonly timestamp: string;
    }
  | {
      readonly type: "activity";
      readonly jobId: string;
      readonly runId: string;
      readonly timestamp: string;
      readonly level: string;
      readonly component: string | null;
      readonly action: string | null;
      readonly message: string;
      readonly data?: unknown;
    }
  | {
      readonly type: "review_completed";
      readonly summary: ReviewWatchSummary;
      readonly timestamp: string;
    };

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
  outputMode: OutputMode | "human";
  output?: CliOutput | undefined;
  tenantKey?: string | undefined;
  codeReviewId?: number | undefined;
  signal: AbortSignal;
}): Promise<ReviewWatchSummary> {
  const mode = input.outputMode === "human" ? "pretty" : input.outputMode;
  const output = input.output ?? new CliOutput(mode);
  const renderer = new ReviewWatchRenderer(output, {
    jobId: input.jobId,
    tenantKey: input.tenantKey ?? null,
    codeReviewId: input.codeReviewId ?? null,
  });
  let previousJobStatus: InteractionJobStatus | null = null;
  let previousRunStatus: InteractionRunStatus | null = null;
  let previousRunId: string | null = null;
  let tail = createLogTailState();

  renderer.render({
    type: "review_submitted",
    jobId: input.jobId,
    created: input.created,
    tenantKey: input.tenantKey ?? null,
    codeReviewId: input.codeReviewId ?? null,
    timestamp: output.now().toISOString(),
  });

  try {
    for (;;) {
      throwIfAborted(input.signal);
      const state = await loadReviewWatchState(input.storage, input.jobId);
      if (state.job.status !== previousJobStatus) {
        renderer.render({
          type: "job_status",
          jobId: state.job.id,
          status: state.job.status,
          timestamp: output.now().toISOString(),
        });
        previousJobStatus = state.job.status;
      }
      if (state.run?.id !== previousRunId) {
        previousRunId = state.run?.id ?? null;
        previousRunStatus = null;
        tail = createLogTailState();
      }
      if (state.run && state.run.status !== previousRunStatus) {
        renderer.render({
          type: "run_status",
          jobId: state.job.id,
          runId: state.run.id,
          status: state.run.status,
          timestamp: output.now().toISOString(),
        });
        previousRunStatus = state.run.status;
      }
      if (state.run) {
        await tailRunLog({
          tail,
          path: join(resolve(input.runLogRoot), state.run.id, "app.ndjson"),
          jobId: state.job.id,
          runId: state.run.id,
          renderer,
          output,
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
        renderer.render({
          type: "review_completed",
          summary,
          timestamp: output.now().toISOString(),
        });
        return summary;
      }

      await waitForNextPoll(input.pollIntervalMs, input.signal);
    }
  } finally {
    renderer.close();
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
  jobId: string;
  runId: string;
  renderer: ReviewWatchRenderer;
  output: CliOutput;
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
      input.renderer.render({
        type: "activity",
        jobId: input.jobId,
        runId: input.runId,
        timestamp: entry.timestamp,
        level: entry.level,
        component: entry.component,
        action: entry.action,
        message: entry.message,
        ...(entry.data === undefined ? {} : { data: entry.data }),
      });
    } catch {
      input.output.diagnostic(
        "warning",
        `skipped malformed live log line from ${input.path}.`,
        { path: input.path },
      );
    }
  }
}

function parseLogEntry(line: string): {
  timestamp: string;
  level: string;
  message: string;
  component: string | null;
  action: string | null;
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
  const record = value as Record<string, unknown>;
  const extras = Object.fromEntries(
    Object.entries(record).filter(
      ([key]) =>
        ![
          "timestamp",
          "level",
          "message",
          "component",
          "action",
          "data",
        ].includes(key),
    ),
  );
  const nestedData = "data" in record ? record.data : undefined;
  const data =
    Object.keys(extras).length === 0
      ? nestedData
      : nestedData &&
          typeof nestedData === "object" &&
          !Array.isArray(nestedData)
        ? { ...(nestedData as Record<string, unknown>), ...extras }
        : {
            ...(nestedData === undefined ? {} : { value: nestedData }),
            ...extras,
          };
  const component =
    typeof record.component === "string"
      ? record.component
      : readNestedString(data, "component");
  const action =
    typeof record.action === "string"
      ? record.action
      : readNestedString(data, "action");
  return {
    timestamp: record.timestamp as string,
    level: record.level as string,
    message: record.message as string,
    component,
    action,
    ...(data === undefined ? {} : { data }),
  };
}

function readNestedString(data: unknown, key: string): string | null {
  if (!data || typeof data !== "object" || !(key in data)) {
    return null;
  }
  const nested = (data as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : null;
}

class ReviewWatchRenderer {
  private readonly activities: string[] = [];
  private readonly startedAt: number;
  private jobStatus: InteractionJobStatus = "queued";
  private runId: string | null = null;
  private runStatus: InteractionRunStatus | null = null;
  private paintedLines = 0;
  private cursorHidden = false;

  public constructor(
    private readonly output: CliOutput,
    private readonly identity: {
      readonly jobId: string;
      readonly tenantKey: string | null;
      readonly codeReviewId: number | null;
    },
  ) {
    this.startedAt = output.now().valueOf();
  }

  public render(event: ReviewWatchEvent): void {
    this.apply(event);
    if (this.output.mode === "json") {
      this.output.event(event, "");
      return;
    }
    if (this.output.mode === "plain" || !this.output.stdoutIsTTY) {
      this.output.write(formatReviewEvent(event, this.output));
      return;
    }
    this.repaint(event.type === "review_completed" ? event.summary : undefined);
  }

  public close(): void {
    if (!this.cursorHidden) {
      return;
    }
    this.output.stdout.write("\u001B[?25h");
    this.cursorHidden = false;
  }

  private apply(event: ReviewWatchEvent): void {
    if (event.type === "job_status") {
      this.jobStatus = event.status;
    } else if (event.type === "run_status") {
      this.runId = event.runId;
      this.runStatus = event.status;
    } else if (event.type === "activity") {
      this.activities.push(formatActivity(event, this.output));
      if (this.activities.length > 5) {
        this.activities.shift();
      }
    } else if (event.type === "review_completed") {
      this.jobStatus = event.summary.jobStatus;
      this.runId = event.summary.runId;
      this.runStatus = event.summary.runStatus;
    }
  }

  private repaint(summary?: ReviewWatchSummary): void {
    if (!this.cursorHidden) {
      this.output.stdout.write("\u001B[?25l");
      this.cursorHidden = true;
    }
    if (this.paintedLines > 0) {
      this.output.stdout.write(`\u001B[${this.paintedLines}F`);
    }
    const elapsed = Math.max(0, this.output.now().valueOf() - this.startedAt);
    const lines = [
      this.output.style(
        summary
          ? summary.jobStatus === "completed"
            ? "success"
            : "failure"
          : "active",
        summary ? `Review ${summary.jobStatus}` : "Review in progress",
      ),
      formatKeyValues(
        [
          ["tenant", this.identity.tenantKey],
          ["review", this.identity.codeReviewId],
          [
            "job",
            `${this.identity.jobId} (${this.styleStatus(this.jobStatus)})`,
          ],
          [
            "run",
            this.runId
              ? `${this.runId} (${this.styleStatus(this.runStatus ?? "unknown")})`
              : null,
          ],
          ["elapsed", formatDuration(elapsed)],
        ],
        "~",
        {
          label: (value) => this.output.style("muted", value),
          null: (value) => this.output.style("muted", value),
        },
      ),
      ...(this.activities.length > 0
        ? [
            "",
            this.output.style("heading", "Latest activity"),
            ...this.activities,
          ]
        : []),
      ...(summary
        ? [
            "",
            this.output.style(
              summary.error ? "failure" : "strong",
              `${summary.findingCount} finding(s)${summary.error ? `; error: ${summary.error}` : ""}`,
            ),
          ]
        : []),
    ];
    const text = lines.join("\n");
    const clear = Array.from(
      { length: Math.max(this.paintedLines, lines.length) },
      (_, index) => `\u001B[2K${index === 0 ? "" : "\u001B[1E"}`,
    ).join("");
    if (this.paintedLines > 0) {
      this.output.stdout.write(clear);
      this.output.stdout.write(
        `\u001B[${Math.max(this.paintedLines, lines.length) - 1}F`,
      );
    }
    this.output.stdout.write(`${text}\n`);
    this.paintedLines = lines.length;
  }

  private styleStatus(value: string): string {
    if (["completed", "ready"].includes(value)) {
      return this.output.style("success", value);
    }
    if (["failed", "cancelled", "expired"].includes(value)) {
      return this.output.style("failure", value);
    }
    return this.output.style("active", value);
  }
}

function formatReviewEvent(event: ReviewWatchEvent, output: CliOutput): string {
  switch (event.type) {
    case "review_submitted":
      return output.style(
        "active",
        `Review job ${event.jobId} ${event.created ? "submitted" : "reused"}.`,
      );
    case "job_status":
      return event.status === "queued"
        ? `${output.style("strong", `Job ${event.jobId}`)}: ${output.style("warning", "queued")}; waiting for an external runner connected to the same storage backend.`
        : `${output.style("strong", `Job ${event.jobId}`)}: ${styleEventStatus(output, event.status)}`;
    case "run_status":
      return `${output.style("strong", `Run ${event.runId}`)}: ${styleEventStatus(output, event.status)}`;
    case "activity":
      return `${output.style("muted", event.timestamp)} ${styleLogLevel(output, event.level)} ${formatActivity(event, output)}`;
    case "review_completed":
      return [
        output.style(
          event.summary.jobStatus === "completed" ? "success" : "failure",
          `Review ${event.summary.jobStatus}: ${event.summary.findingCount} finding(s)${
            event.summary.runId ? ` in run ${event.summary.runId}` : ""
          }.`,
        ),
        ...(event.summary.error
          ? [output.style("failure", `Error: ${event.summary.error}`)]
          : []),
        ...(event.summary.jobStatus === "expired"
          ? [
              output.style(
                "warning",
                "The job exceeded the configured maximum queued age.",
              ),
            ]
          : []),
      ].join("\n");
  }
}

function formatActivity(
  event: Extract<ReviewWatchEvent, { type: "activity" }>,
  output?: CliOutput,
): string {
  const details = formatSafeDetails(event.data);
  const component = event.component
    ? `${output?.style("strong", event.component) ?? event.component}: `
    : "";
  return `${component}${event.message}${
    event.action ? ` (${event.action})` : ""
  }${details ? ` — ${details}` : ""}`;
}

function styleEventStatus(output: CliOutput, status: string): string {
  if (status === "completed") {
    return output.style("success", status);
  }
  if (["failed", "cancelled", "expired"].includes(status)) {
    return output.style("failure", status);
  }
  return output.style("active", status);
}

function styleLogLevel(output: CliOutput, level: string): string {
  const normalized = level.toLowerCase();
  const semantic = ["error", "fatal"].includes(normalized)
    ? "failure"
    : normalized === "warn"
      ? "warning"
      : normalized === "debug" || normalized === "trace"
        ? "muted"
        : "active";
  return output.style(semantic, level.toUpperCase());
}

function formatSafeDetails(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "";
  }
  return Object.entries(data as Record<string, unknown>)
    .filter(
      ([key, value]) =>
        !["component", "action"].includes(key) && isScalar(value),
    )
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null || ["string", "number", "boolean"].includes(typeof value)
  );
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
