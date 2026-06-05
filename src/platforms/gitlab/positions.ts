import type {
  GitLabDiffPosition,
  GitLabMergeRequestChange,
  GitLabMergeRequestVersion,
} from "./types.js";
import {
  appendSuggestion as appendReviewSuggestion,
  renderSuggestionMarkdown as renderReviewSuggestionMarkdown,
} from "../../review/discussion-format.js";

export interface LineAnchorLike {
  path: string;
  oldPath?: string | null | undefined;
  startLine: number;
  endLine: number;
  side: "new" | "old";
}

export interface SuggestionLike {
  replacement: string;
  startLine: number;
  endLine: number;
}

export function buildDiffPosition(
  anchor: LineAnchorLike,
  changes: GitLabMergeRequestChange[],
  version: GitLabMergeRequestVersion | null,
): GitLabDiffPosition | null {
  if (!version) {
    return null;
  }

  const change = findChangeForAnchor(changes, anchor);
  if (!change) {
    return null;
  }

  const targetLine = findDiffLineForAnchor(change.diff, anchor);
  if (!targetLine) {
    return null;
  }

  const position: GitLabDiffPosition = {
    base_sha: version.base_commit_sha,
    start_sha: version.start_commit_sha,
    head_sha: version.head_commit_sha,
    position_type: "text",
    old_path: change.old_path,
    new_path: change.new_path,
  };

  if (targetLine.oldLine !== null) {
    position.old_line = targetLine.oldLine;
  }

  if (targetLine.newLine !== null) {
    position.new_line = targetLine.newLine;
  }

  return position;
}

export function buildFilePosition(
  anchor: Pick<LineAnchorLike, "path" | "oldPath">,
  changes: GitLabMergeRequestChange[],
  version: GitLabMergeRequestVersion | null,
): GitLabDiffPosition | null {
  if (!version) {
    return null;
  }

  const change = findChangeForAnchor(changes, anchor);
  if (!change) {
    return null;
  }

  return {
    base_sha: version.base_commit_sha,
    start_sha: version.start_commit_sha,
    head_sha: version.head_commit_sha,
    position_type: "file",
    old_path: change.old_path,
    new_path: change.new_path,
  };
}

function findChangeForAnchor(
  changes: GitLabMergeRequestChange[],
  anchor: Pick<LineAnchorLike, "path" | "oldPath">,
): GitLabMergeRequestChange | null {
  return (
    changes.find(
      (candidate) =>
        candidate.new_path === anchor.path ||
        candidate.old_path === anchor.path ||
        (anchor.oldPath !== undefined && anchor.oldPath !== null
          ? candidate.new_path === anchor.oldPath ||
            candidate.old_path === anchor.oldPath
          : false),
    ) ?? null
  );
}

interface DiffLineReference {
  kind: "new" | "old" | "context";
  oldLine: number | null;
  newLine: number | null;
}

function findDiffLineForAnchor(
  diff: string | undefined,
  anchor: LineAnchorLike,
): DiffLineReference | null {
  const matches = collectDiffLineReferences(diff).filter((line) =>
    lineOverlapsAnchor(line, anchor),
  );
  if (matches.length === 0) {
    return null;
  }

  return (
    matches.find((line) => line.kind === anchor.side) ?? matches[0] ?? null
  );
}

function collectDiffLineReferences(
  diff: string | undefined,
): DiffLineReference[] {
  if (!diff) {
    return [];
  }

  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const lines: DiffLineReference[] = [];

  for (const rawLine of diff.replace(/\r\n/g, "\n").split("\n")) {
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    const oldStart = hunk?.[1];
    const newStart = hunk?.[2];
    if (oldStart && newStart) {
      oldLine = Number.parseInt(oldStart, 10);
      newLine = Number.parseInt(newStart, 10);
      inHunk = true;
      continue;
    }

    if (!inHunk || rawLine.startsWith("\\ ")) {
      continue;
    }

    const prefix = rawLine[0];
    if (prefix === " ") {
      lines.push({
        kind: "context",
        oldLine,
        newLine,
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (prefix === "-") {
      lines.push({
        kind: "old",
        oldLine,
        newLine: null,
      });
      oldLine += 1;
      continue;
    }

    if (prefix === "+") {
      lines.push({
        kind: "new",
        oldLine: null,
        newLine,
      });
      newLine += 1;
    }
  }

  return lines;
}

function lineOverlapsAnchor(
  line: DiffLineReference,
  anchor: LineAnchorLike,
): boolean {
  const candidate = anchor.side === "new" ? line.newLine : line.oldLine;
  return (
    candidate !== null &&
    candidate >= anchor.startLine &&
    candidate <= anchor.endLine
  );
}

export function renderSuggestionMarkdown(
  suggestion: SuggestionLike | null | undefined,
  anchor: LineAnchorLike | null | undefined,
): string | null {
  return renderReviewSuggestionMarkdown(suggestion, anchor);
}

export function appendSuggestion(
  body: string,
  suggestionMarkdown: string | null,
): string {
  return appendReviewSuggestion(body, suggestionMarkdown);
}
