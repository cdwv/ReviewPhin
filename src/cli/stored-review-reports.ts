import { writeFile } from "node:fs/promises";

import {
  getReviewPublicationMode,
  type ReviewPublicationMode,
} from "../review/publication.js";
import {
  reviewResultSchema,
  type CodeReviewChange,
  type ReviewResult,
  type ReviewTriggerKind,
} from "../review/types.js";
import type {
  CodeReviewSnapshotRecord,
  InteractionJobRecord,
  InteractionRunMetricsRecord,
  InteractionRunRecord,
  TenantRecord,
} from "../storage/contract/index.js";
import { listAll, type StorageHelpers } from "../storage/storage-helpers.js";
import {
  extractSuggestionSource,
  formatReviewReportMarkdown,
} from "./review-report.js";

export const REVIEW_REPORT_TRIGGER_TYPES = [
  "manual-review",
  "direct-mention",
  "follow-up-comment",
  "summary-follow-up",
] as const satisfies readonly ReviewTriggerKind[];

export interface StoredReviewReportFilters {
  readonly codeReviewId?: number | undefined;
  readonly from?: string | undefined;
  readonly latest: boolean;
  readonly limit?: number | undefined;
  readonly publicationMode?: ReviewPublicationMode | undefined;
  readonly triggerType?: ReviewTriggerKind | undefined;
}

export interface StoredReviewReport {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly codeReviewId: number;
  readonly interactionJobId: string;
  readonly interactionRunId: string;
  readonly headSha: string;
  readonly publicationMode: ReviewPublicationMode;
  readonly triggerType: ReviewTriggerKind | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly result: ReviewResult;
  readonly changes: readonly CodeReviewChange[];
}

export interface StoredReviewReportOutput extends Omit<
  StoredReviewReport,
  "changes"
> {
  readonly suggestedChanges: ReadonlyArray<{
    readonly finding: string;
    readonly path: string | null;
    readonly startLine: number;
    readonly endLine: number;
    readonly replacedText: string | null;
    readonly replacement: string;
  }>;
}

export async function loadStoredReviewReports(
  storage: StorageHelpers,
  tenant: TenantRecord,
  filters: StoredReviewReportFilters,
): Promise<StoredReviewReport[]> {
  const jobs = await listAll(storage.stores.interactionJobs, {
    filters: {
      tenantId: { eq: tenant.id },
      ...(filters.codeReviewId === undefined
        ? {}
        : { codeReviewId: { eq: filters.codeReviewId } }),
    },
  });
  const eligibleJobs = jobs.filter(
    (job) =>
      filters.publicationMode === undefined ||
      getReviewPublicationMode(job.triggerJson) === filters.publicationMode,
  );
  if (eligibleJobs.length === 0) {
    return [];
  }

  const jobById = new Map(eligibleJobs.map((job) => [job.id, job]));
  let runs = (
    await listAll(storage.stores.interactionRuns, {
      filters: {
        tenantId: { eq: tenant.id },
        status: { eq: "completed" },
        resultJson: { isNull: false },
        ...(filters.from ? { finishedAt: { gte: filters.from } } : {}),
      },
      order: [
        { field: "finishedAt", direction: "desc" },
        { field: "id", direction: "desc" },
      ],
    })
  ).filter((run) => jobById.has(run.interactionJobId));

  let triggerTypeByRunId: Map<string, ReviewTriggerKind>;
  if (filters.triggerType) {
    triggerTypeByRunId = await loadTriggerTypes(storage, runs, jobById);
    runs = runs.filter(
      (run) => triggerTypeByRunId.get(run.id) === filters.triggerType,
    );
  } else {
    triggerTypeByRunId = new Map();
  }

  const selectedRuns = runs.slice(
    0,
    filters.latest ? 1 : (filters.limit ?? runs.length),
  );
  if (selectedRuns.length === 0) {
    return [];
  }

  if (!filters.triggerType) {
    triggerTypeByRunId = await loadTriggerTypes(storage, selectedRuns, jobById);
  }
  const snapshotByRunId = await loadSnapshots(storage, selectedRuns);

  return selectedRuns.map((run) => {
    const job = jobById.get(run.interactionJobId)!;
    return {
      tenantId: tenant.id,
      tenantKey: tenant.key,
      codeReviewId: job.codeReviewId,
      interactionJobId: job.id,
      interactionRunId: run.id,
      headSha: job.headSha,
      publicationMode: getReviewPublicationMode(job.triggerJson),
      triggerType: triggerTypeByRunId.get(run.id) ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      result: parseStoredReviewResult(run.resultJson!),
      changes: parseReviewChanges(snapshotByRunId.get(run.id)?.changesJson),
    };
  });
}

