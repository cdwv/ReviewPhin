import { writeFile } from "node:fs/promises";

import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

import type {
  CodeReviewChange,
  ReviewAnchor,
  ReviewResult,
} from "../review/types.js";
import type { CliOutput } from "./output.js";

export interface ReviewReportFormatOptions {
  readonly changes?: readonly CodeReviewChange[] | undefined;
  readonly headingLevel?: number | undefined;
}

export function formatReviewReportMarkdown(
  result: ReviewResult,
  options: ReviewReportFormatOptions = {},
): string {
  const headingLevel = options.headingLevel ?? 1;
  const lines = [
    heading(headingLevel, "Review result"),
    "",
    `**Overall severity:** ${capitalize(result.overview.overallSeverity)}`,
    "",
    result.overview.summary.trim(),
    "",
    heading(headingLevel + 1, "Overall assessment"),
    "",
    result.overview.overallAssessment.trim(),
  ];

  lines.push(
    "",
    heading(headingLevel + 1, "Merge readiness"),
    "",
    `**Status:** ${formatLabel(result.overview.mergeReadiness.status)}`,
    "",
    `**Confidence:** ${capitalize(result.overview.mergeReadiness.confidence)}`,
    "",
    result.overview.mergeReadiness.summary.trim(),
  );

  if (result.overview.highlights?.length) {
    lines.push(
      "",
      heading(headingLevel + 1, "Highlights"),
      "",
      ...result.overview.highlights.map(
        (highlight) => `- ${escapeMarkdownText(highlight)}`,
      ),
    );
  }

  lines.push(
    "",
    heading(headingLevel + 1, `Findings (${result.findings.length})`),
    "",
  );
  if (result.findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const [index, finding] of result.findings.entries()) {
      lines.push(
        heading(
          headingLevel + 2,
          `${index + 1}. ${escapeMarkdownText(finding.title)}`,
        ),
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
        const source = extractSuggestionSource(
          options.changes ?? [],
          finding.anchor ?? null,
          finding.suggestion.startLine,
          finding.suggestion.endLine,
        );
        lines.push(
          "",
          heading(headingLevel + 3, "Suggested change"),
          "",
          ...(finding.anchor
            ? [
                `- **File:** ${inlineCode(finding.anchor.path)}`,
                `- **Lines:** ${formatLineRange(
                  finding.suggestion.startLine,
                  finding.suggestion.endLine,
                )}`,
                "",
              ]
            : []),
          ...(source !== null
            ? ["**Replace:**", "", fencedCode(source, "text"), "", "**With:**"]
            : ["**Replace the indicated lines with:**"]),
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
  options: ReviewReportFormatOptions = {},
): string {
  return formatMarkdownForTerminal(
    formatReviewReportMarkdown(result, options),
    output,
  );
}

export function formatMarkdownForTerminal(
  markdown: string,
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
  const rendered = marked.parse(markdown);
  if (typeof rendered !== "string") {
    throw new Error("Terminal report rendering unexpectedly became async.");
  }
  return rendered.trimEnd();
}

export async function writeReviewReport(
  path: string,
  result: ReviewResult,
  options: ReviewReportFormatOptions = {},
): Promise<void> {
  await writeFile(path, formatReviewReportMarkdown(result, options), "utf8");
}

function heading(level: number, value: string): string {
  return `${"#".repeat(Math.max(1, level))} ${value}`;
}

function formatAnchor(anchor: ReviewAnchor): string {
  const lineRange = formatLineRange(anchor.startLine, anchor.endLine);
  return `${inlineCode(anchor.path)}, ${lineRange} (${anchor.side} side)`;
}

function formatLineRange(startLine: number, endLine: number): string {
  return startLine === endLine
    ? `line ${startLine}`
    : `lines ${startLine}-${endLine}`;
}

export function extractSuggestionSource(
  changes: readonly CodeReviewChange[],
  anchor: ReviewAnchor | null,
  startLine: number,
  endLine: number,
): string | null {
  if (!anchor || anchor.side !== "new") {
    return null;
  }
  const change = changes.find((entry) => entry.newPath === anchor.path);
  if (!change?.diff) {
    return null;
  }

  const linesByNumber = new Map<number, string>();
  let newLine: number | null = null;
  for (const line of change.diff.replace(/\r\n/g, "\n").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (newLine === null || line.startsWith("\\")) {
      continue;
    }
    if (line.startsWith("-")) {
      continue;
    }
    if (line.startsWith("+") || line.startsWith(" ")) {
      if (newLine >= startLine && newLine <= endLine) {
        linesByNumber.set(newLine, line.slice(1));
      }
      newLine += 1;
    }
  }

  const source = Array.from({ length: endLine - startLine + 1 }, (_, index) =>
    linesByNumber.get(startLine + index),
  );
  return source.every((line) => line !== undefined) ? source.join("\n") : null;
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
