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
  type OutputMode,
  type TextStyle,
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
  renderer.refresh();

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
      renderer.setLiveLogsAvailable(tail.liveLogsAvailable);

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
        renderer.refresh();
        return summary;
      }

      renderer.refresh();
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
  private readonly activities: Extract<
    ReviewWatchEvent,
    { type: "activity" }
  >[] = [];
  private readonly startedAt: number;
  private jobStatus: InteractionJobStatus = "queued";
  private runId: string | null = null;
  private runStatus: InteractionRunStatus | null = null;
  private liveLogsAvailable = false;
  private summary: ReviewWatchSummary | null = null;
  private hasPainted = false;
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
    }
  }

  public refresh(): void {
    if (this.output.mode !== "pretty" || !this.output.stdoutIsTTY) {
      return;
    }
    this.repaint();
  }

  public setLiveLogsAvailable(available: boolean): void {
    this.liveLogsAvailable = available;
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
      this.activities.push(event);
      if (this.activities.length > DASHBOARD_ACTIVITY_EVENTS) {
        this.activities.shift();
      }
    } else if (event.type === "review_completed") {
      this.jobStatus = event.summary.jobStatus;
      this.runId = event.summary.runId;
      this.runStatus = event.summary.runStatus;
      this.summary = event.summary;
    }
  }

  private repaint(): void {
    if (!this.cursorHidden) {
      this.output.stdout.write("\u001B[?25l");
      this.cursorHidden = true;
    }
    if (this.hasPainted) {
      this.output.stdout.write("\u001B[u");
      this.output.stdout.write("\u001B[J");
    } else {
      this.output.stdout.write("\u001B[s");
    }
    const elapsed = Math.max(0, this.output.now().valueOf() - this.startedAt);
    const lines = formatReviewDashboard({
      output: this.output,
      identity: this.identity,
      jobStatus: this.jobStatus,
      runId: this.runId,
      runStatus: this.runStatus,
      activities: this.activities,
      summary: this.summary,
      liveLogsAvailable: this.liveLogsAvailable,
      elapsed,
    });
    this.output.stdout.write(`${lines.join("\n")}\n`);
    this.hasPainted = true;
  }
}

const DASHBOARD_ACTIVITY_EVENTS = 5;

interface DashboardSegment {
  readonly text: string;
  readonly style?: TextStyle | undefined;
}

interface DashboardField {
  readonly label: string;
  readonly value: string;
  readonly valueStyle?: TextStyle | undefined;
}

interface DashboardBox {
  readonly topLeft: string;
  readonly topRight: string;
  readonly sectionLeft: string;
  readonly sectionRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
}

function formatReviewDashboard(input: {
  output: CliOutput;
  identity: {
    readonly jobId: string;
    readonly tenantKey: string | null;
    readonly codeReviewId: number | null;
  };
  jobStatus: InteractionJobStatus;
  runId: string | null;
  runStatus: InteractionRunStatus | null;
  activities: readonly Extract<ReviewWatchEvent, { type: "activity" }>[];
  summary: ReviewWatchSummary | null;
  liveLogsAvailable: boolean;
  elapsed: number;
}): string[] {
  const width = input.output.columns;
  const box = dashboardBox(input.output.unicode);
  const contentWidth = dashboardContentWidth(box, width);
  const overallStatus = input.summary?.jobStatus ?? input.jobStatus;
  const findingCount =
    input.summary === null
      ? input.output.unicode
        ? "—"
        : "-"
      : String(input.summary.findingCount);
  const activityRows = formatDashboardActivities(
    input.activities,
    input.summary,
    contentWidth,
    input.output.unicode,
  );
  const activityStatus =
    input.liveLogsAvailable || input.summary?.liveLogsAvailable
      ? "Live"
      : input.summary
        ? "Unavailable"
        : "Waiting";
  const statusFields: DashboardField[] = [
    {
      label: "Status",
      value: `${input.output.unicode ? "●" : "*"} ${statusLabel(overallStatus)}`,
      valueStyle: statusStyle(overallStatus),
    },
    {
      label: "Elapsed",
      value: formatDuration(input.elapsed),
      valueStyle: "strong",
    },
    {
      label: "Job",
      value: statusLabel(input.jobStatus),
      valueStyle: statusStyle(input.jobStatus),
    },
    {
      label: "Run",
      value: input.runStatus ? statusLabel(input.runStatus) : "Waiting",
      valueStyle: input.runStatus ? statusStyle(input.runStatus) : "muted",
    },
    {
      label: "Findings",
      value: findingCount,
      valueStyle: input.summary ? "strong" : "muted",
    },
    {
      label: "Activity",
      value: activityStatus,
      valueStyle: activityStatus === "Live" ? "active" : "muted",
    },
  ];
  const identityFields: DashboardField[] = [
    {
      label: "Review",
      value:
        input.identity.codeReviewId === null
          ? "~"
          : String(input.identity.codeReviewId),
      valueStyle: input.identity.codeReviewId === null ? "muted" : "strong",
    },
    {
      label: "Tenant",
      value: input.identity.tenantKey ?? "~",
      valueStyle: input.identity.tenantKey === null ? "muted" : "strong",
    },
    {
      label: "Job",
      value: input.identity.jobId,
      valueStyle: "strong",
    },
    {
      label: "Run",
      value: input.runId ?? "waiting for first attempt",
      valueStyle: input.runId === null ? "muted" : "strong",
    },
  ];

  return [
    dashboardRule(input.output, box, width, "top", "REVIEW WATCH"),
    ...dashboardGridLines(input.output, box, width, statusFields),
    dashboardFieldLine(input.output, box, width, dashboardStatusNote(input)),
    dashboardRule(input.output, box, width, "section", "IDENTITY"),
    ...identityFields.map((field) =>
      dashboardFieldLine(input.output, box, width, field),
    ),
    dashboardRule(input.output, box, width, "section", "LATEST ACTIVITY"),
    ...activityRows.map((segments) =>
      dashboardLine(input.output, box, width, segments),
    ),
    dashboardRule(input.output, box, width, "bottom"),
  ];
}

