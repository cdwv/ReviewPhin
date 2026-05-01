import type { GitLabNote, HydratedMergeRequestContext } from "../gitlab/types.js";
import type { ReviewFinding, ReviewMergeReadiness, ReviewResult } from "./types.js";

export const REVIEW_SUMMARY_NOTE_MARKER = "<!-- gitlab-agentic-review-summary -->";

const severityRank = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
} as const;

interface ResolvedReviewSummaryOverview {
  overallAssessment: string;
  mergeReadiness: ReviewMergeReadiness;
  overallSeverity: ReviewResult["overview"]["overallSeverity"];
  highlights: string[];
}

type SummaryFinding = Pick<ReviewFinding, "title" | "body" | "severity" | "category">;

export function isReviewSummaryNoteBody(body: string): boolean {
  return body.includes(REVIEW_SUMMARY_NOTE_MARKER);
}

export function findLatestReviewSummaryNote(
  notes: GitLabNote[],
  isBotAuthored: (note: GitLabNote) => boolean
): GitLabNote | null {
  const summaryNotes = notes.filter((note) => isBotAuthored(note) && isReviewSummaryNoteBody(note.body));
  if (summaryNotes.length === 0) {
    return null;
  }

  return summaryNotes.sort(compareNotesByUpdatedAtDesc)[0] ?? null;
}

export function buildReviewSummaryNote(input: {
  context: HydratedMergeRequestContext;
  reviewResult: ReviewResult;
  activeFindings?: SummaryFinding[];
  reviewedAt?: Date;
}): string {
  const reviewedAt = input.reviewedAt ?? new Date();
  const activeFindings = input.activeFindings ?? input.reviewResult.findings;
  const overview = resolveSummaryOverview(input.reviewResult, input.activeFindings);
  const findingsSnapshot = formatFindingsSnapshot(activeFindings);
  const topFindings = activeFindings
    .slice()
    .sort(compareFindingsBySeverity)
    .slice(0, 3);

  const lines = [
    REVIEW_SUMMARY_NOTE_MARKER,
    "## Review summary",
    "",
    "### Overall assessment",
    "",
    overview.overallAssessment,
    "",
    "### Merge readiness",
    "",
    `- **Status:** ${formatMergeReadinessStatus(overview.mergeReadiness.status)}`,
    `- **Confidence:** ${capitalize(overview.mergeReadiness.confidence)}`,
    `- **Rationale:** ${overview.mergeReadiness.summary}`,
    "",
    "### Snapshot",
    "",
    `- **Overall severity:** ${capitalize(overview.overallSeverity)}`,
    `- **Scope reviewed:** ${formatScopeReviewed(input.context)}`,
    `- **Findings snapshot:** ${findingsSnapshot}`,
    `- **Last reviewed:** ${reviewedAt.toISOString()}`
  ];

  if (overview.highlights.length > 0) {
    lines.push("", "### Highlights", "");
    for (const highlight of overview.highlights) {
      lines.push(`- ${highlight}`);
    }
  }

  if (topFindings.length > 0) {
    lines.push("", "### Top findings", "");
    for (const finding of topFindings) {
      lines.push(`- **${capitalize(finding.severity)}** - ${finding.title.trim()}`);
    }
  }

  if (shouldIncludeSuggestedFixesPrompt(overview)) {
      lines.push(
        "",
        "<details><summary>Suggested fixes prompt</summary>",
        "",
        buildSuggestedFixesPromptBlock({
          context: input.context,
          overview,
          findings: activeFindings
      }),
      "",
      "</details>"
    );
  }

  return lines.join("\n");
}

