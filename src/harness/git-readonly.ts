import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { z } from "zod";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_OUTPUT_BYTES = 100 * 1024;
const DEFAULT_LOG_COUNT = 25;
const DEFAULT_DIFF_CONTEXT = 3;

const gitReadonlyInputSchema = z
  .object({
    operation: z.enum([
      "status",
      "diff",
      "log",
      "show",
      "list-branches",
      "rev-parse",
      "ls-files",
      "blame",
    ]),
    revision: z.enum(["base", "head", "range"]).optional(),
    path: z.string().min(1).max(4_096).optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    maxCount: z.number().int().min(1).max(100).optional(),
    contextLines: z.number().int().min(0).max(20).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const operationsAcceptingPath = [
      "diff",
      "log",
      "show",
      "ls-files",
      "blame",
    ];
    if (input.path && !operationsAcceptingPath.includes(input.operation)) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: `${input.operation} does not accept a path`,
      });
    }
    const operationsAcceptingRevision = [
      "diff",
      "log",
      "show",
      "rev-parse",
      "blame",
    ];
    if (
      input.revision &&
      !operationsAcceptingRevision.includes(input.operation)
    ) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: `${input.operation} does not accept a revision`,
      });
    }
    if (
      input.operation === "diff" &&
      input.revision !== undefined &&
      input.revision !== "range"
    ) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "diff compares only the trusted base/head range",
      });
    }
    if (
      input.revision === "range" &&
      !["diff", "log"].includes(input.operation)
    ) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: `${input.operation} does not accept the range revision`,
      });
    }
    if (
      (input.lineStart !== undefined || input.lineEnd !== undefined) &&
      input.operation !== "blame"
    ) {
      context.addIssue({
        code: "custom",
        path: ["lineStart"],
        message: "line ranges are only accepted by blame",
      });
    }
    if (input.operation === "blame" && !input.path) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "blame requires a repository-relative path",
      });
    }
    if (
      input.lineStart !== undefined &&
      input.lineEnd !== undefined &&
      input.lineEnd < input.lineStart
    ) {
      context.addIssue({
        code: "custom",
        path: ["lineEnd"],
        message: "lineEnd must be greater than or equal to lineStart",
      });
    }
    if (input.maxCount !== undefined && input.operation !== "log") {
      context.addIssue({
        code: "custom",
        path: ["maxCount"],
        message: "maxCount is only accepted by log",
      });
    }
    if (input.contextLines !== undefined && input.operation !== "diff") {
      context.addIssue({
        code: "custom",
        path: ["contextLines"],
        message: "contextLines is only accepted by diff",
      });
    }
  });

export type GitReadonlyInput = z.infer<typeof gitReadonlyInputSchema>;

export interface GitReadonlyCapability {
  baseRef: "refs/reviewphin/base";
  headRef: "refs/reviewphin/head";
  emptyGitConfigPath: string;
}

export interface GitReadonlyExecutionContext extends GitReadonlyCapability {
  workspacePath: string;
}

export interface GitReadonlyRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export type GitReadonlyRunner = (input: {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}) => Promise<GitReadonlyRunnerResult>;

export const gitReadonlyParameters = {
  type: "object",
  additionalProperties: false,
  required: ["operation"],
  properties: {
    operation: {
      type: "string",
      enum: [
        "status",
        "diff",
        "log",
        "show",
        "list-branches",
        "rev-parse",
        "ls-files",
        "blame",
      ],
      description: "The fixed read-only Git operation to run",
    },
    revision: {
      type: "string",
      enum: ["base", "head", "range"],
      description:
        "A trusted prepared revision. range compares the review base and head and is accepted only by diff and log.",
    },
    path: {
      type: "string",
      description:
        "Optional repository-relative literal path. Absolute paths, parent traversal, pathspec magic, and .git paths are rejected.",
    },
    lineStart: {
      type: "integer",
      minimum: 1,
      description: "Optional first line for blame",
    },
    lineEnd: {
      type: "integer",
      minimum: 1,
      description: "Optional last line for blame",
    },
    maxCount: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Maximum number of commits returned by log",
    },
    contextLines: {
      type: "integer",
      minimum: 0,
      maximum: 20,
      description: "Unified context line count for diff",
    },
  },
} as const;