function formatDashboardActivities(
  activities: readonly Extract<ReviewWatchEvent, { type: "activity" }>[],
  summary: ReviewWatchSummary | null,
  contentWidth: number,
  unicode: boolean,
): DashboardSegment[][] {
  if (activities.length === 0) {
    const message =
      summary && !summary.liveLogsAvailable
        ? "Live logs unavailable; persisted status is still authoritative."
        : summary
          ? "No live activity messages were emitted."
          : "Waiting for live review activity…";
    return [[{ text: message, style: "muted" }]];
  }
  return activities.flatMap((event) =>
    formatDashboardActivity(event, contentWidth, unicode),
  );
}

function formatDashboardActivity(
  event: Extract<ReviewWatchEvent, { type: "activity" }>,
  contentWidth: number,
  unicode: boolean,
): DashboardSegment[][] {
  const level = event.level.toUpperCase();
  const details = formatSafeDetails(event.data);
  const prefix: DashboardSegment[] = [];
  if (contentWidth >= 38) {
    prefix.push({
      text: `${formatActivityTime(event.timestamp)} `,
      style: "muted",
    });
  }
  prefix.push({
    text: `${level.padEnd(5)} `,
    style: logLevelStyle(event.level),
  });
  if (event.component && contentWidth >= 70) {
    prefix.push({
      text: `${fitDashboardText(
        sanitizeDashboardText(event.component),
        18,
        unicode,
      )} `,
      style: "strong",
    });
  }
  const prefixWidth = prefix.reduce(
    (width, segment) => width + terminalTextWidth(segment.text),
    0,
  );
  const message = sanitizeDashboardText(
    `${event.message}${
      event.action ? ` (${event.action})` : ""
    }${details ? ` — ${details}` : ""}`,
  ).trim();
  const messageWidth = Math.max(1, contentWidth - prefixWidth);
  const wrapped = wrapDashboardText(message, messageWidth);
  return wrapped.map((line, index) =>
    index === 0
      ? [...prefix, { text: line }]
      : [{ text: " ".repeat(prefixWidth), style: "muted" }, { text: line }],
  );
}

function dashboardStatusNote(input: {
  jobStatus: InteractionJobStatus;
  runId: string | null;
  activities: readonly Extract<ReviewWatchEvent, { type: "activity" }>[];
  summary: ReviewWatchSummary | null;
}): DashboardField {
  if (input.summary?.error) {
    return {
      label: "Error",
      value: input.summary.error,
      valueStyle: "failure",
    };
  }
  if (input.jobStatus === "queued") {
    return {
      label: "Note",
      value: "Waiting for a runner connected to this storage backend.",
      valueStyle: "warning",
    };
  }
  if (input.summary) {
    return {
      label: "Note",
      value: `Review finished with ${input.summary.findingCount} finding(s).`,
      valueStyle:
        input.summary.jobStatus === "completed" ? "success" : "failure",
    };
  }
  if (input.runId === null) {
    return {
      label: "Note",
      value: "Waiting for the first review attempt to start.",
      valueStyle: "muted",
    };
  }
  return {
    label: "Note",
    value:
      input.activities.length === 0
        ? "Following persisted state; live activity appears when logs are shared."
        : "Following persisted state and live runner activity.",
    valueStyle: "muted",
  };
}