function resolveSummaryOverview(
  reviewResult: ReviewResult,
  activeFindings?: SummaryFinding[]
): ResolvedReviewSummaryOverview {
  const effectiveFindings = activeFindings ?? reviewResult.findings;
  const findingsDifferFromCurrentRun =
    activeFindings !== undefined && !areEquivalentFindings(activeFindings, reviewResult.findings);
  const providedMergeReadiness = reviewResult.overview.mergeReadiness;
  const derivedMergeReadiness = deriveMergeReadinessFromFindings(
    effectiveFindings,
    findingsDifferFromCurrentRun ? "persisted" : "current"
  );
  const useProvidedMergeReadiness = providedMergeReadiness?.status === derivedMergeReadiness.status;

  return {
    overallAssessment:
      findingsDifferFromCurrentRun && !useProvidedMergeReadiness
        ? deriveOverallAssessmentFromFindings(effectiveFindings)
        : reviewResult.overview.overallAssessment ?? reviewResult.overview.summary,
    mergeReadiness: useProvidedMergeReadiness ? providedMergeReadiness : derivedMergeReadiness,
    overallSeverity:
      findingsDifferFromCurrentRun
        ? deriveOverallSeverityFromFindings(effectiveFindings, reviewResult.overview.overallSeverity)
        : reviewResult.overview.overallSeverity,
    highlights: reviewResult.overview.highlights ?? []
  };
}

function deriveMergeReadiness(reviewResult: ReviewResult): ReviewMergeReadiness {
  return deriveMergeReadinessFromFindings(reviewResult.findings, "current");
}

function deriveMergeReadinessFromFindings(
  findings: ReadonlyArray<Pick<ReviewFinding, "severity">>,
  source: "current" | "persisted"
): ReviewMergeReadiness {
  if (findings.length === 0) {
    return {
      status: "ready",
      confidence: "medium",
      summary:
        source === "persisted"
          ? "No actionable findings remain after reconciling the latest review with persisted finding history."
          : "No actionable findings were identified in this review run."
    };
  }

  if (findings.some((finding) => finding.severity === "critical")) {
    return {
      status: "blocked",
      confidence: "medium",
      summary:
        source === "persisted"
          ? "Persisted open critical findings remain and should be resolved before merge."
          : "Critical issues remain and should be resolved before merge."
    };
  }

  if (findings.some((finding) => finding.severity === "high")) {
    return {
      status: "needs_attention",
      confidence: "medium",
      summary:
        source === "persisted"
          ? "Persisted open high-severity findings remain and should be addressed before merge."
          : "High-severity issues remain and should be addressed before merge."
    };
  }

  return {
    status: "needs_attention",
    confidence: "medium",
    summary:
      source === "persisted"
        ? "Persisted open findings remain and should be reviewed before merge."
        : "Actionable findings remain and should be reviewed before merge."
  };
}

function deriveOverallAssessmentFromFindings(findings: ReadonlyArray<SummaryFinding>): string {
  if (findings.length === 0) {
    return "No actionable findings remain after reconciling the latest review with persisted history.";
  }

  if (findings.some((finding) => finding.severity === "critical")) {
    return "Persisted open critical findings remain after reconciling the latest review and should be resolved before merge.";
  }

  if (findings.some((finding) => finding.severity === "high")) {
    return "Persisted open high-severity findings remain after reconciling the latest review and should be addressed before merge.";
  }

  return "Persisted open findings remain after reconciling the latest review and should be reviewed before merge.";
}

function deriveOverallSeverityFromFindings(
  findings: ReadonlyArray<SummaryFinding>,
  fallback: ReviewResult["overview"]["overallSeverity"]
): ReviewResult["overview"]["overallSeverity"] {
  return findings.slice().sort(compareFindingsBySeverity)[0]?.severity ?? fallback;
}

