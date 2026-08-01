import { writeFile } from "node:fs/promises";

import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

import type { ReviewAnchor, ReviewResult } from "../review/types.js";
import type { CliOutput } from "./output.js";

export function formatReviewReportMarkdown(result: ReviewResult): string {
  const lines = [
    "# Review result",
    "",
    `**Overall severity:** ${capitalize(result.overview.overallSeverity)}`,
    "",
    result.overview.summary.trim(),
  ];

  if (result.overview.overallAssessment) {
    lines.push("", result.overview.overallAssessment.trim());
  }

  if (result.overview.mergeReadiness) {
    lines.push(
      "",
      "## Merge readiness",
      "",
      `**Status:** ${formatLabel(result.overview.mergeReadiness.status)}`,
      "",
      `**Confidence:** ${capitalize(result.overview.mergeReadiness.confidence)}`,
      "",
      result.overview.mergeReadiness.summary.trim(),
    );
  }

  if (result.overview.highlights?.length) {
    lines.push(
      "",
      "## Highlights",
      "",
      ...result.overview.highlights.map(
        (highlight) => `- ${escapeMarkdownText(highlight)}`,
      ),
    );
  }

  lines.push("", `## Findings (${result.findings.length})`, "");
  if (result.findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const [index, finding] of result.findings.entries()) {
      lines.push(
        `### ${index + 1}. ${escapeMarkdownText(finding.title)}`,
        "",
        `- **Severity:** ${capitalize(finding.severity)}`,
        `- **Category:** ${capitalize(finding.category)}`,
      );
      if (finding.confidence) {
        lines.push(`- **Confidence:** ${capitalize(finding.confidence)}`);
      }
      if (finding.anchor) {
        lines.push(`- **Location:** ${formatAnchor(finding.anchor)}`);
      }
      lines.push("", finding.body.trim());
      if (finding.suggestion) {
        lines.push(
          "",
          "#### Suggested change",
          "",
          fencedCode(finding.suggestion.replacement, "suggestion"),
        );
      }
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function formatReviewReportForTerminal(
  result: ReviewResult,
  output: CliOutput,
): string {
  const marked = new Marked();
  marked.use(
    markedTerminal({
      width: output.columns,
      reflowText: true,
      showSectionPrefix: false,
      emoji: output.unicode,
      code: (value) => output.style("warning", value),
      blockquote: (value) => output.style("muted", value),
      html: (value) => output.style("muted", value),
      heading: (value) => output.style("heading", value),
      firstHeading: (value) => output.style("heading", value),
      hr: (value) => output.style("muted", value),
      listitem: (value) => value,
      table: (value) => value,
      paragraph: (value) => value,
      strong: (value) => output.style("strong", value),
      em: (value) => value,
      codespan: (value) => output.style("warning", value),
      del: (value) => output.style("muted", value),
      link: (value) => value,
      href: (value) => value,
    }),
  );
  const rendered = marked.parse(formatReviewReportMarkdown(result));
  if (typeof rendered !== "string") {
    throw new Error("Terminal report rendering unexpectedly became async.");
  }
  return rendered.trimEnd();
}

export async function writeReviewReport(
  path: string,
  result: ReviewResult,
): Promise<void> {
  await writeFile(path, formatReviewReportMarkdown(result), "utf8");
}

function formatAnchor(anchor: ReviewAnchor): string {
  const lineRange =
    anchor.startLine === anchor.endLine
      ? `line ${anchor.startLine}`
      : `lines ${anchor.startLine}-${anchor.endLine}`;
  return `${inlineCode(anchor.path)}, ${lineRange} (${anchor.side} side)`;
}

function inlineCode(value: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  const delimiter = "`".repeat(longestRun + 1);
  return `${delimiter}${value}${delimiter}`;
}

function fencedCode(value: string, language: string): string {
  const longestRun = Math.max(
    2,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${language}\n${value.trimEnd()}\n${fence}`;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>#])/g, "\\$1");
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function formatLabel(value: string): string {
  return value.split("_").filter(Boolean).map(capitalize).join(" ");
}
