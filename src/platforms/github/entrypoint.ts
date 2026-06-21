import { loadConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import type { PlatformFactoryContext } from "../provider.js";

import GitHubPlatform from "./platform.js";

export function createPlatform(
  context: PlatformFactoryContext,
): GitHubPlatform {
  const config = loadConfig(context.env);
  return new GitHubPlatform({
    logger:
      context.logger ??
      createLogger("info").child({ component: "GitHubPlatform" }),
    publicUrl: config.publicUrl,
  });
}

export default createPlatform;