function areEquivalentFindings(
  left: ReadonlyArray<SummaryFinding>,
  right: ReadonlyArray<SummaryFinding>
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const normalize = (finding: SummaryFinding): string =>
    JSON.stringify({
      title: finding.title.trim(),
      body: finding.body.trim(),
      severity: finding.severity,
      category: finding.category
    });

  const normalizedLeft = left.map(normalize).sort();
  const normalizedRight = right.map(normalize).sort();

  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function formatScopeReviewed(context: HydratedMergeRequestContext): string {
  const fileCount = context.changes.length;
  const fileLabel = fileCount === 1 ? "file" : "files";
  return `${fileCount} changed ${fileLabel} on \`${context.mergeRequest.source_branch}\` -> \`${context.mergeRequest.target_branch}\``;
}

function formatFindingsSnapshot(findings: SummaryFinding[]): string {
  if (findings.length === 0) {
    return "No actionable findings.";
  }

  const counts = new Map<ReviewFinding["severity"], number>([
    ["critical", 0],
    ["high", 0],
    ["medium", 0],
    ["low", 0]
  ]);

  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }

  const parts = Array.from(counts.entries())
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`);

  const findingLabel = findings.length === 1 ? "finding" : "findings";
  return `${findings.length} ${findingLabel} (${parts.join(", ")})`;
}

function compareFindingsBySeverity(left: SummaryFinding, right: SummaryFinding): number {
  return severityRank[left.severity] - severityRank[right.severity];
}

function compareNotesByUpdatedAtDesc(left: GitLabNote, right: GitLabNote): number {
  return Date.parse(right.updated_at) - Date.parse(left.updated_at);
}

function shouldIncludeSuggestedFixesPrompt(overview: ResolvedReviewSummaryOverview): boolean {
  return overview.mergeReadiness.status !== "ready";
}

function buildSuggestedFixesPrompt(input: {
  context: HydratedMergeRequestContext;
  overview: ResolvedReviewSummaryOverview;
  findings: SummaryFinding[];
}): string {
  const lines = [
    `Review and fix the issues called out for merge request "${input.context.mergeRequest.title}" (${input.context.mergeRequest.web_url}).`,
    "",
    "Goal:",
    `- Move merge readiness from ${formatMergeReadinessStatus(input.overview.mergeReadiness.status)} to Ready.`,
    "- Resolve the actionable review findings without regressing existing behavior.",
    "",
    "Context:",
    `- Source branch: ${input.context.mergeRequest.source_branch}`,
    `- Target branch: ${input.context.mergeRequest.target_branch}`,
    `- Overall assessment: ${input.overview.overallAssessment}`,
    `- Readiness rationale: ${input.overview.mergeReadiness.summary}`
  ];

  if (input.overview.highlights.length > 0) {
    lines.push("", "Useful highlights:");
    for (const highlight of input.overview.highlights) {
      lines.push(`- ${highlight}`);
    }
  }

  if (input.findings.length > 0) {
    lines.push("", "Findings to address (highest severity first):");
    const sortedFindings = input.findings.slice().sort(compareFindingsBySeverity);
    for (const [index, finding] of sortedFindings.entries()) {
      lines.push(`${index + 1}. [${capitalize(finding.severity)} | ${finding.category}] ${finding.title.trim()}`);
      lines.push(`   ${finding.body.trim().replace(/\r\n/g, "\n").replace(/\n/g, "\n   ")}`);
    }
  }

  lines.push(
    "",
    "When finished:",
    "- Keep unrelated changes untouched.",
    "- Update tests or documentation if the fix changes behavior or public expectations.",
    "- Make sure the merge request is ready to re-review."
  );

  return lines.join("\n");
}

function buildSuggestedFixesPromptBlock(input: {
  context: HydratedMergeRequestContext;
  overview: ResolvedReviewSummaryOverview;
  findings: SummaryFinding[];
}): string {
  return ["```md", escapeMarkdownCodeFenceContent(buildSuggestedFixesPrompt(input)), "```"].join("\n");
}

function escapeMarkdownCodeFenceContent(value: string): string {
  return value.replace(/`{3,}/g, (match) => match.replace(/`/g, "\\`"));
}

function formatMergeReadinessStatus(status: ReviewMergeReadiness["status"]): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "needs_attention":
      return "Needs attention";
    case "blocked":
      return "Blocked";
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
