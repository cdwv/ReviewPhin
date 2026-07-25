import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { Logger } from "pino";
import * as tar from "tar";

import {
  DEFAULT_REPOSITORY_INSTRUCTION_DIRECTORY,
  DEFAULT_REPOSITORY_INSTRUCTION_FILES,
  isDefaultRepositoryInstructionFile,
} from "../../harness/workspace.js";
import { GitLabApiError, type GitLabClient } from "./client.js";
import type {
  GitLabMergeRequestChange,
  MaterializedWorkspace,
} from "./types.js";
import {
  assertGitBoundaryMatchesPlatform,
  createGitInspectionCapability,
  REVIEW_BASE_REF,
  REVIEW_HEAD_REF,
} from "../git-workspace.js";

const execFileAsync = promisify(execFile);

interface GitRunnerInput {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

interface GitRunnerResult {
  stdout: string;
  stderr: string;
}

type GitRunner = (input: GitRunnerInput) => Promise<GitRunnerResult>;

interface WorkspaceMaterializerOptions {
  workspaceRoot: string;
  workspaceAttemptId?: string | undefined;
  logger: Logger;
  gitRunner?: GitRunner;
}

export class WorkspaceMaterializer {
  private readonly workspaceRoot: string;
  private readonly workspaceAttemptId: string | undefined;
  private readonly logger: Logger;
  private readonly gitRunner: GitRunner;

  public constructor(options: WorkspaceMaterializerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.workspaceAttemptId = options.workspaceAttemptId;
    this.logger = options.logger;
    this.gitRunner = options.gitRunner ?? runGitCommand;
  }

  public async materialize(input: {
    client: GitLabClient;
    jobId: string;
    projectId: number;
    codeReviewId: number;
    baseSha?: string | undefined;
    headSha: string;
    changes: GitLabMergeRequestChange[];
  }): Promise<MaterializedWorkspace> {
    const cleanupRoot = this.workspaceAttemptId
      ? join(this.workspaceRoot, input.jobId, this.workspaceAttemptId)
      : join(this.workspaceRoot, input.jobId);
    await resetDirectory(cleanupRoot);
    let gitPreparationError: string | undefined;

    try {
      return await this.materializeFromGit(input, cleanupRoot);
    } catch (error) {
      gitPreparationError = getErrorMessage(error);
      this.logger.warn(
        { err: error },
        "git checkout materialization failed; falling back to repository archive",
      );
    }

    try {
      const archiveBuffer = await input.client.downloadRepositoryArchive(
        input.projectId,
        input.headSha,
      );
      const archivePath = join(cleanupRoot, "repository.tar.gz");
      const rootPath = join(cleanupRoot, "workspace");
      await mkdir(rootPath, { recursive: true });
      await writeFile(archivePath, archiveBuffer);
      await tar.x({
        cwd: rootPath,
        file: archivePath,
        strip: 1,
      });
      await rm(archivePath, { force: true });
      return {
        rootPath,
        cleanupRoot,
        strategy: "archive",
        ...(gitPreparationError ? { gitPreparationError } : {}),
      };
    } catch (error) {
      this.logger.warn(
        { err: error },
        "repository archive materialization failed; falling back to targeted files",
      );
      const workspace = await this.materializeFromFiles(input, cleanupRoot);
      return {
        ...workspace,
        ...(gitPreparationError ? { gitPreparationError } : {}),
      };
    }
  }

  public async cleanup(workspace: MaterializedWorkspace): Promise<void> {
    await rm(workspace.cleanupRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }

  private async materializeFromFiles(
    input: {
      client: GitLabClient;
      jobId: string;
      projectId: number;
      codeReviewId: number;
      baseSha?: string | undefined;
      headSha: string;
      changes: GitLabMergeRequestChange[];
    },
    cleanupRoot: string,
  ): Promise<MaterializedWorkspace> {
    const rootPath = join(cleanupRoot, "workspace");
    await resetDirectory(rootPath);

    for (const change of input.changes) {
      if (change.deleted_file) {
        continue;
      }

      const content = await input.client.getRawFile(
        input.projectId,
        change.new_path,
        input.headSha,
      );
      const outputPath = join(rootPath, ...change.new_path.split("/"));
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, content, "utf8");
    }

    for (const filePath of DEFAULT_REPOSITORY_INSTRUCTION_FILES) {
      try {
        const content = await input.client.getRawFile(
          input.projectId,
          filePath,
          input.headSha,
        );
        const outputPath = join(rootPath, ...filePath.split("/"));
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, "utf8");
      } catch (error) {
        if (!(error instanceof GitLabApiError) || error.status !== 404) {
          throw error;
        }
      }
    }

    try {
      const instructionTree = await input.client.listRepositoryTree(
        input.projectId,
        input.headSha,
        DEFAULT_REPOSITORY_INSTRUCTION_DIRECTORY,
        true,
      );

      for (const item of instructionTree.filter(
        (entry) =>
          entry.type === "blob" &&
          isDefaultRepositoryInstructionFile(entry.path),
      )) {
        const content = await input.client.getRawFile(
          input.projectId,
          item.path,
          input.headSha,
        );
        const outputPath = join(rootPath, ...item.path.split("/"));
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, "utf8");
      }
    } catch (error) {
      if (!(error instanceof GitLabApiError) || error.status !== 404) {
        throw error;
      }
    }