function dashboardBox(unicode: boolean): DashboardBox {
  return unicode
    ? {
        topLeft: "╭",
        topRight: "╮",
        sectionLeft: "├",
        sectionRight: "┤",
        bottomLeft: "╰",
        bottomRight: "╯",
        horizontal: "─",
        vertical: "│",
      }
    : {
        topLeft: "+",
        topRight: "+",
        sectionLeft: "+",
        sectionRight: "+",
        bottomLeft: "+",
        bottomRight: "+",
        horizontal: "-",
        vertical: "|",
      };
}

function dashboardContentWidth(box: DashboardBox, width: number): number {
  const horizontalPadding = width >= 4 ? 1 : 0;
  return Math.max(
    0,
    width - terminalTextWidth(box.vertical) * 2 - horizontalPadding * 2,
  );
}

function dashboardGridLines(
  output: CliOutput,
  box: DashboardBox,
  width: number,
  fields: readonly DashboardField[],
): string[] {
  const contentWidth = dashboardContentWidth(box, width);
  const columnCount = contentWidth >= 64 ? 2 : 1;
  const columnGap = columnCount === 2 ? 4 : 0;
  const columnWidth = Math.floor(
    (contentWidth - columnGap * (columnCount - 1)) / columnCount,
  );
  const lines: string[] = [];
  for (let index = 0; index < fields.length; index += columnCount) {
    const segments: DashboardSegment[] = [];
    for (let column = 0; column < columnCount; column += 1) {
      const field = fields[index + column];
      if (field) {
        segments.push(...dashboardFieldSegments(output, field, columnWidth));
      } else {
        segments.push({ text: " ".repeat(columnWidth) });
      }
      if (column < columnCount - 1) {
        segments.push({ text: " ".repeat(columnGap) });
      }
    }
    lines.push(dashboardLine(output, box, width, segments));
  }
  return lines;
}

function dashboardFieldLine(
  output: CliOutput,
  box: DashboardBox,
  width: number,
  field: DashboardField,
): string {
  return dashboardLine(
    output,
    box,
    width,
    dashboardFieldSegments(output, field, dashboardContentWidth(box, width)),
  );
}

function dashboardFieldSegments(
  output: CliOutput,
  field: DashboardField,
  width: number,
): DashboardSegment[] {
  const labelWidth = Math.min(10, Math.max(5, Math.floor(width / 3)));
  const fittedLabel = fitDashboardText(
    sanitizeDashboardText(field.label),
    labelWidth,
    output.unicode,
  );
  const valueWidth = Math.max(0, width - labelWidth);
  const cleanValue = sanitizeDashboardText(field.value);
  const fittedValue = fitDashboardText(cleanValue, valueWidth, output.unicode);
  const trailingWidth = Math.max(
    0,
    valueWidth - terminalTextWidth(fittedValue),
  );
  return [
    {
      text: `${fittedLabel}${" ".repeat(
        Math.max(0, labelWidth - terminalTextWidth(fittedLabel)),
      )}`,
      style: "muted",
    },
    { text: fittedValue, style: field.valueStyle },
    { text: " ".repeat(trailingWidth) },
  ];
}

function dashboardRule(
  output: CliOutput,
  box: DashboardBox,
  width: number,
  kind: "top" | "section" | "bottom",
  label?: string,
): string {
  const left =
    kind === "top"
      ? box.topLeft
      : kind === "bottom"
        ? box.bottomLeft
        : box.sectionLeft;
  const right =
    kind === "top"
      ? box.topRight
      : kind === "bottom"
        ? box.bottomRight
        : box.sectionRight;
  const available = Math.max(0, width - terminalTextWidth(left + right));
  if (!label) {
    return output.style(
      "muted",
      `${left}${box.horizontal.repeat(available)}${right}`,
    );
  }
  const fittedLabel = fitDashboardText(
    label,
    Math.max(0, available - 3),
    output.unicode,
  );
  const prefix = `${left}${box.horizontal} `;
  const used = terminalTextWidth(prefix + fittedLabel);
  const suffixWidth = Math.max(
    0,
    width - used - terminalTextWidth(` ${right}`),
  );
  return `${output.style("muted", prefix)}${output.style(
    "heading",
    fittedLabel,
  )}${output.style("muted", ` ${box.horizontal.repeat(suffixWidth)}${right}`)}`;
}

