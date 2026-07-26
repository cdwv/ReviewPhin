import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GitReadonlyCapability } from "../harness/git-readonly.js";
import {
  GIT_CONTENT_SIGNATURE_PREFIX,
  type CodeReviewChange,
} from "../review/types.js";

export const REVIEW_BASE_REF = "refs/reviewphin/base" as const;
export const REVIEW_HEAD_REF = "refs/reviewphin/head" as const;

export interface GitRunnerInput {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface GitRunnerResult {
  stdout: string;
  stderr: string;
}

export type GitRunner = (input: GitRunnerInput) => Promise<GitRunnerResult>;

interface RawGitChange {
  oldPath: string;
  newPath: string;
  oldMode: string;
  newMode: string;
  oldObjectId: string;
  newObjectId: string;
  status: string;
}

interface GitDiffStats {
  additions?: number | undefined;
  deletions?: number | undefined;
}

export async function createGitInspectionCapability(
  cleanupRoot: string,
): Promise<GitReadonlyCapability> {
  const emptyGitConfigPath = join(cleanupRoot, "empty-git-config");
  await writeFile(emptyGitConfigPath, "", {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    baseRef: REVIEW_BASE_REF,
    headRef: REVIEW_HEAD_REF,
    emptyGitConfigPath,
  };
}

/**
 * Builds the complete review boundary from the prepared Git refs. Provider
 * change APIs are intentionally not involved: they remain available for
 * provider-specific publication and non-Git fallbacks.
 */
export async function buildGitReviewChanges(input: {
  cwd: string;
  gitRunner: GitRunner;
  env?: NodeJS.ProcessEnv | undefined;
  baseRef?: string | undefined;
  headRef?: string | undefined;
}): Promise<CodeReviewChange[]> {
  const baseRef = input.baseRef ?? REVIEW_BASE_REF;
  const headRef = input.headRef ?? REVIEW_HEAD_REF;
  const commonArgs = [
    "-z",
    "--find-renames",
    "--no-ext-diff",
    "--no-textconv",
    baseRef,
    headRef,
  ];
  const [rawResult, numstatResult] = await Promise.all([
    input.gitRunner({
      cwd: input.cwd,
      args: ["diff", "--raw", "--no-abbrev", ...commonArgs],
      ...(input.env ? { env: input.env } : {}),
    }),
    input.gitRunner({
      cwd: input.cwd,
      args: ["diff", "--numstat", ...commonArgs],
      ...(input.env ? { env: input.env } : {}),
    }),
  ]);

  const rawChanges = parseGitRawChanges(rawResult.stdout);
  const statsByPath = parseGitNumstat(numstatResult.stdout);
  const rawPaths = new Set(rawChanges.map((change) => change.newPath));
  const missingStats = rawChanges.filter(
    (change) => !statsByPath.has(change.newPath),
  );
  const extraStats = [...statsByPath.keys()].filter(
    (path) => !rawPaths.has(path),
  );
  if (missingStats.length > 0 || extraStats.length > 0) {
    throw new Error(
      `Prepared Git manifest outputs disagree (missing stats: ${formatPaths(
        missingStats.map((change) => change.newPath),
      )}; unexpected stats: ${formatPaths(extraStats)})`,
    );
  }

  return rawChanges.map((change) => {
    const status = change.status[0];
    if (!status) {
      throw new Error("Prepared Git change had no status");
    }
    const stats = statsByPath.get(change.newPath);
    return {
      oldPath: change.oldPath,
      newPath: change.newPath,
      ...(stats?.additions !== undefined ? { additions: stats.additions } : {}),
      ...(stats?.deletions !== undefined ? { deletions: stats.deletions } : {}),
      newFile: status === "A" || status === "C",
      renamedFile: status === "R",
      deletedFile: status === "D",
      contentSignature: `${GIT_CONTENT_SIGNATURE_PREFIX}${change.oldMode}:${change.oldObjectId}:${change.newMode}:${change.newObjectId}`,
    };
  });
}

export function parseGitRawChanges(output: string): RawGitChange[] {
  if (!output) {
    return [];
  }

  const tokens = output.split("\0");
  const changes: RawGitChange[] = [];
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++];
    if (!header) {
      continue;
    }
    const parsed =
      /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/i.exec(header);
    if (!parsed) {
      throw new Error(`Could not parse prepared Git raw change: ${header}`);
    }
    const firstPath = tokens[index++];
    if (!firstPath) {
      throw new Error(`Prepared Git raw change had no path: ${header}`);
    }
    const status = parsed[5]!.toUpperCase();
    if (status === "R" || status === "C") {
      const secondPath = tokens[index++];
      if (!secondPath) {
        throw new Error(`Prepared Git ${status} change had no destination`);
      }
      changes.push({
        oldPath: status === "C" ? secondPath : firstPath,
        newPath: secondPath,
        oldMode: parsed[1]!,
        newMode: parsed[2]!,
        oldObjectId: parsed[3]!,
        newObjectId: parsed[4]!,
        status,
      });
      continue;
    }
    changes.push({
      oldPath: firstPath,
      newPath: firstPath,
      oldMode: parsed[1]!,
      newMode: parsed[2]!,
      oldObjectId: parsed[3]!,
      newObjectId: parsed[4]!,
      status,
    });
  }
  return changes;
}

export function parseGitNumstat(output: string): Map<string, GitDiffStats> {
  const statsByPath = new Map<string, GitDiffStats>();
  if (!output) {
    return statsByPath;
  }

  const tokens = output.split("\0");
  for (let index = 0; index < tokens.length;) {
    const entry = tokens[index++];
    if (!entry) {
      continue;
    }
    const firstTab = entry.indexOf("\t");
    const secondTab = entry.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      throw new Error(`Could not parse prepared Git numstat entry: ${entry}`);
    }
    const additionsText = entry.slice(0, firstTab);
    const deletionsText = entry.slice(firstTab + 1, secondTab);
    let newPath = entry.slice(secondTab + 1);
    if (!newPath) {
      const oldPath = tokens[index++];
      newPath = tokens[index++] ?? "";
      if (!oldPath || !newPath) {
        throw new Error("Prepared Git rename numstat had incomplete paths");
      }
    }
    const binary = additionsText === "-" || deletionsText === "-";
    statsByPath.set(newPath, {
      ...(!binary ? { additions: parseCount(additionsText) } : {}),
      ...(!binary ? { deletions: parseCount(deletionsText) } : {}),
    });
  }
  return statsByPath;
}

function parseCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid prepared Git numstat count: ${value}`);
  }
  return parsed;
}

function formatPaths(paths: string[]): string {
  return paths.length === 0 ? "none" : paths.slice(0, 10).join(", ");
}
