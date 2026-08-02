import {
  reviewResultSchema,
  type ReviewFinding,
  type ReviewResult,
} from "./types.js";
import { deriveMergeReadinessStatus } from "./merge-readiness.js";

export function parsePersistedReviewResult(resultJson: string): ReviewResult {
  return reviewResultSchema.parse(
    normalizeLegacyPersistedReviewResult(JSON.parse(resultJson) as unknown),
  );
}

// This normalization exists only for older review results already in storage.
// Live model responses must be parsed directly with reviewResultSchema.
function normalizeLegacyPersistedReviewResult(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.overview)) {
    return value;
  }

  const findings = Array.isArray(value.findings) ? value.findings : [];
  const findingSeverities = findings.flatMap((finding) =>
    isRecord(finding) && isReviewFindingSeverity(finding.severity)
      ? [{ severity: finding.severity }]
      : [],
  );
  const summary = value.overview.summary;
  const overview = {
    ...value.overview,
    ...(!Object.hasOwn(value.overview, "overallAssessment") &&
    typeof summary === "string" &&
    summary.length > 0
      ? { overallAssessment: summary }
      : {}),
    ...(!Object.hasOwn(value.overview, "mergeReadiness") &&
    typeof summary === "string" &&
    summary.length > 0
      ? {
          mergeReadiness: {
            status: deriveMergeReadinessStatus(findingSeverities),
            confidence: "low",
            summary,
          },
        }
      : {}),
  };

  return {
    ...value,
    overview,
    priorDispositions: normalizeLegacyPriorDispositions(
      value.priorDispositions,
    ),
    ...(Object.hasOwn(value, "replyHandoff")
      ? {
          replyHandoff: normalizeLegacyReplyHandoff(value.replyHandoff),
        }
      : {}),
  };
}

function normalizeLegacyReplyHandoff(value: unknown): unknown {
  if (!isRecord(value) || Object.hasOwn(value, "targets")) {
    return value;
  }
  return { ...value, targets: [] };
}

function normalizeLegacyPriorDispositions(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [value];
  }
  return value.flatMap((disposition) => {
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
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReviewFindingSeverity(
  value: unknown,
): value is ReviewFinding["severity"] {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "critical"
  );
}