export async function executeGitReadonly(
  rawInput: unknown,
  context: GitReadonlyExecutionContext,
  runner: GitReadonlyRunner = runGit,
): Promise<string> {
  const input = gitReadonlyInputSchema.parse(rawInput);
  const normalizedPath = input.path
    ? validateRepositoryPath(input.path, context.workspacePath)
    : null;
  const args = buildGitArgs(input, context, normalizedPath);
  const startedAt = performance.now();
  const result = await runner({
    cwd: resolve(context.workspacePath),
    args,
    env: buildMinimalGitEnvironment(context.emptyGitConfigPath),
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
  });
  const durationMs = Math.round(performance.now() - startedAt);

  if (result.timedOut && !result.truncated) {
    throw new Error(
      `git_readonly ${input.operation} exceeded the ${GIT_TIMEOUT_MS}ms time limit; narrow the request by path, revision, or line range`,
    );
  }
  if (!result.truncated && result.exitCode !== 0 && result.exitCode !== null) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `git_readonly ${input.operation} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ""}`,
    );
  }

  const output = [result.stdout, result.stderr]
    .filter((value) => value.length > 0)
    .join(result.stdout && result.stderr ? "\n" : "")
    .trimEnd();
  const metadata = `[git_readonly operation=${input.operation} durationMs=${durationMs} truncated=${result.truncated}]`;
  if (result.truncated) {
    return `${metadata}\n${output}\n[output truncated at ${GIT_MAX_OUTPUT_BYTES} bytes; narrow by path, revision, or line range]`;
  }
  return `${metadata}\n${output || "(no output)"}`;
}

function buildGitArgs(
  input: GitReadonlyInput,
  context: GitReadonlyExecutionContext,
  path: string | null,
): string[] {
  const revision = resolveRevision(input.revision, context);
  const pathArgs = path ? ["--", `:(literal)${path}`] : [];

  switch (input.operation) {
    case "status":
      return [
        "--no-pager",
        "status",
        "--short",
        "--branch",
        "--untracked-files=no",
      ];
    case "diff":
      return [
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        `--unified=${input.contextLines ?? DEFAULT_DIFF_CONTEXT}`,
        context.baseRef,
        context.headRef,
        ...pathArgs,
      ];
    case "log":
      return [
        "--no-pager",
        "log",
        "--no-decorate",
        `--max-count=${input.maxCount ?? DEFAULT_LOG_COUNT}`,
        "--format=%H%x09%aI%x09%an%x09%s",
        revision,
        ...pathArgs,
      ];
    case "show":
      return [
        "--no-pager",
        "show",
        "--no-ext-diff",
        "--no-textconv",
        "--format=fuller",
        "--stat",
        "--patch",
        revision,
        ...pathArgs,
      ];
    case "list-branches":
      return [
        "--no-pager",
        "for-each-ref",
        "--format=%(refname)%09%(objectname)",
        "refs/heads/",
        "refs/remotes/",
        "refs/reviewphin/",
      ];
    case "rev-parse":
      return ["--no-pager", "rev-parse", "--verify", `${revision}^{commit}`];
    case "ls-files":
      return ["--no-pager", "ls-files", ...pathArgs];
    case "blame": {
      const lineArgs =
        input.lineStart !== undefined || input.lineEnd !== undefined
          ? [
              "-L",
              `${input.lineStart ?? 1},${input.lineEnd ?? input.lineStart ?? 1}`,
            ]
          : [];
      return [
        "--no-pager",
        "blame",
        "--no-progress",
        ...lineArgs,
        revision,
        "--",
        path!,
      ];
    }
  }
}

function resolveRevision(
  revision: GitReadonlyInput["revision"],
  context: GitReadonlyExecutionContext,
): string {
  switch (revision) {
    case "base":
      return context.baseRef;
    case "range":
      return `${context.baseRef}..${context.headRef}`;
    case "head":
    case undefined:
      return context.headRef;
  }
}

function validateRepositoryPath(path: string, workspacePath: string): string {
  if (
    path.includes("\0") ||
    path.startsWith(":") ||
    path.startsWith("-") ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.startsWith("/") ||
    path.startsWith("\\\\")
  ) {
    throw new Error(
      "git_readonly path must be a literal repository-relative path",
    );
  }

  const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    segments.some((segment) => segment === "..") ||
    segments[0]?.toLowerCase() === ".git"
  ) {
    throw new Error(
      "git_readonly path must stay inside the workspace and cannot inspect .git",
    );
  }

  const workspaceRoot = resolve(workspacePath);
  const resolvedPath = resolve(workspaceRoot, ...segments);
  const workspaceRelative = relative(workspaceRoot, resolvedPath);
  if (
    workspaceRelative === ".." ||
    workspaceRelative.startsWith(`..\\`) ||
    workspaceRelative.startsWith("../") ||
    /^[a-zA-Z]:[\\/]/.test(workspaceRelative)
  ) {
    throw new Error("git_readonly path escapes the workspace");
  }
  return segments.join("/");
}

function buildMinimalGitEnvironment(
  emptyGitConfigPath: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
  ]) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: resolve(emptyGitConfigPath),
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_EXTERNAL_DIFF: "",
    GIT_DIFF_OPTS: "",
  };
}

async function runGit(input: {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<GitReadonlyRunnerResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let truncated = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (truncated) {
        return;
      }
      const remaining = input.maxOutputBytes - outputBytes;
      if (chunk.length > remaining) {
        if (remaining > 0) {
          target.push(chunk.subarray(0, remaining));
          outputBytes += remaining;
        }
        truncated = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
      outputBytes += chunk.length;
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        timedOut,
        truncated,
      });
    });
  });
}
