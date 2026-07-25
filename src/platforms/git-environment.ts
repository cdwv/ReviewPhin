import { devNull } from "node:os";

export function getGitConfigNullDevice(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "NUL" : devNull;
}
