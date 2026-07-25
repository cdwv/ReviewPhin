import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../src/platforms/github/client.js";
import { GitHubWorkspaceMaterializer } from "../src/platforms/github/workspace.js";

describe("GitHubWorkspaceMaterializer", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("prepares trusted Git refs, verifies the boundary, and removes the remote", async () => {
    const workspaceRoot = await createTempRoot();
    const gitRunner = vi.fn(
      async ({ cwd, args }: { cwd: string; args: string[] }) => {
        if (args[0] === "rev-parse") {
          return {
            stdout: args[1]?.includes("head") ? "head-sha\n" : "base-sha\n",
            stderr: "",
          };
        }
        if (args[0] === "diff") {
          return { stdout: "M\0src.ts\0", stderr: "" };
        }
        if (args[0] === "-c" && args[2] === "checkout") {
          await mkdir(join(cwd, ".git"), { recursive: true });
          await writeFile(join(cwd, "src.ts"), "export const ready = true;\n");
        }
        return { stdout: "", stderr: "" };
      },
    );
    const downloadRepositoryArchive = vi.fn();
    const materializer = new GitHubWorkspaceMaterializer({
      workspaceRoot,
      gitRunner,
    });

    const workspace = await materializer.materialize({
      client: {
        buildGitAuthEnv: vi.fn(async () => ({ TEST_GIT_AUTH: "1" })),
        downloadRepositoryArchive,
      } as unknown as GitHubClient,
      jobId: "job_git",
      repositoryFullName: "octo-org/reviewphin",
      codeReviewId: 42,
      baseSha: "base-sha",
      headSha: "head-sha",
      changes: [
        {
          oldPath: "src.ts",
          newPath: "src.ts",
          newFile: false,
          renamedFile: false,
          deletedFile: false,
        },
      ],
    });

    expect(workspace.strategy).toBe("git");
    expect(workspace.gitInspection).toEqual(
      expect.objectContaining({
        baseRef: "refs/reviewphin/base",
        headRef: "refs/reviewphin/head",
      }),
    );
    expect(gitRunner).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["remote", "remove", "origin"] }),
    );
    expect(
      gitRunner.mock.calls.some(([call]) =>
        (call as { args: string[] }).args.includes("--depth"),
      ),
    ).toBe(false);
    expect(downloadRepositoryArchive).not.toHaveBeenCalled();
  });

  it("falls back to the pull ref for a fork head and verifies its exact SHA", async () => {
    const workspaceRoot = await createTempRoot();
    const gitRunner = vi.fn(async ({ args }: { args: string[] }) => {
      if (args[0] === "fetch" && args.at(-1) === "head-sha") {
        throw new Error("SHA is not advertised by the base repository");
      }
      if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD") {
        return { stdout: "head-sha\n", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return {
          stdout: args[1]?.includes("head") ? "head-sha\n" : "base-sha\n",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const materializer = new GitHubWorkspaceMaterializer({
      workspaceRoot,
      gitRunner,
    });

    const workspace = await materializer.materialize({
      client: {
        buildGitAuthEnv: vi.fn(async () => ({})),
        downloadRepositoryArchive: vi.fn(),
      } as unknown as GitHubClient,
      jobId: "job_fork",
      repositoryFullName: "octo-org/reviewphin",
      codeReviewId: 42,
      baseSha: "base-sha",
      headSha: "head-sha",
      changes: [],
    });

    expect(workspace.strategy).toBe("git");
    expect(gitRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["fetch", "--no-tags", "origin", "refs/pull/42/head"],
      }),
    );
  });

  it("materializes the requested head archive in an isolated job workspace", async () => {
    const workspaceRoot = await createTempRoot();
    const archiveSourceRoot = await createTempRoot();
    const repositoryRoot = join(archiveSourceRoot, "octo-org-reviewphin-head");
    await mkdir(join(repositoryRoot, ".github"), { recursive: true });
    await writeFile(
      join(repositoryRoot, ".github", "copilot-instructions.md"),
      "Review repository instructions.\n",
    );
    await writeFile(join(repositoryRoot, "src.ts"), "export {};\n");

    const archivePath = join(archiveSourceRoot, "repository.tar.gz");
    await tar.c(
      {
        cwd: archiveSourceRoot,
        gzip: true,
        file: archivePath,
      },
      ["octo-org-reviewphin-head"],
    );
    const downloadRepositoryArchive = vi.fn(async () => readFile(archivePath));

    const materializer = new GitHubWorkspaceMaterializer({ workspaceRoot });
    const workspace = await materializer.materialize({
      client: {
        downloadRepositoryArchive,
      } as unknown as GitHubClient,
      jobId: "job_1",
      repositoryFullName: "octo-org/reviewphin",
      headSha: "head-sha",
    });

    expect(workspace.rootPath).toBe(join(workspace.cleanupRoot, "workspace"));
    expect(workspace.cleanupRoot).toMatch(
      new RegExp(`^${escapeRegExp(join(workspaceRoot, "job_1-"))}`),
    );
    expect(workspace.strategy).toBe("archive");
    expect(workspace.gitPreparationError).toBe(
      "GitHub pull request base SHA was unavailable",
    );
    expect(downloadRepositoryArchive).toHaveBeenCalledWith(
      "octo-org/reviewphin",
      "head-sha",
    );
    expect(
      await readFile(
        join(workspace.rootPath, ".github", "copilot-instructions.md"),
        "utf8",
      ),
    ).toBe("Review repository instructions.\n");
    await expect(
      readFile(join(workspace.cleanupRoot, "repository.tar.gz"), "utf8"),
    ).rejects.toThrow();

    await materializer.cleanup(workspace);
    await expect(
      readFile(join(workspace.rootPath, "src.ts")),
    ).rejects.toThrow();
  });

  it("does not delete an existing workspace when the same job is materialized again", async () => {
    const workspaceRoot = await createTempRoot();
    const archiveSourceRoot = await createTempRoot();
    const repositoryRoot = join(archiveSourceRoot, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    await writeFile(join(repositoryRoot, "src.ts"), "export {};\n");
    const archivePath = join(archiveSourceRoot, "repository.tar.gz");
    await tar.c(
      {
        cwd: archiveSourceRoot,
        gzip: true,
        file: archivePath,
      },
      ["repo"],
    );
    const materializer = new GitHubWorkspaceMaterializer({ workspaceRoot });
    const input = {
      client: {
        downloadRepositoryArchive: vi.fn(async () => readFile(archivePath)),
      } as unknown as GitHubClient,
      jobId: "job_1",
      repositoryFullName: "octo-org/reviewphin",
      headSha: "head-sha",
    };

    const firstWorkspace = await materializer.materialize(input);
    const secondWorkspace = await materializer.materialize(input);

    expect(secondWorkspace.cleanupRoot).not.toBe(firstWorkspace.cleanupRoot);
    await expect(
      readFile(join(firstWorkspace.rootPath, "src.ts"), "utf8"),
    ).resolves.toBe("export {};\n");
    await expect(
      readFile(join(secondWorkspace.rootPath, "src.ts"), "utf8"),
    ).resolves.toBe("export {};\n");

    await materializer.cleanup(firstWorkspace);
    await materializer.cleanup(secondWorkspace);
  });

  it("removes partial workspace data when archive extraction fails", async () => {
    const workspaceRoot = await createTempRoot();
    const materializer = new GitHubWorkspaceMaterializer({ workspaceRoot });

    await expect(
      materializer.materialize({
        client: {
          downloadRepositoryArchive: vi.fn(async () =>
            Buffer.from("not a tar archive"),
          ),
        } as unknown as GitHubClient,
        jobId: "job_failed",
        repositoryFullName: "octo-org/reviewphin",
        headSha: "head-sha",
      }),
    ).rejects.toThrow();
    await expect(
      readFile(join(workspaceRoot, "job_failed", "repository.tar.gz")),
    ).rejects.toThrow();
  });

  async function createTempRoot(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "reviewphin-github-workspace-"));
    tempRoots.push(path);
    return path;
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