function parseStoredReviewResult(resultJson: string): ReviewResult {
  const parsed = JSON.parse(resultJson) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.priorDispositions)) {
    return reviewResultSchema.parse(parsed);
  }

  return reviewResultSchema.parse({
    ...parsed,
    priorDispositions: parsed.priorDispositions.flatMap((disposition) => {
      if (!isRecord(disposition)) {
        return [];
      }
      if (typeof disposition.discussionId === "string") {
        return [disposition];
      }
      if (typeof disposition.threadId === "string") {
        return [{ ...disposition, discussionId: disposition.threadId }];
      }
      return [];
    }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function formatStoredReviewReportsMarkdown(
  reports: readonly StoredReviewReport[],
): string {
  const documents = reports
    .map((report) =>
      [
        "# Merge request review report",
        "",
        `- **Tenant:** ${inlineCode(report.tenantKey)}`,
        `- **Code review:** ${report.codeReviewId}`,
        `- **Completed:** ${report.finishedAt ?? report.startedAt}`,
        `- **Trigger type:** ${report.triggerType ?? "unknown"}`,
        `- **Publication mode:** ${report.publicationMode}`,
        `- **Head SHA:** ${inlineCode(report.headSha)}`,
        `- **Interaction job:** ${inlineCode(report.interactionJobId)}`,
        `- **Interaction run:** ${inlineCode(report.interactionRunId)}`,
        "",
        formatReviewReportMarkdown(report.result, {
          changes: report.changes,
          headingLevel: 2,
        }).trimEnd(),
      ].join("\n"),
    )
    .join("\n\n---\n\n");
  return `${documents}\n`;
}

export async function writeStoredReviewReports(
  path: string,
  reports: readonly StoredReviewReport[],
): Promise<void> {
  await writeFile(path, formatStoredReviewReportsMarkdown(reports), "utf8");
}

export function toStoredReviewReportOutput(
  report: StoredReviewReport,
): StoredReviewReportOutput {
  return {
    tenantId: report.tenantId,
    tenantKey: report.tenantKey,
    codeReviewId: report.codeReviewId,
    interactionJobId: report.interactionJobId,
    interactionRunId: report.interactionRunId,
    headSha: report.headSha,
    publicationMode: report.publicationMode,
    triggerType: report.triggerType,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    result: report.result,
    suggestedChanges: report.result.findings.flatMap((finding) => {
      if (!finding.suggestion) {
        return [];
      }
      return [
        {
          finding: finding.title,
          path: finding.anchor?.path ?? null,
          startLine: finding.suggestion.startLine,
          endLine: finding.suggestion.endLine,
          replacedText: extractSuggestionSource(
            report.changes,
            finding.anchor ?? null,
            finding.suggestion.startLine,
            finding.suggestion.endLine,
          ),
          replacement: finding.suggestion.replacement,
        },
      ];
    }),
  };
}

async function loadTriggerTypes(
  storage: StorageHelpers,
  runs: readonly InteractionRunRecord[],
  jobById: ReadonlyMap<string, InteractionJobRecord>,
): Promise<Map<string, ReviewTriggerKind>> {
  const metrics = await loadMetrics(
    storage,
    runs.map((run) => run.id),
  );
  const typeByRunId = new Map<string, ReviewTriggerKind>();
  for (const entry of metrics) {
    if (isReviewTriggerKind(entry.triggerKind)) {
      typeByRunId.set(entry.interactionRunId, entry.triggerKind);
    }
  }
  for (const run of runs) {
    if (typeByRunId.has(run.id)) {
      continue;
    }
    const job = jobById.get(run.interactionJobId);
    const fallback = job ? inferTriggerType(job.triggerJson) : null;
    if (fallback) {
      typeByRunId.set(run.id, fallback);
    }
  }
  return typeByRunId;
}

async function loadMetrics(
  storage: StorageHelpers,
  runIds: readonly string[],
): Promise<InteractionRunMetricsRecord[]> {
  const metrics: InteractionRunMetricsRecord[] = [];
  for (let offset = 0; offset < runIds.length; offset += 100) {
    metrics.push(
      ...(await listAll(storage.stores.interactionRunMetrics, {
        filters: {
          interactionRunId: { in: runIds.slice(offset, offset + 100) },
        },
      })),
    );
  }
  return metrics;
}

async function loadSnapshots(
  storage: StorageHelpers,
  runs: readonly InteractionRunRecord[],
): Promise<Map<string, CodeReviewSnapshotRecord>> {
  const jobIds = [...new Set(runs.map((run) => run.interactionJobId))];
  const snapshots: CodeReviewSnapshotRecord[] = [];
  for (let offset = 0; offset < jobIds.length; offset += 100) {
    snapshots.push(
      ...(await listAll(storage.stores.codeReviewSnapshots, {
        filters: {
          interactionJobId: { in: jobIds.slice(offset, offset + 100) },
        },
        order: [{ field: "createdAt", direction: "desc" }],
      })),
    );
  }

  const latestLegacyByJobId = new Map<string, CodeReviewSnapshotRecord>();
  const byRunId = new Map<string, CodeReviewSnapshotRecord>();
  for (const snapshot of snapshots) {
    if (snapshot.interactionRunId) {
      if (!byRunId.has(snapshot.interactionRunId)) {
        byRunId.set(snapshot.interactionRunId, snapshot);
      }
    } else if (!latestLegacyByJobId.has(snapshot.interactionJobId)) {
      latestLegacyByJobId.set(snapshot.interactionJobId, snapshot);
    }
  }
  for (const run of runs) {
    const legacy = latestLegacyByJobId.get(run.interactionJobId);
    if (!byRunId.has(run.id) && legacy) {
      byRunId.set(run.id, legacy);
    }
  }
  return byRunId;
}

function inferTriggerType(triggerJson: string): ReviewTriggerKind | null {
  const trigger = JSON.parse(triggerJson) as unknown;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
    return null;
  }
  const value = trigger as Record<string, unknown>;
  if (isReviewTriggerKind(value.triggerKind)) {
    return value.triggerKind;
  }
  return value.kind === "reviewphin-local-review" ||
    value.kind === "github-check-run"
    ? "manual-review"
    : null;
}

function isReviewTriggerKind(value: unknown): value is ReviewTriggerKind {
  return REVIEW_REPORT_TRIGGER_TYPES.includes(value as ReviewTriggerKind);
}

function parseReviewChanges(value: string | undefined): CodeReviewChange[] {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isCodeReviewChange);
}

function isCodeReviewChange(value: unknown): value is CodeReviewChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const change = value as Record<string, unknown>;
  return (
    typeof change.oldPath === "string" &&
    typeof change.newPath === "string" &&
    typeof change.newFile === "boolean" &&
    typeof change.renamedFile === "boolean" &&
    typeof change.deletedFile === "boolean" &&
    (change.diff === undefined || typeof change.diff === "string")
  );
}

function inlineCode(value: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  const delimiter = "`".repeat(longestRun + 1);
  return `${delimiter}${value}${delimiter}`;
}
