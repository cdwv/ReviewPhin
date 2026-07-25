import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GitReadonlyCapability } from "../harness/git-readonly.js";

export const REVIEW_BASE_REF = "refs/reviewphin/base" as const;
export const REVIEW_HEAD_REF = "refs/reviewphin/head" as const;

export interface PlatformBoundaryChange {
  oldPath: string;
  newPath: string;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
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

export function assertGitBoundaryMatchesPlatform(
  nameStatusOutput: string,
  platformChanges: PlatformBoundaryChange[],
): void {
  const gitBoundary = parseGitNameStatus(nameStatusOutput);
  const platformBoundary = new Set(
    platformChanges.map(toPlatformBoundarySignature),
  );
  if (
    gitBoundary.size === platformBoundary.size &&
    [...platformBoundary].every((entry) => gitBoundary.has(entry))
  ) {
    return;
  }

  const missingFromGit = [...platformBoundary].filter(
    (entry) => !gitBoundary.has(entry),
  );
  const missingFromPlatform = [...gitBoundary].filter(
    (entry) => !platformBoundary.has(entry),
  );
  throw new Error(
    `Prepared Git boundary does not match the platform snapshot (missing from Git: ${formatBoundaryEntries(missingFromGit)}; missing from platform: ${formatBoundaryEntries(missingFromPlatform)})`,
  );
}

function parseGitNameStatus(output: string): Set<string> {
  const boundary = new Set<string>();
  if (output.includes("\0")) {
    const tokens = output.split("\0");
    for (let index = 0; index < tokens.length;) {
      const rawStatus = tokens[index++];
      if (!rawStatus) {
        continue;
      }
      const status = rawStatus[0];
      const firstPath = tokens[index++];
      if (!status || !firstPath) {
        throw new Error(
          `Could not parse prepared Git boundary status: ${rawStatus}`,
        );
      }
      if (status === "R" || status === "C") {
        const secondPath = tokens[index++];
        if (!secondPath) {
          throw new Error(
            `Could not parse prepared Git boundary status: ${rawStatus}`,
          );
        }
        boundary.add(
          status === "R"
            ? signature("R", firstPath, secondPath)
            : signature("A", secondPath),
        );
      } else {
        boundary.add(
          signature(status === "A" || status === "D" ? status : "M", firstPath),
        );
      }
    }
    return boundary;
  }

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [rawStatus, firstPath, secondPath] = line.split("\t");
    const status = rawStatus?.[0];
    if (!status || !firstPath) {
      throw new Error(`Could not parse prepared Git boundary line: ${line}`);
    }
    if (status === "R") {
      if (!secondPath) {
        throw new Error(`Could not parse renamed Git boundary line: ${line}`);
      }
      boundary.add(signature("R", firstPath, secondPath));
    } else if (status === "C") {
      if (!secondPath) {
        throw new Error(`Could not parse copied Git boundary line: ${line}`);
      }
      boundary.add(signature("A", secondPath));
    } else if (status === "A" || status === "D" || status === "M") {
      boundary.add(signature(status, firstPath));
    } else if (status === "T" || status === "U" || status === "X") {
      boundary.add(signature("M", firstPath));
    } else {
      throw new Error(`Unsupported prepared Git boundary status: ${rawStatus}`);
    }
  }
  return boundary;
}

function toPlatformBoundarySignature(change: PlatformBoundaryChange): string {
  if (change.renamedFile) {
    return signature("R", change.oldPath, change.newPath);
  }
  if (change.deletedFile) {
    return signature("D", change.oldPath);
  }
  if (change.newFile) {
    return signature("A", change.newPath);
  }
  return signature("M", change.newPath);
}

function signature(status: string, ...paths: string[]): string {
  return [status, ...paths].join("\0");
}

function formatBoundaryEntries(entries: string[]): string {
  return entries.length === 0
    ? "none"
    : entries
        .slice(0, 10)
        .map((entry) => entry.replaceAll("\0", " "))
        .join(", ");
}
