import type { Logger } from "pino";

import GitLabPlatform from "./gitlab/platform.js";
import GitHubPlatform from "./github/platform.js";
import type { IPlatform } from "./IPlatform.js";
import { createLogger } from "../logger.js";
import { initializePlatformRuntime } from "./runtime.js";

let platforms: readonly IPlatform[] | null = null;

export async function initializePlatformRegistry(
  input: {
    platformModules?: readonly string[] | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    logger?: Logger | undefined;
  } = {},
): Promise<readonly IPlatform[]> {
  const logger =
    input.logger ??
    createLogger("info").child({ component: "platform-registry" });
  const runtime = await initializePlatformRuntime({
    platformModules: input.platformModules,
    env: input.env,
    logger,
  });
  platforms = runtime.platforms;
  return platforms;
}

export function getPlatforms(
  logger: Logger = createLogger("info"),
): readonly IPlatform[] {
  if (!platforms) {
    platforms = [
      new GitLabPlatform(logger.child({ component: "GitLabPlatform" })),
      new GitHubPlatform({
        logger: logger.child({ component: "GitHubPlatform" }),
        publicUrl: "http://localhost:3000",
      }),
    ];
  }
  return platforms;
}

export function getPlatformBySlug(slug: string): IPlatform | null {
  const platform = getPlatforms().find(
    (p) => p.getPlatformInfo().slug === slug,
  );
  return platform || null;
}

export function resetPlatformRegistryForTests(): void {
  platforms = null;
}
