import { describe, expect, it } from "vitest";

import { buildDiffPosition, renderSuggestionMarkdown } from "../src/gitlab/positions.js";

describe("GitLab diff positioning", () => {
  it("builds a diff position for a changed new-side line", () => {
    const position = buildDiffPosition(
      {
        path: "src/index.ts",
        oldPath: "src/index.ts",
        startLine: 12,
        endLine: 12,
        side: "new"
      },
      [
        {
          old_path: "src/index.ts",
          new_path: "src/index.ts",
          new_file: false,
          renamed_file: false,
          deleted_file: false
        }
      ],
      {
        id: 1,
        base_commit_sha: "base",
        start_commit_sha: "start",
        head_commit_sha: "head",
        created_at: new Date().toISOString()
      }
    );

    expect(position).toEqual({
      base_sha: "base",
      start_sha: "start",
      head_sha: "head",
      position_type: "text",
      old_path: "src/index.ts",
      new_path: "src/index.ts",
      new_line: 12
    });
  });

  it("renders a suggestion only for single-line new-side anchors", () => {
    const suggestion = renderSuggestionMarkdown(
      {
        replacement: "return 42;",
        startLine: 8,
        endLine: 8
      },
      {
        path: "src/index.ts",
        startLine: 8,
        endLine: 8,
        side: "new"
      }
    );

    expect(suggestion).toBe("```suggestion\nreturn 42;\n```");
    expect(
      renderSuggestionMarkdown(
        {
          replacement: "return 42;",
          startLine: 8,
          endLine: 9
        },
        {
          path: "src/index.ts",
          startLine: 8,
          endLine: 9,
          side: "new"
        }
      )
    ).toBeNull();
  });
});
