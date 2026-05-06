import { type Logger } from "pino";
import type {
  StorageStores
} from "./contract/index.js";

export interface StoragePreparationResult {
  readonly providerId: string;
  readonly storageContractRevision: string;
  readonly appliedMigrationIds: readonly string[];
}

export interface StorageProviderFactoryContext {
  readonly env: NodeJS.ProcessEnv;
  logger?: Logger;
}

export interface StorageProvider {
  getProviderId(): string;
  getSupportedStorageContract(): string;
  open(): Promise<void>;
  prepare(): Promise<StoragePreparationResult>;
  createStores(): StorageStores;
  close(): Promise<void>;
}

export interface StorageProviderModule {
  createStorageProvider(context: StorageProviderFactoryContext): Promise<StorageProvider> | StorageProvider;
}
