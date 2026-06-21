import type { ReviewAnchor, ReviewFinding } from "./types.js";

const REVIEW_DISCUSSION_MARKER_PREFIX = "reviewphin-review-discussion:";
const REVIEW_DISCUSSION_MARKER_PATTERN =
  /\n*\[comment\]: <> \((?:gitlab-agentic|reviewphin)-review-discussion:([^\s)]+)\)\s*/g;
const REVIEW_DISCUSSION_MARKER_EXTRACTOR =
  /\[comment\]: <> \((?:gitlab-agentic|reviewphin)-review-discussion:([^\s)]+)\)/;

export function renderReviewFindingProse(
  finding: Pick<ReviewFinding, "title" | "body">,
): string {
  return `**${finding.title.trim()}**\n\n${finding.body.trim()}`;
}

export function appendReviewDiscussionMarker(
  body: string,
  marker: string,
): string {
  return `${body}\n\n[comment]: <> (${REVIEW_DISCUSSION_MARKER_PREFIX}${marker})`;
}

export function stripReviewDiscussionMarker(body: string): string {
  return body.replace(REVIEW_DISCUSSION_MARKER_PATTERN, "\n").trim();
}

export function extractReviewDiscussionMarker(body: string): string | null {
  const match = REVIEW_DISCUSSION_MARKER_EXTRACTOR.exec(body);
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
