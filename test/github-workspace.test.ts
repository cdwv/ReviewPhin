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