    return {
      rootPath,
      cleanupRoot,
      strategy: "targeted-files",
    };
  }

  private async materializeFromGit(
    input: {
      client: GitLabClient;
      jobId: string;
      projectId: number;
      codeReviewId: number;
      baseSha?: string | undefined;
      headSha: string;
      changes: GitLabMergeRequestChange[];
    },
    cleanupRoot: string,
  ): Promise<MaterializedWorkspace> {
    const rootPath = join(cleanupRoot, "workspace");
    await resetDirectory(rootPath);

    const project = await input.client.getProject(input.projectId);
    const gitEnv = input.client.buildGitAuthEnv();
    const baseSha = input.baseSha;
    if (!baseSha) {
      throw new Error("GitLab merge request base SHA was unavailable");
    }

    await this.gitRunner({
      cwd: rootPath,
      args: ["init"],
      env: gitEnv,
    });
    await this.gitRunner({
      cwd: rootPath,
      args: ["remote", "add", "origin", project.http_url_to_repo],
      env: gitEnv,
    });

    let fetchedRef = "FETCH_HEAD";
    try {
      await this.gitRunner({
        cwd: rootPath,
        args: ["fetch", "--no-tags", "origin", input.headSha],
        env: gitEnv,
      });
    } catch (exactShaError) {
      this.logger.warn(
        {
          err: exactShaError,
          projectId: input.projectId,
          codeReviewId: input.codeReviewId,
          headSha: input.headSha,
        },
        "git fetch by merge request SHA failed; trying merge request head ref",
      );

      await this.gitRunner({
        cwd: rootPath,
        args: [
          "fetch",
          "origin",
          `refs/merge-requests/${input.codeReviewId}/head`,
        ],
        env: gitEnv,
      });
      const fetchedSha = (
        await this.gitRunner({
          cwd: rootPath,
          args: ["rev-parse", "FETCH_HEAD"],
          env: gitEnv,
        })
      ).stdout.trim();
      if (fetchedSha !== input.headSha) {
        throw new Error(
          `Git fetch resolved merge request ${input.codeReviewId} to ${fetchedSha}, expected ${input.headSha}`,
          { cause: exactShaError },
        );
      }
      fetchedRef = "FETCH_HEAD";
    }

    await this.gitRunner({
      cwd: rootPath,
      args: ["update-ref", REVIEW_HEAD_REF, fetchedRef],
      env: gitEnv,
    });
    await this.gitRunner({
      cwd: rootPath,
      args: ["fetch", "--no-tags", "origin", baseSha],
      env: gitEnv,
    });
    await this.gitRunner({
      cwd: rootPath,
      args: ["update-ref", REVIEW_BASE_REF, "FETCH_HEAD"],
      env: gitEnv,
    });
    const preparedHead = (
      await this.gitRunner({
        cwd: rootPath,
        args: ["rev-parse", `${REVIEW_HEAD_REF}^{commit}`],
        env: gitEnv,
      })
    ).stdout.trim();
    const preparedBase = (
      await this.gitRunner({
        cwd: rootPath,
        args: ["rev-parse", `${REVIEW_BASE_REF}^{commit}`],
        env: gitEnv,
      })
    ).stdout.trim();
    if (preparedHead && preparedHead !== input.headSha) {
      throw new Error(
        `Prepared review head ${preparedHead} does not match expected ${input.headSha}`,
      );
    }
    if (preparedBase && preparedBase !== baseSha) {
      throw new Error(
        `Prepared review base ${preparedBase} does not match expected ${baseSha}`,
      );
    }
    const boundary = await this.gitRunner({
      cwd: rootPath,
      args: [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--no-ext-diff",
        "--no-textconv",
        REVIEW_BASE_REF,
        REVIEW_HEAD_REF,
      ],
      env: gitEnv,
    });
    assertGitBoundaryMatchesPlatform(
      boundary.stdout,
      input.changes.map((change) => ({
        oldPath: change.old_path,
        newPath: change.new_path,
        newFile: change.new_file,
        renamedFile: change.renamed_file,
        deletedFile: change.deleted_file,
      })),
    );
    await this.gitRunner({
      cwd: rootPath,
      args: [
        "-c",
        "advice.detachedHead=false",
        "checkout",
        "--detach",
        REVIEW_HEAD_REF,
      ],
      env: gitEnv,
    });
    await this.gitRunner({
      cwd: rootPath,
      args: ["remote", "remove", "origin"],
      env: gitEnv,
    });
    const gitInspection = await createGitInspectionCapability(cleanupRoot);

    return {
      rootPath,
      cleanupRoot,
      strategy: "git",
      gitInspection,
    };
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runGitCommand(input: GitRunnerInput): Promise<GitRunnerResult> {
  const result = await execFileAsync("git", input.args, {
    cwd: input.cwd,
    env: input.env,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function resetDirectory(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
  await mkdir(path, { recursive: true });
}
