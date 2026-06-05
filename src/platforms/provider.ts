import type { Logger } from "pino";

import type { IPlatform } from "./IPlatform.js";

export interface PlatformFactoryContext {
  readonly env: NodeJS.ProcessEnv;
  logger?: Logger | undefined;
}

export interface PlatformModule {
  createPlatform(
    context: PlatformFactoryContext,
  ): Promise<IPlatform> | IPlatform;
}