function dashboardLine(
  output: CliOutput,
  box: DashboardBox,
  width: number,
  segments: readonly DashboardSegment[],
): string {
  const horizontalPadding = width >= 4 ? 1 : 0;
  const innerWidth = Math.max(
    0,
    width - terminalTextWidth(box.vertical) * 2 - horizontalPadding * 2,
  );
  let remaining = innerWidth;
  let rendered = "";
  for (const segment of segments) {
    if (remaining === 0) {
      break;
    }
    const clean = sanitizeDashboardText(segment.text);
    const fitted = fitDashboardText(clean, remaining, output.unicode);
    rendered += segment.style ? output.style(segment.style, fitted) : fitted;
    remaining -= terminalTextWidth(fitted);
    if (terminalTextWidth(clean) > terminalTextWidth(fitted)) {
      break;
    }
  }
  const padding = " ".repeat(horizontalPadding);
  return `${output.style("muted", box.vertical)}${padding}${rendered}${" ".repeat(
    remaining,
  )}${padding}${output.style("muted", box.vertical)}`;
}

function fitDashboardText(
  value: string,
  maximumWidth: number,
  unicode: boolean,
): string {
  if (maximumWidth <= 0) {
    return "";
  }
  if (terminalTextWidth(value) <= maximumWidth) {
    return value;
  }
  const ellipsis = unicode ? "…" : "...";
  const ellipsisWidth = terminalTextWidth(ellipsis);
  if (maximumWidth <= ellipsisWidth) {
    return ".".repeat(maximumWidth);
  }
  let result = "";
  let width = 0;
  for (const character of value) {
    const characterWidth = terminalCharacterWidth(character);
    if (width + characterWidth + ellipsisWidth > maximumWidth) {
      break;
    }
    result += character;
    width += characterWidth;
  }
  return `${result}${ellipsis}`;
}

function wrapDashboardText(value: string, maximumWidth: number): string[] {
  let remaining = sanitizeDashboardText(value).trim();
  if (remaining.length === 0) {
    return [""];
  }
  const lines: string[] = [];
  while (terminalTextWidth(remaining) > maximumWidth) {
    const characters = [...remaining];
    let usedWidth = 0;
    let splitIndex = 0;
    let lastSpaceIndex = -1;
    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index] ?? "";
      const characterWidth = terminalCharacterWidth(character);
      if (usedWidth + characterWidth > maximumWidth) {
        break;
      }
      usedWidth += characterWidth;
      splitIndex = index + 1;
      if (character === " ") {
        lastSpaceIndex = index;
      }
    }
    splitIndex = Math.max(1, splitIndex);
    if (lastSpaceIndex >= Math.floor(splitIndex / 3)) {
      splitIndex = lastSpaceIndex + 1;
    }
    const line = characters.slice(0, splitIndex).join("").trimEnd();
    lines.push(line);
    remaining = characters.slice(splitIndex).join("").trimStart();
  }
  lines.push(remaining);
  return lines;
}

function terminalTextWidth(value: string): number {
  return [...value].reduce(
    (width, character) => width + terminalCharacterWidth(character),
    0,
  );
}

function terminalCharacterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff))
  ) {
    return 2;
  }
  return 1;
}

function sanitizeDashboardText(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (["\n", "\r", "\t"].includes(character)) {
      result += " ";
    } else if (codePoint >= 32 && codePoint !== 127) {
      result += character;
    }
  }
  return result;
}

function formatActivityTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf())
    ? timestamp.slice(0, 8).padEnd(8)
    : date.toISOString().slice(11, 19);
}

function statusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "in_progress":
      return "Reviewing";
    case "completed":
      return "Complete";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "Expired";
    default:
      return status;
  }
}

function statusStyle(status: string): TextStyle {
  if (status === "completed") {
    return "success";
  }
  if (["failed", "cancelled", "expired"].includes(status)) {
    return "failure";
  }
  return status === "queued" ? "warning" : "active";
}

function logLevelStyle(level: string): TextStyle {
  const normalized = level.toLowerCase();
  if (["error", "fatal"].includes(normalized)) {
    return "failure";
  }
  if (normalized === "warn") {
    return "warning";
  }
  if (["debug", "trace"].includes(normalized)) {
    return "muted";
  }
  return "active";
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
