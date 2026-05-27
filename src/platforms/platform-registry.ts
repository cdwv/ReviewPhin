import { createLogger } from "../logger.js";
import GitLabPlatform from "./gitlab/platform.js";
import type { IPlatform } from "./IPlatform.js";

let platforms: IPlatform[] | null = null;

export function getPlatforms(): IPlatform[] {
  if (!platforms) {
    const logger = createLogger("info");
    platforms = [
      new GitLabPlatform(logger.child({ component: "GitLabPlatform" })),
    ];
  }
  return platforms ?? [];
}

export function getPlatformBySlug(slug: string): IPlatform | null {
  const platform = getPlatforms().find(
    (p) => p.getPlatformInfo().slug === slug,
  );
  return platform || null;
}
