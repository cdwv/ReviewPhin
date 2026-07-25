import { describe, expect, it, vi } from "vitest";

import {
  executeGitReadonly,
  type GitReadonlyExecutionContext,
  type GitReadonlyRunner,
} from "../src/harness/git-readonly.js";
import { assertGitBoundaryMatchesPlatform } from "../src/platforms/git-workspace.js";
import { repoPath, tmpPath } from "./test-paths.js";

describe("executeGitReadonly", () => {
  const context: GitReadonlyExecutionContext = {
    workspacePath: repoPath(),
    baseRef: "refs/reviewphin/base",
    headRef: "refs/reviewphin/head",
    emptyGitConfigPath: tmpPath("empty-git-config"),
  };

  it("maps structured diff input to the trusted base/head range", async () => {
    const runner = successfulRunner("diff output");

    const result = await executeGitReadonly(
      {
        operation: "diff",
        revision: "range",
        path: "src/review/provider.ts",
        contextLines: 5,
      },
      context,
      runner,
    );

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: repoPath(),
        args: [
          "--no-pager",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--unified=5",
          "refs/reviewphin/base",
          "refs/reviewphin/head",
          "--",
          ":(literal)src/review/provider.ts",
        ],
        timeoutMs: 15_000,
        maxOutputBytes: 102_400,
      }),
    );
    const call = vi.mocked(runner).mock.calls[0]?.[0];
    expect(call?.env).toEqual(
      expect.objectContaining({
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_LFS_SKIP_SMUDGE: "1",
      }),
    );
    expect(call?.env).not.toHaveProperty("GIT_CONFIG_COUNT");
    expect(call?.env).not.toHaveProperty("GIT_ASKPASS");
    expect(call?.env).not.toHaveProperty("GIT_HTTP_EXTRA_HEADER");
    expect(result).toContain("operation=diff");
    expect(result).toContain("diff output");
  });

  it.each([
    { operation: "checkout" },
    { operation: "branch" },
    { operation: "diff", args: ["--output=stolen"] },
    { operation: "status", path: "src/index.ts" },
    { operation: "show", revision: "range" },
    { operation: "diff", revision: "base" },
    { operation: "blame" },
  ])("rejects unsupported or invalid input %#", async (input) => {
    const runner = successfulRunner("");
    await expect(executeGitReadonly(input, context, runner)).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    "../outside.ts",
    "src/../../outside.ts",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    ":(attr:filter)src/index.ts",
    "-c",
    ".git/config",
    ".git\\config",
  ])("rejects unsafe path %s", async (path) => {
    const runner = successfulRunner("");
    await expect(
      executeGitReadonly(
        { operation: "show", revision: "head", path },
        context,
        runner,
      ),
    ).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it("makes output truncation explicit", async () => {
    const runner = vi.fn<GitReadonlyRunner>(async () => ({
      stdout: "partial",
      stderr: "",
      exitCode: null,
      timedOut: false,
      truncated: true,
    }));

    await expect(
      executeGitReadonly({ operation: "log" }, context, runner),
    ).resolves.toContain("output truncated at 102400 bytes");
  });

  it("turns timeouts and failures into narrow retry guidance", async () => {
    const timedOut = vi.fn<GitReadonlyRunner>(async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
      truncated: false,
    }));
    await expect(
      executeGitReadonly(
        { operation: "blame", path: "src/index.ts" },
        context,
        timedOut,
      ),
    ).rejects.toThrow("narrow the request by path, revision, or line range");

    const failed = vi.fn<GitReadonlyRunner>(async () => ({
      stdout: "",
      stderr: "bad revision",
      exitCode: 128,
      timedOut: false,
      truncated: false,
    }));
    await expect(
      executeGitReadonly(
        { operation: "rev-parse", revision: "base" },
        context,
        failed,
      ),
    ).rejects.toThrow("bad revision");
  });
});

describe("assertGitBoundaryMatchesPlatform", () => {
  it("accepts modified, renamed, deleted, and binary path boundaries", () => {
    expect(() =>
      assertGitBoundaryMatchesPlatform(
        [
          "M\0src/index.ts\0",
          "R100\0src/old.ts\0src/new.ts\0",
          "D\0public/old.png\0",
          "A\0public/new.png\0",
        ].join(""),
        [
          change("src/index.ts"),
          {
            ...change("src/new.ts"),
            oldPath: "src/old.ts",
            renamedFile: true,
          },
          {
            ...change("public/old.png"),
            deletedFile: true,
          },
          {
            ...change("public/new.png"),
            newFile: true,
          },
        ],
      ),
    ).not.toThrow();
  });

  it("rejects a prepared Git boundary that differs from the platform snapshot", () => {
    expect(() =>
      assertGitBoundaryMatchesPlatform("M\0src/other.ts\0", [
        change("src/index.ts"),
      ]),
    ).toThrow("does not match the platform snapshot");
  });
});

function successfulRunner(stdout: string) {
  return vi.fn<GitReadonlyRunner>(async () => ({
    stdout,
    stderr: "",
    exitCode: 0,
    timedOut: false,
    truncated: false,
  }));
}

function change(path: string) {
  return {
    oldPath: path,
    newPath: path,
    newFile: false,
    renamedFile: false,
    deletedFile: false,
  };
}
