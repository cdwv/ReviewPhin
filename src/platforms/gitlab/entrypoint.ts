import { createLogger } from "../../logger.js";
import type { PlatformFactoryContext } from "../provider.js";

import GitLabPlatform from "./platform.js";

export function createPlatform(
  context: PlatformFactoryContext,
): GitLabPlatform {
  return new GitLabPlatform(
    context.logger ??
      createLogger("info").child({ component: "GitLabPlatform" }),
  );
}

export default createPlatform;
