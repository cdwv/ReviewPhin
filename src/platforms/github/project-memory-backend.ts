import {
  createDisabledProjectMemoryBackend,
  type ProjectMemoryBackend,
} from "../../memory/backend.js";
import { InStoreMemoryProvider } from "../../memory/store-backend.js";
import type { StorageStores } from "../../storage/contract/index.js";

export function createGitHubProjectMemoryBackend(input: {
  stores: Pick<StorageStores, "projectMemories">;
  tenantId: string;
  enabled: boolean;
}): ProjectMemoryBackend {
  if (!input.enabled) {
    return createDisabledProjectMemoryBackend();
  }
  return new InStoreMemoryProvider({
    stores: input.stores,
    tenantId: input.tenantId,
  });
}
