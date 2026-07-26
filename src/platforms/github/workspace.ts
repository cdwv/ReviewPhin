import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Logger } from "pino";
import * as tar from "tar";

import type { PlatformMaterializedWorkspace } from "../IPlatform.js";
import {
  buildGitReviewChanges,
  createGitInspectionCapability,
  type GitRunner,
  type GitRunnerInput,
  type GitRunnerResult,
  REVIEW_BASE_REF,
  REVIEW_HEAD_REF,
} from "../git-workspace.js";
import type { GitHubClient } from "./client.js";

const execFileAsync = promisify(execFile);

export interface GitHubMaterializedWorkspace extends PlatformMaterializedWorkspace {
  strategy: "git" | "archive";
}

interface GitHubWorkspaceMaterializerOptions {
  workspaceRoot: string;
  logger?: Logger | undefined;
  gitRunner?: GitRunner | undefined;
}

export class GitHubWorkspaceMaterializer {
  private readonly gitRunner: GitRunner;

  public constructor(
    private readonly options: GitHubWorkspaceMaterializerOptions,
  ) {
    this.gitRunner = options.gitRunner ?? runGitCommand;
  }

  public async materialize(input: {
    client: GitHubClient;
    jobId: string;
    repositoryFullName: string;
    codeReviewId?: number | undefined;
    baseSha?: string | undefined;
    headSha: string;
  }): Promise<GitHubMaterializedWorkspace> {
    await mkdir(this.options.workspaceRoot, { recursive: true });
    const cleanupRoot = await mkdtemp(
      join(this.options.workspaceRoot, `${input.jobId}-`),
    );
    let gitPreparationError: string | undefined;

    try {
      const baseSha = input.baseSha;
      if (!baseSha) {
        throw new Error("GitHub pull request base SHA was unavailable");
      }
      return await this.materializeFromGit({ ...input, baseSha }, cleanupRoot);
    } catch (error) {
      gitPreparationError = getErrorMessage(error);
      this.options.logger?.warn(
        { err: error },
        "GitHub Git workspace preparation failed; falling back to repository archive",
      );
    }

    try {
      return await this.materializeFromArchive(
        input,
        cleanupRoot,
        gitPreparationError,
      );
    } catch (error) {
      await rm(cleanupRoot, { recursive: true, force: true });
      throw error;
    }
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

  private async materializeFromGit(
    input: {
      client: GitHubClient;
      repositoryFullName: string;
      codeReviewId?: number | undefined;
      baseSha: string;
      headSha: string;
    },
    cleanupRoot: string,
  ): Promise<GitHubMaterializedWorkspace> {
    const rootPath = join(cleanupRoot, "workspace");
    await resetDirectory(rootPath);
    const gitEnv = await input.client.buildGitAuthEnv();
    const remoteUrl = `https://github.com/${input.repositoryFullName}.git`;

    await this.gitRunner({ cwd: rootPath, args: ["init"], env: gitEnv });
    await this.gitRunner({
      cwd: rootPath,
      args: ["remote", "add", "origin", remoteUrl],
      env: gitEnv,
    });

    try {
      await this.gitRunner({
        cwd: rootPath,
        args: ["fetch", "--no-tags", "origin", input.headSha],
        env: gitEnv,
      });
    } catch (exactShaError) {
      if (!input.codeReviewId) {
        throw exactShaError;
      }
      await this.gitRunner({
        cwd: rootPath,
        args: [
          "fetch",
          "--no-tags",
          "origin",
          `refs/pull/${input.codeReviewId}/head`,
        ],
        env: gitEnv,
      });
      const fetchedHead = (
        await this.gitRunner({
          cwd: rootPath,
          args: ["rev-parse", "FETCH_HEAD"],
          env: gitEnv,
        })
      ).stdout.trim();
      if (fetchedHead !== input.headSha) {
        throw new Error(
          `GitHub pull request head ref resolved to ${fetchedHead}, expected ${input.headSha}`,
          { cause: exactShaError },
        );
      }
    }

    await this.gitRunner({
      cwd: rootPath,
      args: ["update-ref", REVIEW_HEAD_REF, "FETCH_HEAD"],
      env: gitEnv,
    });
    await this.gitRunner({
      cwd: rootPath,
      args: ["fetch", "--no-tags", "origin", input.baseSha],
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
        `Prepared GitHub review head ${preparedHead} does not match expected ${input.headSha}`,
      );
    }
    if (preparedBase && preparedBase !== input.baseSha) {
      throw new Error(
        `Prepared GitHub review base ${preparedBase} does not match expected ${input.baseSha}`,
      );
    }

    const gitChanges = await buildGitReviewChanges({
      cwd: rootPath,
      gitRunner: this.gitRunner,
      env: gitEnv,
    });

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
      gitChanges,
    };
  }

  private async materializeFromArchive(
    input: {
      client: GitHubClient;
      repositoryFullName: string;
      headSha: string;
    },
    cleanupRoot: string,
    gitPreparationError?: string,
  ): Promise<GitHubMaterializedWorkspace> {
    const rootPath = join(cleanupRoot, "workspace");
    const archivePath = join(cleanupRoot, "repository.tar.gz");
    await resetDirectory(rootPath);

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
    } finally {
      await rm(archivePath, { force: true });
    }
    return {
      rootPath,
      cleanupRoot,
      strategy: "archive",
      ...(gitPreparationError ? { gitPreparationError } : {}),
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
