import { describe, expect, it } from "vitest";

import {
  buildFilePosition,
  buildDiffPosition,
  renderSuggestionMarkdown,
} from "../src/platforms/gitlab/positions.js";

describe("GitLab diff positioning", () => {
  it("builds a diff position for a changed new-side line", () => {
    const position = buildDiffPosition(
      {
        path: "src/index.ts",
        oldPath: "src/index.ts",
        startLine: 12,
        endLine: 12,
        side: "new",
      },
      [
        {
          old_path: "src/index.ts",
          new_path: "src/index.ts",
          diff: "@@ -11,2 +11,3 @@\n context line\n+added line\n trailing context",
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ],
      {
        id: 1,
        base_commit_sha: "base",
        start_commit_sha: "start",
        head_commit_sha: "head",
        created_at: new Date().toISOString(),
      },
    );

    expect(position).toEqual({
      base_sha: "base",
      start_sha: "start",
      head_sha: "head",
      position_type: "text",
      old_path: "src/index.ts",
      new_path: "src/index.ts",
      new_line: 12,
    });
  });

  it("returns null when the anchor line is not present in the diff hunk", () => {
    const position = buildDiffPosition(
      {
        path: "src/index.ts",
        oldPath: "src/index.ts",
        startLine: 12,
        endLine: 12,
        side: "new",
      },
      [
        {
          old_path: "src/index.ts",
          new_path: "src/index.ts",
          diff: "@@ -30,2 +30,3 @@\n context line\n+added line\n trailing context",
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ],
      {
        id: 1,
        base_commit_sha: "base",
        start_commit_sha: "start",
        head_commit_sha: "head",
        created_at: new Date().toISOString(),
      },
    );

    expect(position).toBeNull();
  });

  it("builds a file position when the anchor maps to a changed file", () => {
    const position = buildFilePosition(
      {
        path: "src/index.ts",
        oldPath: "src/index.ts",
      },
      [
        {
          old_path: "src/index.ts",
          new_path: "src/index.ts",
          diff: "@@ -30,2 +30,3 @@\n context line\n+added line\n trailing context",
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ],
      {
        id: 1,
        base_commit_sha: "base",
        start_commit_sha: "start",
        head_commit_sha: "head",
        created_at: new Date().toISOString(),
      },
    );

    expect(position).toEqual({
      base_sha: "base",
      start_sha: "start",
      head_sha: "head",
      position_type: "file",
      old_path: "src/index.ts",
      new_path: "src/index.ts",
    });
  });

  it("prefers a changed line inside a broader new-side anchor range", () => {
    const position = buildDiffPosition(
      {
        path: "src/index.ts",
        oldPath: "src/index.ts",
        startLine: 11,
        endLine: 13,
        side: "new",
      },
      [
        {
          old_path: "src/index.ts",
          new_path: "src/index.ts",
          diff: "@@ -11,3 +11,4 @@\n context line\n+added line\n trailing context\n",
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ],
      {
        id: 1,
        base_commit_sha: "base",
        start_commit_sha: "start",
        head_commit_sha: "head",
        created_at: new Date().toISOString(),
      },
    );

    expect(position).toEqual({
      base_sha: "base",
      start_sha: "start",
      head_sha: "head",
      position_type: "text",
      old_path: "src/index.ts",
      new_path: "src/index.ts",
      new_line: 12,
    });
  });

  it("includes both line numbers when anchoring an unchanged context line", () => {
    const position = buildDiffPosition(
      {
        path: "src/index.ts",
        oldPath: "src/index.ts",
        startLine: 11,
        endLine: 11,
        side: "new",
      },
      [
        {
          old_path: "src/index.ts",
          new_path: "src/index.ts",
          diff: "@@ -11,2 +11,3 @@\n context line\n+added line\n trailing context",
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ],
      {
        id: 1,
        base_commit_sha: "base",
        start_commit_sha: "start",
        head_commit_sha: "head",
        created_at: new Date().toISOString(),
      },
    );

    expect(position).toEqual({
      base_sha: "base",
      start_sha: "start",
      head_sha: "head",
      position_type: "text",
      old_path: "src/index.ts",
      new_path: "src/index.ts",
      old_line: 11,
      new_line: 11,
    });
  });

  it("renders a suggestion only for single-line new-side anchors", () => {
    const suggestion = renderSuggestionMarkdown(
      {
        replacement: "return 42;",
        startLine: 8,
        endLine: 8,
      },
      {
        path: "src/index.ts",
        startLine: 8,
        endLine: 8,
        side: "new",
      },
    );

    expect(suggestion).toBe("```suggestion:-0+0\nreturn 42;\n```");
    expect(
      renderSuggestionMarkdown(
        {
          replacement: "const answer = 42;\nreturn answer;",
          startLine: 8,
          endLine: 9,
        },
        {
          path: "src/index.ts",
          startLine: 8,
          endLine: 9,
          side: "new",
        },
      ),
    ).toBe("```suggestion:-0+1\nconst answer = 42;\nreturn answer;\n```");
    expect(
      renderSuggestionMarkdown(
        {
          replacement: "return 42;",
          startLine: 8,
          endLine: 9,
        },
        {
          path: "src/index.ts",
          startLine: 10,
          endLine: 10,
          side: "new",
        },
      ),
    ).toBeNull();
  });
});
