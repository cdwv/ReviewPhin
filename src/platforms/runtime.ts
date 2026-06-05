import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Logger } from "pino";

import type { IPlatform } from "./IPlatform.js";
import type { PlatformFactoryContext, PlatformModule } from "./provider.js";

const DEFAULT_PLATFORM_MODULES = ["gitlab"] as const;

export interface InitializedPlatformRuntime {
  readonly moduleSpecifiers: readonly string[];
  readonly platforms: readonly IPlatform[];
}

export async function initializePlatformRuntime(
  input: {
    platformModules?: readonly string[] | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    logger?: Logger | undefined;
  } = {},
): Promise<InitializedPlatformRuntime> {
  const requestedModules =
    input.platformModules?.length && input.platformModules.length > 0
      ? [...input.platformModules]
      : [...DEFAULT_PLATFORM_MODULES];
  const resolvedSpecifiers = requestedModules.map(
    resolvePlatformModuleSpecifier,
  );
  const platforms: IPlatform[] = [];

  for (let index = 0; index < resolvedSpecifiers.length; index += 1) {
    const moduleSpecifier = resolvedSpecifiers[index]!;
    const factory = await loadPlatformFactory(moduleSpecifier);
    const platform = await factory({
      env: input.env ?? process.env,
      ...(input.logger
        ? {
            logger: input.logger.child({
              component: "platform-loader",
              platformModule: requestedModules[index],
            }),
          }
        : {}),
    });
    platforms.push(platform);
  }

  const seenSlugs = new Set<string>();
  for (const platform of platforms) {
    const slug = platform.getPlatformInfo().slug;
    if (seenSlugs.has(slug)) {
      throw new Error(`Duplicate platform slug registered: ${slug}`);
    }
    seenSlugs.add(slug);
  }

  return {
    moduleSpecifiers: resolvedSpecifiers,
    platforms,
  };
}

async function loadPlatformFactory(
  moduleSpecifier: string,
): Promise<
  (context: PlatformFactoryContext) => Promise<IPlatform> | IPlatform
> {
  const loadedModule = (await import(
    moduleSpecifier
  )) as Partial<PlatformModule> & {
    default?: unknown;
  };
  const candidate =
    loadedModule.createPlatform ??
    (typeof loadedModule.default === "function"
      ? loadedModule.default
      : undefined);

  if (typeof candidate !== "function") {
    throw new Error(
      `Platform module ${moduleSpecifier} must export createPlatform(context)`,
    );
  }

  return candidate as (
    context: PlatformFactoryContext,
  ) => Promise<IPlatform> | IPlatform;
}

function resolvePlatformModuleSpecifier(platformModule: string): string {
  if (platformModule === "gitlab") {
    return new URL("./gitlab/entrypoint.js", import.meta.url).href;
  }

  if (isAbsolute(platformModule) || platformModule.startsWith(".")) {
    return pathToFileURL(resolve(platformModule)).href;
  }

  return platformModule;
}
