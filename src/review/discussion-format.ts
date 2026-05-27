import type { ReviewAnchor, ReviewFinding } from "./types.js";

interface LineAnchorLike {
  path: string;
  oldPath?: string | null | undefined;
  startLine: number;
  endLine: number;
  side: "new" | "old";
}

interface SuggestionLike {
  replacement: string;
  startLine: number;
  endLine: number;
}

const REVIEW_THREAD_MARKER_PREFIX = "reviewphin-review-thread:";
const REVIEW_THREAD_MARKER_PATTERN =
  /\n*\[comment\]: <> \((?:gitlab-agentic|reviewphin)-review-thread:([^\s)]+)\)\s*/g;
const REVIEW_THREAD_MARKER_EXTRACTOR =
  /\[comment\]: <> \((?:gitlab-agentic|reviewphin)-review-thread:([^\s)]+)\)/;

export function renderSuggestionMarkdown(
  suggestion: SuggestionLike | null | undefined,
  anchor: LineAnchorLike | null | undefined,
): string | null {
  if (!suggestion || !anchor) {
    return null;
  }

  if (anchor.side !== "new") {
    return null;
  }

  if (
    anchor.startLine < suggestion.startLine ||
    anchor.startLine > suggestion.endLine
  ) {
    return null;
  }

  const linesAbove = anchor.startLine - suggestion.startLine;
  const linesBelow = suggestion.endLine - anchor.startLine;
  if (linesAbove > 100 || linesBelow > 100) {
    return null;
  }

  return [
    `\`\`\`suggestion:-${linesAbove}+${linesBelow}`,
    suggestion.replacement.replace(/\r\n/g, "\n").trimEnd(),
    "```",
  ].join("\n");
}

export function appendSuggestion(
  body: string,
  suggestionMarkdown: string | null,
): string {
  if (!suggestionMarkdown) {
    return body;
  }

  return `${body.trim()}\n\n${suggestionMarkdown}`;
}

export function renderReviewFindingBody(
  finding: Pick<ReviewFinding, "title" | "body" | "anchor" | "suggestion">,
): string {
  const suggestion = renderSuggestionMarkdown(
    finding.suggestion ?? null,
    finding.anchor ?? null,
  );
  return appendSuggestion(
    `**${finding.title.trim()}**\n\n${finding.body.trim()}`,
    suggestion,
  );
}

export function appendReviewThreadMarker(body: string, marker: string): string {
  return `${body}\n\n[comment]: <> (${REVIEW_THREAD_MARKER_PREFIX}${marker})`;
}

export function stripReviewThreadMarker(body: string): string {
  return body.replace(REVIEW_THREAD_MARKER_PATTERN, "\n").trim();
}

export function extractReviewThreadMarker(body: string): string | null {
  const match = REVIEW_THREAD_MARKER_EXTRACTOR.exec(body);
  return match?.[1] ?? null;
}

export function extractAnchorFromPosition(
  position:
    | {
        new_path: string;
        old_path: string;
        new_line?: number | null | undefined;
        old_line?: number | null | undefined;
      }
    | null
    | undefined,
): ReviewAnchor | null {
  if (!position) {
    return null;
  }

  if (position.new_line) {
    return {
      path: position.new_path,
      oldPath: position.old_path,
      startLine: position.new_line,
      endLine: position.new_line,
      side: "new",
    };
  }

  if (position.old_line) {
    return {
      path: position.old_path,
      oldPath: position.old_path,
      startLine: position.old_line,
      endLine: position.old_line,
      side: "old",
    };
  }

  return null;
}
