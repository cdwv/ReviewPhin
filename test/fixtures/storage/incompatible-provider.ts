import type { StorageProviderFactoryContext, StorageProvider } from "../../../src/storage/provider.js";
import type { StorageStores } from "../../../src/storage/contract/index.js";

class IncompatibleProvider implements StorageProvider {
  public getProviderId(): string {
    return "fixture-incompatible";
  }

  public getSupportedStorageContract(): string {
    return "storage-v999";
  }

  public async open(): Promise<void> {}

  public async prepare() {
    return {
      providerId: this.getProviderId(),
      storageContractRevision: this.getSupportedStorageContract(),
      appliedMigrationIds: []
    };
  }

  public createStores(): StorageStores {
    throw new Error("incompatible provider should not create stores");
  }

  public async close(): Promise<void> {}
}

export function createStorageProvider(_context: StorageProviderFactoryContext): StorageProvider {
  return new IncompatibleProvider();
}
