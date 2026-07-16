import { type Logger } from "pino";
import type {
  StoragePreparationResult,
  StorageProvider,
} from "../../provider.js";
import { SqliteStoreDatabase } from "./database.js";

export interface SqliteStorageProviderOptions {
  readonly databasePath: string;
  logger?: Logger;
}

export class SqliteStorageProvider implements StorageProvider {
  private readonly storage: SqliteStoreDatabase;

  public constructor(options: SqliteStorageProviderOptions) {
    this.storage = new SqliteStoreDatabase({
      databasePath: options.databasePath,
      ...(options.logger && { logger: options.logger }),
    });
  }

  public getProviderId(): string {
    return "sqlite";
  }

  public getSupportedStorageContract(): string {
    return "storage-v006";
  }

  public open(): Promise<void> {
    return this.storage.open();
  }

  public async prepare(): Promise<StoragePreparationResult> {
    const appliedMigrationIds = await this.storage.prepare();
    return {
      providerId: this.getProviderId(),
      storageContractRevision: this.getSupportedStorageContract(),
      appliedMigrationIds,
    };
  }

  public createStores() {
    return this.storage.createStores();
  }

  public close(): Promise<void> {
    return this.storage.close();
  }
}
