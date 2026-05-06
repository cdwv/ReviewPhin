import type {
  StorageProviderFactoryContext,
  StorageProvider,
} from "../../../src/storage/provider.js";
import { CURRENT_STORAGE_CONTRACT_REVISION } from "../../../src/storage/contract/index.js";
import type { StorageStores } from "../../../src/storage/contract/index.js";

class FailingProvider implements StorageProvider {
  public getProviderId(): string {
    return "fixture-failing";
  }

  public getSupportedStorageContract(): string {
    return CURRENT_STORAGE_CONTRACT_REVISION;
  }

  public async open(): Promise<void> {}

  public async prepare(): Promise<never> {
    throw new Error("fixture prepare failed");
  }

  public createStores(): StorageStores {
    throw new Error("failing provider should not create stores");
  }

  public async close(): Promise<void> {}
}

export function createStorageProvider(
  _context: StorageProviderFactoryContext,
): StorageProvider {
  return new FailingProvider();
}
