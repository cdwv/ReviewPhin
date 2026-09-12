import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitLabApiError,
  GitLabClient,
} from "../src/platforms/gitlab/client.js";
import { WorkspaceMaterializer } from "../src/platforms/gitlab/workspace.js";
import { createLogger } from "../src/logger.js";

describe("WorkspaceMaterializer", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all(
      tempRoots
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it.each([
    { name: "invalid UTF-8", bytes: new Uint8Array([0xff]), valid: false },
    {
      name: "valid UTF-8 with BOM",
      bytes: new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...Buffer.from("Flipperly yours 🐬"),
      ]),
      valid: true,
    },
  ])(
    "preserves raw customization bytes in targeted fallback: $name",
    async ({ bytes, valid }) => {
      const workspaceRoot = await createTempRoot();
      const client = new GitLabClient({
        baseUrl: "https://gitlab.example.com",
        apiToken: "test-token",
        logger: createLogger("silent"),
      });
      vi.spyOn(client, "getProject").mockRejectedValue(
        new Error("git unavailable"),
      );
      vi.spyOn(client, "downloadRepositoryArchive").mockRejectedValue(
        new Error("archive unavailable"),
      );
      const textRead = vi.spyOn(client, "getRawFile").mockResolvedValue("");
      vi.spyOn(client, "listRepositoryTree").mockImplementation(
        async (_project, _ref, path) =>
          path === ".reviewphin"
            ? [
                {
                  id: "blob",
                  name: "AGENTS.md",
                  path: ".reviewphin/AGENTS.md",
                  type: "blob",
                  mode: "100644",
                },
              ]
            : [],
      );
      const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
        expect(String(url)).toBe(
          "https://gitlab.example.com/api/v4/projects/1085/repository/files/.reviewphin%2FAGENTS.md/raw?ref=abc123",
        );
        return new Response(bytes);
      });
      vi.stubGlobal("fetch", fetchMock);
      const materializer = new WorkspaceMaterializer({
        workspaceRoot,
        logger: createLogger("silent"),
      });
      const result = materializer.materialize({
        client,
        jobId: "raw-bytes",
        projectId: 1085,
        codeReviewId: 7,
        baseSha: "base123",
        headSha: "abc123",
        changes: [
          {
            old_path: ".reviewphin/AGENTS.md",
            new_path: ".reviewphin/AGENTS.md",
            diff: "@@",
            new_file: true,
            renamed_file: false,
            deleted_file: false,
          },
        ],
      });
      const outputPath = join(
        workspaceRoot,
        "raw-bytes/workspace/.reviewphin/AGENTS.md",
      );
      if (valid) {
        expect((await result).strategy).toBe("targeted-files");
        expect(await readFile(outputPath)).toEqual(Buffer.from(bytes));
      } else {
        await expect(result).rejects.toThrow(
          "Cannot read customization as UTF-8 text: .reviewphin/AGENTS.md",
        );
        await expect(access(outputPath)).rejects.toThrow();
      }
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(textRead).not.toHaveBeenCalledWith(
        1085,
        ".reviewphin/AGENTS.md",
        "abc123",
      );
    },
  );

  it("uses git checkout as the primary materialization strategy", async () => {
    const workspaceRoot = await createTempRoot();
    const downloadRepositoryArchive = vi.fn();
    const getRawFile = vi.fn();
    const listRepositoryTree = vi.fn();
    const gitRunner = vi.fn(async ({ cwd, args }) => {
      if (args[0] === "diff") {
        return {
          stdout: args.includes("--raw")
            ? ":100644 100644 aaaa bbbb M\0src/index.ts\0"
            : "5\t3\tsrc/index.ts\0",
          stderr: "",
        };
      }
      if (args[0] === "-c" && args[2] === "checkout") {
        await mkdir(join(cwd, ".git"), { recursive: true });
        await writeFile(join(cwd, "AGENTS.md"), "# Root instructions\n");
      }

      return { stdout: "", stderr: "" };
    });

    const materializer = new WorkspaceMaterializer({
      workspaceRoot,
      logger: createLogger("silent"),
      gitRunner,
    });

    const workspace = await materializer.materialize({
      client: {
        getProject: async () => ({
          id: 1085,
          web_url: "https://gitlab.example.com/group/project",
          path_with_namespace: "group/project",
          http_url_to_repo: "https://gitlab.example.com/group/project.git",
        }),
        buildGitAuthEnv: () => ({ TEST_ENV: "1" }),
        downloadRepositoryArchive,
        getRawFile,
        listRepositoryTree,
      } as never,
      jobId: "job_1",
      projectId: 1085,
      codeReviewId: 7,
      baseSha: "base123",
      headSha: "abc123",
      changes: [],
    });

    expect(workspace.strategy).toBe("git");
    expect(await readFile(join(workspace.rootPath, "AGENTS.md"), "utf8")).toBe(
      "# Root instructions\n",
    );
    expect(gitRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["fetch", "--no-tags", "origin", "abc123"],
        env: expect.objectContaining({ TEST_ENV: "1" }),
      }),
    );
    expect(gitRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["fetch", "--no-tags", "origin", "base123"],
      }),
    );
    expect(gitRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["remote", "remove", "origin"],
      }),
    );
    expect(
      gitRunner.mock.calls.some(([call]) =>
        (call as { args: string[] }).args.includes("--depth"),
      ),
    ).toBe(false);
    expect(workspace.gitInspection).toEqual(
      expect.objectContaining({
        baseRef: "refs/reviewphin/base",
        headRef: "refs/reviewphin/head",
      }),
    );
    expect(workspace.gitChanges).toEqual([
      {
        oldPath: "src/index.ts",
        newPath: "src/index.ts",
        additions: 5,
        deletions: 3,
        contentSignature: "git-raw-v2:100644:aaaa:100644:bbbb",
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      },
    ]);
    expect(downloadRepositoryArchive).not.toHaveBeenCalled();
    expect(getRawFile).not.toHaveBeenCalled();
  });

  it("disables tag fetching when the exact head SHA falls back to the merge request ref", async () => {
    const workspaceRoot = await createTempRoot();
    const gitRunner = vi.fn(async ({ args }) => {
      if (
        args[0] === "fetch" &&
        args.at(-1) === "abc123" &&
        !args.includes("refs/merge-requests/7/head")
      ) {
        throw new Error("exact SHA unavailable");
      }
      if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD") {
        return { stdout: "abc123\n", stderr: "" };
      }
      if (args[0] === "diff") {
        return {
          stdout: args.includes("--raw")
            ? ":100644 100644 aaaa bbbb M\0src/index.ts\0"
            : "1\t1\tsrc/index.ts\0",
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    });
    const materializer = new WorkspaceMaterializer({
      workspaceRoot,
      logger: createLogger("silent"),
      gitRunner,
    });

    const workspace = await materializer.materialize({
      client: {
        getProject: async () => ({
          id: 1085,
          web_url: "https://gitlab.example.com/group/project",
          path_with_namespace: "group/project",
          http_url_to_repo: "https://gitlab.example.com/group/project.git",
        }),
        buildGitAuthEnv: () => ({}),
        downloadRepositoryArchive: vi.fn(),
        getRawFile: vi.fn(),
        listRepositoryTree: vi.fn(),
      } as never,
      jobId: "job_fallback",
      projectId: 1085,
      codeReviewId: 7,
      baseSha: "base123",
      headSha: "abc123",
      changes: [],
    });

    expect(workspace.strategy).toBe("git");
    expect(gitRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["fetch", "--no-tags", "origin", "refs/merge-requests/7/head"],
      }),
    );
  });

  it("falls back to the archive API when git checkout fails", async () => {
    const workspaceRoot = await createTempRoot();
    const archiveSourceRoot = await createTempRoot();
    const repoDir = join(archiveSourceRoot, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, "AGENTS.md"), "# Archived instructions\n");
    const archivePath = join(archiveSourceRoot, "repo.tar.gz");
    await tar.c(
      {
        cwd: archiveSourceRoot,
        gzip: true,
        file: archivePath,
      },
      ["repo"],
    );
    const archiveBuffer = await readFile(archivePath);

    const materializer = new WorkspaceMaterializer({
      workspaceRoot,
      logger: createLogger("silent"),
      gitRunner: vi.fn(async ({ cwd }) => {
        await mkdir(join(cwd, ".git"), { recursive: true });
        await writeFile(join(cwd, ".git", "config"), "stale remote");
        await writeFile(join(cwd, "partial-checkout.ts"), "stale checkout");
        throw new Error("git failed");
      }),
    });

    const workspace = await materializer.materialize({
      client: {
        getProject: async () => ({
          id: 1085,
          web_url: "https://gitlab.example.com/group/project",
          path_with_namespace: "group/project",
          http_url_to_repo: "https://gitlab.example.com/group/project.git",
        }),
        buildGitAuthEnv: () => ({}),
        downloadRepositoryArchive: vi.fn(async () => archiveBuffer),
        getRawFile: vi.fn(),
        listRepositoryTree: vi.fn(),
      } as never,
      jobId: "job_2",
      projectId: 1085,
      codeReviewId: 7,
      baseSha: "base123",
      headSha: "abc123",
      changes: [],
    });

    expect(workspace.strategy).toBe("archive");
    expect(workspace.gitPreparationError).toBe("git failed");
    expect(workspace.rootPath).toBe(join(workspace.cleanupRoot, "workspace"));
    expect(await readFile(join(workspace.rootPath, "AGENTS.md"), "utf8")).toBe(
      "# Archived instructions\n",
    );
    await expect(access(join(workspace.rootPath, ".git"))).rejects.toThrow();
    await expect(
      access(join(workspace.rootPath, "partial-checkout.ts")),
    ).rejects.toThrow();
  });

  it("falls back to targeted files when git and archive fail", async () => {
    const workspaceRoot = await createTempRoot();
    const getRawFile = vi.fn(
      async (_projectId: number, filePath: string, _ref?: string) => {
        if (filePath === "src/index.ts") {
          return "console.log('ok');\n";
        }

        if (filePath === "AGENTS.md") {
          return "# File instructions\n";
        }

        if (filePath === ".github/instructions/review.instructions.md") {
          return "Follow the review guide.\n";
        }

        if (filePath === ".reviewphin/AGENTS.md") return "Flipperly yours\n";
        if (filePath === ".reviewphin/skills/review/SKILL.md")
          return "Review skill\n";
        if (filePath === ".reviewphin/skills/review/references/checklist.md")
          return "Review reference\n";

        throw new GitLabApiError(
          "not found",
          404,
          "missing",
          "https://gitlab.example.com",
        );
      },
    );

    const materializer = new WorkspaceMaterializer({
      workspaceRoot,
      logger: createLogger("silent"),
      gitRunner: vi.fn(async () => {
        throw new Error("git failed");
      }),
    });

    const workspace = await materializer.materialize({
      client: {
        getProject: async () => ({
          id: 1085,
          web_url: "https://gitlab.example.com/group/project",
          path_with_namespace: "group/project",
          http_url_to_repo: "https://gitlab.example.com/group/project.git",
        }),
        buildGitAuthEnv: () => ({}),
        downloadRepositoryArchive: vi.fn(async () => {
          throw new GitLabApiError(
            "archive failed",
            406,
            "nope",
            "https://gitlab.example.com",
          );
        }),
        getRawFile,
        getRawFileBytes: async (projectId: number, path: string, ref: string) =>
          Buffer.from(await getRawFile(projectId, path, ref)),
        listRepositoryTree: vi.fn(async () => [
          ...[
            ".reviewphin/AGENTS.md",
            ".reviewphin/skills/review/SKILL.md",
            ".reviewphin/skills/review/references/checklist.md",
          ].map((path) => ({
            id: path,
            name: path.split("/").at(-1)!,
            type: "blob",
            path,
            mode: "100644",
          })),
          {
            id: "unsafe",
            name: "escape.md",
            type: "blob",
            path: ".reviewphin/../escape.md",
            mode: "100644",
          },
          {
            id: "blob_1",
            name: "review.instructions.md",
            type: "blob",
            path: ".github/instructions/review.instructions.md",
            mode: "100644",
          },
          {
            id: "blob_2",
            name: "README.md",
            type: "blob",
            path: ".github/instructions/README.md",
            mode: "100644",
          },
        ]),
      } as never,
      jobId: "job_3",
      projectId: 1085,
      codeReviewId: 7,
      baseSha: "base123",
      headSha: "abc123",
      changes: [
        {
          old_path: "src/index.ts",
          new_path: "src/index.ts",
          diff: "@@",
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ],
    });

    expect(workspace.strategy).toBe("targeted-files");
    expect(
      await readFile(join(workspace.rootPath, ".reviewphin/AGENTS.md"), "utf8"),
    ).toBe("Flipperly yours\n");
    expect(
      await readFile(
        join(
          workspace.rootPath,
          ".reviewphin/skills/review/references/checklist.md",
        ),
        "utf8",
      ),
    ).toBe("Review reference\n");
    expect(getRawFile).toHaveBeenCalledWith(
      1085,
      ".reviewphin/AGENTS.md",
      "abc123",
    );
    expect(getRawFile).not.toHaveBeenCalledWith(
      1085,
      ".reviewphin/../escape.md",
      "abc123",
    );
    expect(workspace.gitPreparationError).toBe("git failed");
    expect(
      await readFile(join(workspace.rootPath, "src", "index.ts"), "utf8"),
    ).toBe("console.log('ok');\n");
    expect(await readFile(join(workspace.rootPath, "AGENTS.md"), "utf8")).toBe(
      "# File instructions\n",
    );
    expect(
      await readFile(
        join(
          workspace.rootPath,
          ".github",
          "instructions",
          "review.instructions.md",
        ),
        "utf8",
      ),
    ).toBe("Follow the review guide.\n");
    expect(getRawFile).toHaveBeenCalledWith(1085, "src/index.ts", "abc123");
    expect(getRawFile).not.toHaveBeenCalledWith(
      1085,
      ".github/instructions/README.md",
      "abc123",
    );
  });

  it("clears leftover workspace files before attempting git checkout", async () => {
    const workspaceRoot = await createTempRoot();
    const staleWorkspaceRoot = join(workspaceRoot, "job_4", "workspace");
    await mkdir(staleWorkspaceRoot, { recursive: true });
    await writeFile(join(staleWorkspaceRoot, "stale.txt"), "leftover\n");

    const gitRunner = vi.fn(async ({ cwd, args }) => {
      if (args[0] === "-c" && args[2] === "checkout") {
        await expect(
          readFile(join(cwd, "stale.txt"), "utf8"),
        ).rejects.toThrow();
        await mkdir(join(cwd, ".git"), { recursive: true });
        await writeFile(join(cwd, "AGENTS.md"), "# Fresh instructions\n");
      }

      return { stdout: "", stderr: "" };
    });

    const materializer = new WorkspaceMaterializer({
      workspaceRoot,
      logger: createLogger("silent"),
      gitRunner,
    });

    const workspace = await materializer.materialize({
      client: {
        getProject: async () => ({
          id: 1085,
          web_url: "https://gitlab.example.com/group/project",
          path_with_namespace: "group/project",
          http_url_to_repo: "https://gitlab.example.com/group/project.git",
        }),
        buildGitAuthEnv: () => ({}),
        downloadRepositoryArchive: vi.fn(),
        getRawFile: vi.fn(),
        listRepositoryTree: vi.fn(),
      } as never,
      jobId: "job_4",
      projectId: 1085,
      codeReviewId: 7,
      baseSha: "base123",
      headSha: "abc123",
      changes: [],
    });

    expect(workspace.strategy).toBe("git");
    await expect(
      readFile(join(workspace.rootPath, "stale.txt"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(join(workspace.rootPath, "AGENTS.md"), "utf8")).toBe(
      "# Fresh instructions\n",
    );
  });

  it("isolates cleanup between attempts for the same job", async () => {
    const workspaceRoot = await createTempRoot();
    const client = {
      getProject: async () => ({
        id: 1085,
        web_url: "https://gitlab.example.com/group/project",
        path_with_namespace: "group/project",
        http_url_to_repo: "https://gitlab.example.com/group/project.git",
      }),
      buildGitAuthEnv: () => ({}),
      downloadRepositoryArchive: vi.fn(),
      getRawFile: vi.fn(),
      listRepositoryTree: vi.fn(),
    } as never;
    const gitRunner = vi.fn(async ({ cwd, args }) => {
      if (args[0] === "-c" && args[2] === "checkout") {
        await mkdir(join(cwd, ".git"), { recursive: true });
        await writeFile(join(cwd, "attempt.txt"), cwd);
      }
      return { stdout: "", stderr: "" };
    });
    const oldAttempt = new WorkspaceMaterializer({
      workspaceRoot,
      workspaceAttemptId: "claim-old",
      logger: createLogger("silent"),
      gitRunner,
    });
    const replacementAttempt = new WorkspaceMaterializer({
      workspaceRoot,
      workspaceAttemptId: "claim-new",
      logger: createLogger("silent"),
      gitRunner,
    });
    const input = {
      client,
      jobId: "job-shared",
      projectId: 1085,
      codeReviewId: 7,
      baseSha: "base123",
      headSha: "abc123",
      changes: [],
    };

    const staleWorkspace = await oldAttempt.materialize(input);
    const activeWorkspace = await replacementAttempt.materialize(input);
    expect(staleWorkspace.cleanupRoot).not.toBe(activeWorkspace.cleanupRoot);

    await oldAttempt.cleanup(staleWorkspace);

    expect(
      await readFile(join(activeWorkspace.rootPath, "attempt.txt"), "utf8"),
    ).toBe(activeWorkspace.rootPath);
  });

  async function createTempRoot(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "reviewphin-"));
    tempRoots.push(path);
    return path;
  }
});
