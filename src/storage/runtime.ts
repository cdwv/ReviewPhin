import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CURRENT_STORAGE_CONTRACT_REVISION } from "./contract/index.js";
import {
  createStorageHelpers,
  type StorageHelpers,
} from "./storage-helpers.js";
import type {
  StorageProvider,
  StorageProviderFactoryContext,
  StorageProviderModule,
} from "./provider.js";
import { type Logger } from "pino";

export interface InitializedStorageRuntime {
  readonly moduleSpecifier: string;
  readonly provider: StorageProvider;
  readonly storage: StorageHelpers;
  readonly preparation: Awaited<ReturnType<StorageProvider["prepare"]>>;
}

export async function initializeStorageRuntime(
  input: {
    providerModule?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    logger?: Logger;
  } = {},
): Promise<InitializedStorageRuntime> {
  const moduleSpecifier = resolveStorageModuleSpecifier(input.providerModule);
  const factory = await loadStorageProviderFactory(moduleSpecifier);
  const provider = await factory({
    env: input.env ?? process.env,
    ...(input.logger && { logger: input.logger }),
  });

  try {
    await provider.open();

    const supportedContract = provider.getSupportedStorageContract();
    if (supportedContract !== CURRENT_STORAGE_CONTRACT_REVISION) {
      throw new Error(
        `Storage provider ${provider.getProviderId()} supports ${supportedContract}, but the app requires ${CURRENT_STORAGE_CONTRACT_REVISION}`,
      );
    }

    const preparation = await provider.prepare();
    if (
      preparation.storageContractRevision !== CURRENT_STORAGE_CONTRACT_REVISION
    ) {
      throw new Error(
        `Storage provider ${provider.getProviderId()} prepared ${preparation.storageContractRevision}, but the app requires ${CURRENT_STORAGE_CONTRACT_REVISION}`,
      );
    }

    return {
      moduleSpecifier,
      provider,
      storage: createStorageHelpers(provider.createStores()),
      preparation,
    };
  } catch (error) {
    await provider.close().catch(() => undefined);
    throw error;
  }
}

async function loadStorageProviderFactory(
  moduleSpecifier: string,
): Promise<
  (
    context: StorageProviderFactoryContext,
  ) => Promise<StorageProvider> | StorageProvider
> {
  const loadedModule = (await import(
    moduleSpecifier
  )) as Partial<StorageProviderModule> & {
    default?: unknown;
  };
  const candidate =
    loadedModule.createStorageProvider ??
    (typeof loadedModule.default === "function"
      ? loadedModule.default
      : undefined);

  if (typeof candidate !== "function") {
    throw new Error(
      `Storage provider module ${moduleSpecifier} must export createStorageProvider(context)`,
    );
  }

  return candidate as (
    context: StorageProviderFactoryContext,
  ) => Promise<StorageProvider> | StorageProvider;
}

function resolveStorageModuleSpecifier(providerModule?: string): string {
  if (!providerModule) {
    return new URL("./adapters/sqlite/entrypoint.js", import.meta.url).href;
  }

  if (["sqlite", "flotiq"].includes(providerModule)) {
    return new URL(
      `./adapters/${providerModule}/entrypoint.js`,
      import.meta.url,
    ).href;
  }

  if (isAbsolute(providerModule) || providerModule.startsWith(".")) {
    return pathToFileURL(resolve(providerModule)).href;
  }

  return providerModule;
}
