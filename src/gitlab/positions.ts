import type { GitLabDiffPosition, GitLabMergeRequestChange, GitLabMergeRequestVersion } from "./types.js";

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
  version: GitLabMergeRequestVersion | null
): GitLabDiffPosition | null {
  if (!version) {
    return null;
  }

  const change = changes.find((candidate) => candidate.new_path === anchor.path || candidate.old_path === anchor.path);
  if (!change) {
    return null;
  }

  const position: GitLabDiffPosition = {
    base_sha: version.base_commit_sha,
    start_sha: version.start_commit_sha,
    head_sha: version.head_commit_sha,
    position_type: "text",
    old_path: change.old_path,
    new_path: change.new_path
  };

  if (anchor.side === "new") {
    if (change.deleted_file) {
      return null;
    }

    position.new_line = anchor.startLine;
  } else {
    position.old_line = anchor.startLine;
  }

  return position;
}

export function renderSuggestionMarkdown(
  suggestion: SuggestionLike | null | undefined,
  anchor: LineAnchorLike | null | undefined
): string | null {
  if (!suggestion || !anchor) {
    return null;
  }

  if (anchor.side !== "new") {
    return null;
  }

  if (suggestion.startLine !== suggestion.endLine || anchor.startLine !== anchor.endLine) {
    return null;
  }

  return ["```suggestion", suggestion.replacement.replace(/\r\n/g, "\n").trimEnd(), "```"].join("\n");
}

export function appendSuggestion(body: string, suggestionMarkdown: string | null): string {
  if (!suggestionMarkdown) {
    return body;
  }

  return `${body.trim()}\n\n${suggestionMarkdown}`;
}
