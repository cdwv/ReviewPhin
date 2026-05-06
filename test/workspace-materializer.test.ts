import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitLabApiError } from "../src/gitlab/client.js";
import { WorkspaceMaterializer } from "../src/gitlab/workspace.js";
import { createLogger } from "../src/logger.js";

describe("WorkspaceMaterializer", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("uses git checkout as the primary materialization strategy", async () => {
    const workspaceRoot = await createTempRoot();
    const downloadRepositoryArchive = vi.fn();
    const getRawFile = vi.fn();
    const listRepositoryTree = vi.fn();
    const gitRunner = vi.fn(async ({ cwd, args }) => {
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
      mergeRequestIid: 7,
      headSha: "abc123",
      changes: [],
    });

    expect(workspace.strategy).toBe("git");
    expect(await readFile(join(workspace.rootPath, "AGENTS.md"), "utf8")).toBe(
      "# Root instructions\n",
    );
    expect(gitRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["fetch", "--depth", "1", "origin", "abc123"],
        env: expect.objectContaining({ TEST_ENV: "1" }),
      }),
    );
    expect(downloadRepositoryArchive).not.toHaveBeenCalled();
    expect(getRawFile).not.toHaveBeenCalled();
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
        downloadRepositoryArchive: vi.fn(async () => archiveBuffer),
        getRawFile: vi.fn(),
        listRepositoryTree: vi.fn(),
      } as never,
      jobId: "job_2",
      projectId: 1085,
      mergeRequestIid: 7,
      headSha: "abc123",
      changes: [],
    });

    expect(workspace.strategy).toBe("archive");
    expect(workspace.rootPath).toBe(join(workspace.cleanupRoot, "workspace"));
    expect(await readFile(join(workspace.rootPath, "AGENTS.md"), "utf8")).toBe(
      "# Archived instructions\n",
    );
  });

  it("falls back to targeted files when git and archive fail", async () => {
    const workspaceRoot = await createTempRoot();
    const getRawFile = vi.fn(async (_projectId: number, filePath: string) => {
      if (filePath === "src/index.ts") {
        return "console.log('ok');\n";
      }

      if (filePath === "AGENTS.md") {
        return "# File instructions\n";
      }

      if (filePath === ".github/instructions/review.instructions.md") {
        return "Follow the review guide.\n";
      }

      throw new GitLabApiError(
        "not found",
        404,
        "missing",
        "https://gitlab.example.com",
      );
    });

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
        listRepositoryTree: vi.fn(async () => [
          {
            id: "blob_1",
            name: "review.instructions.md",
            type: "blob",
            path: ".github/instructions/review.instructions.md",
            mode: "100644",
          },
        ]),
      } as never,
      jobId: "job_3",
      projectId: 1085,
      mergeRequestIid: 7,
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
      await readFile(join(workspace.rootPath, "src", "index.ts"), "utf8"),
    ).toBe("console.log('ok');\n");
    expect(workspace.instructionFiles.map((file) => file.path)).toEqual([
      "AGENTS.md",
      ".github/instructions/review.instructions.md",
    ]);
    expect(getRawFile).toHaveBeenCalledWith(1085, "src/index.ts", "abc123");
  });

  async function createTempRoot(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    tempRoots.push(path);
    return path;
  }
});
