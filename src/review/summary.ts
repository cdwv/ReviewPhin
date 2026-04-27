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
  reviewedAt?: Date;
}): string {
  const reviewedAt = input.reviewedAt ?? new Date();
  const overview = resolveSummaryOverview(input.reviewResult);
  const findingsSnapshot = formatFindingsSnapshot(input.reviewResult.findings);
  const topFindings = input.reviewResult.findings
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
          findings: input.reviewResult.findings
      }),
      "",
      "</details>"
    );
  }

  return lines.join("\n");
}

function resolveSummaryOverview(reviewResult: ReviewResult): ResolvedReviewSummaryOverview {
  return {
    overallAssessment: reviewResult.overview.overallAssessment ?? reviewResult.overview.summary,
    mergeReadiness: reviewResult.overview.mergeReadiness ?? deriveMergeReadiness(reviewResult),
    overallSeverity: reviewResult.overview.overallSeverity,
    highlights: reviewResult.overview.highlights ?? []
  };
}

function deriveMergeReadiness(reviewResult: ReviewResult): ReviewMergeReadiness {
  if (reviewResult.findings.length === 0) {
    return {
      status: "ready",
      confidence: "medium",
      summary: "No actionable findings were identified in this review run."
    };
  }

  if (reviewResult.findings.some((finding) => finding.severity === "critical")) {
    return {
      status: "blocked",
      confidence: "medium",
      summary: "Critical issues remain and should be resolved before merge."
    };
  }

  if (reviewResult.findings.some((finding) => finding.severity === "high")) {
    return {
      status: "needs_attention",
      confidence: "medium",
      summary: "High-severity issues remain and should be addressed before merge."
    };
  }

  return {
    status: "needs_attention",
    confidence: "medium",
    summary: "Actionable findings remain and should be reviewed before merge."
  };
}

function formatScopeReviewed(context: HydratedMergeRequestContext): string {
  const fileCount = context.changes.length;
  const fileLabel = fileCount === 1 ? "file" : "files";
  return `${fileCount} changed ${fileLabel} on \`${context.mergeRequest.source_branch}\` -> \`${context.mergeRequest.target_branch}\``;
}

function formatFindingsSnapshot(findings: ReviewFinding[]): string {
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

function compareFindingsBySeverity(left: ReviewFinding, right: ReviewFinding): number {
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
  findings: ReviewFinding[];
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
  findings: ReviewFinding[];
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
