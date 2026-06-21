import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as tar from "tar";

import type { PlatformMaterializedWorkspace } from "../IPlatform.js";
import type { GitHubClient } from "./client.js";

export interface GitHubMaterializedWorkspace extends PlatformMaterializedWorkspace {
  strategy: "archive";
}

interface GitHubWorkspaceMaterializerOptions {
  workspaceRoot: string;
}

export class GitHubWorkspaceMaterializer {
  public constructor(
    private readonly options: GitHubWorkspaceMaterializerOptions,
  ) {}

  public async materialize(input: {
    client: GitHubClient;
    jobId: string;
    repositoryFullName: string;
    headSha: string;
  }): Promise<GitHubMaterializedWorkspace> {
    await mkdir(this.options.workspaceRoot, { recursive: true });
    const cleanupRoot = await mkdtemp(
      join(this.options.workspaceRoot, `${input.jobId}-`),
    );
    const rootPath = join(cleanupRoot, "workspace");
    const archivePath = join(cleanupRoot, "repository.tar.gz");

    await mkdir(rootPath, { recursive: true });

    try {
      const archive = await input.client.downloadRepositoryArchive(
        input.repositoryFullName,
        input.headSha,
      );
      await writeFile(archivePath, archive);
      await tar.x({
        cwd: rootPath,
        file: archivePath,
        strip: 1,
      });
    } catch (error) {
      await rm(cleanupRoot, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(archivePath, { force: true });
    }

    return {
      rootPath,
      cleanupRoot,
      strategy: "archive",
    };
  }

  public async cleanup(
    workspace: PlatformMaterializedWorkspace,
  ): Promise<void> {
    await rm(workspace.cleanupRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
}
