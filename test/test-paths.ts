import { resolve } from "node:path";

export const TEST_REPO_ROOT = resolve(process.cwd());

export function repoPath(...segments: string[]): string {
  return resolve(TEST_REPO_ROOT, ...segments);
}

export function tmpPath(...segments: string[]): string {
  return resolve(TEST_REPO_ROOT, "tmp", ...segments);
}
