import { describe, expect, it, vi } from "vitest";

import {
  executeGitReadonly,
  type GitReadonlyExecutionContext,
  type GitReadonlyRunner,
} from "../src/harness/git-readonly.js";
import {
  buildGitReviewChanges,
  parseGitNumstat,
  parseGitRawChanges,
} from "../src/platforms/git-workspace.js";
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
      exitCode: 1,
      timedOut: false,
      truncated: true,
    }));

    await expect(
      executeGitReadonly({ operation: "log" }, context, runner),
    ).resolves.toContain("output truncated at 102400 bytes");
  });

  it("preserves truncation guidance when process closure races the timeout", async () => {
    const runner = vi.fn<GitReadonlyRunner>(async () => ({
      stdout: "partial",
      stderr: "",
      exitCode: null,
      timedOut: true,
      truncated: true,
    }));

    await expect(
      executeGitReadonly({ operation: "log" }, context, runner),
    ).resolves.toContain("output truncated at 102400 bytes");
  });

  it("passes a validated literal path directly to blame", async () => {
    const runner = successfulRunner("blame output");

    await executeGitReadonly(
      {
        operation: "blame",
        revision: "head",
        path: "src/index.ts",
        lineStart: 10,
        lineEnd: 20,
      },
      context,
      runner,
    );

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "--no-pager",
          "blame",
          "--no-progress",
          "-L",
          "10,20",
          "refs/reviewphin/head",
          "--",
          "src/index.ts",
        ],
      }),
    );
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

describe("Git-derived review manifest", () => {
  it("parses modified, renamed, deleted, copied, and binary entries", async () => {
    const raw = [
      ":100644 100644 aaaa bbbb M\0src/index.ts\0",
      ":100644 100644 cccc dddd R100\0src/old.ts\0src/new.ts\0",
      ":100644 000000 eeee 0000 D\0public/old.png\0",
      ":000000 100644 0000 ffff A\0public/new.png\0",
      ":100644 100644 1111 2222 C100\0src/source.ts\0src/copy.ts\0",
    ].join("");
    const numstat = [
      "4\t2\tsrc/index.ts\0",
      "1\t1\t\0src/old.ts\0src/new.ts\0",
      "-\t-\tpublic/old.png\0",
      "8\t0\tpublic/new.png\0",
      "3\t0\t\0src/source.ts\0src/copy.ts\0",
    ].join("");
    const gitRunner = vi.fn(async ({ args }: { args: string[] }) => ({
      stdout: args.includes("--raw") ? raw : numstat,
      stderr: "",
    }));

    await expect(
      buildGitReviewChanges({ cwd: "repo", gitRunner }),
    ).resolves.toEqual([
      {
        ...change("src/index.ts"),
        additions: 4,
        deletions: 2,
        contentSignature: "git-raw-v2:100644:aaaa:100644:bbbb",
      },
      {
        ...change("src/new.ts"),
        oldPath: "src/old.ts",
        additions: 1,
        deletions: 1,
        renamedFile: true,
        contentSignature: "git-raw-v2:100644:cccc:100644:dddd",
      },
      {
        ...change("public/old.png"),
        deletedFile: true,
        contentSignature: "git-raw-v2:100644:eeee:000000:0000",
      },
      {
        ...change("public/new.png"),
        additions: 8,
        deletions: 0,
        newFile: true,
        contentSignature: "git-raw-v2:000000:0000:100644:ffff",
      },
      {
        ...change("src/copy.ts"),
        additions: 3,
        deletions: 0,
        newFile: true,
        contentSignature: "git-raw-v2:100644:1111:100644:2222",
      },
    ]);
  });

  it("changes the content signature when only the file mode changes", async () => {
    const gitRunner = vi.fn(async ({ args }: { args: string[] }) => ({
      stdout: args.includes("--raw")
        ? ":100644 100755 aaaa aaaa M\0scripts/review.sh\0"
        : "0\t0\tscripts/review.sh\0",
      stderr: "",
    }));

    await expect(
      buildGitReviewChanges({ cwd: "repo", gitRunner }),
    ).resolves.toEqual([
      {
        ...change("scripts/review.sh"),
        additions: 0,
        deletions: 0,
        contentSignature: "git-raw-v2:100644:aaaa:100755:aaaa",
      },
    ]);
  });

  it("rejects malformed Git output instead of publishing a partial manifest", () => {
    expect(() => parseGitRawChanges("M\0src/index.ts\0")).toThrow(
      "Could not parse prepared Git raw change",
    );
    expect(() => parseGitNumstat("not-numstat\0")).toThrow(
      "Could not parse prepared Git numstat entry",
    );
  });

  it("rejects mismatched raw and numstat output", async () => {
    const gitRunner = vi.fn(async ({ args }: { args: string[] }) => ({
      stdout: args.includes("--raw")
        ? ":100644 100644 aaaa bbbb M\0src/index.ts\0"
        : "1\t0\tsrc/other.ts\0",
      stderr: "",
    }));

    await expect(
      buildGitReviewChanges({ cwd: "repo", gitRunner }),
    ).rejects.toThrow("Prepared Git manifest outputs disagree");
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
