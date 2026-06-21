import type { StorageStores } from "../storage/contract/index.js";
import {
  areProjectMemoryEntriesEqual,
  mergeConcurrentProjectMemoryEntries,
} from "./backend-utils.js";
import type {
  ProjectMemoryBackend,
  ProjectMemoryCapability,
  ProjectMemorySaveOptions,
} from "./backend.js";
import { dedupeProjectMemoryEntries } from "./project-memory.js";
import type { ProjectMemoryContext, ProjectMemoryEntry } from "./types.js";

export class InStoreMemoryProvider implements ProjectMemoryBackend {
  public constructor(
    private readonly options: {
      stores: Pick<StorageStores, "projectMemories">;
      tenantId: string;
    },
  ) {}

  public async getCapability(): Promise<ProjectMemoryCapability> {
    return { implemented: true, available: true };
  }

  public async load(): Promise<ProjectMemoryContext> {
    const record = await this.options.stores.projectMemories.get(
      this.options.tenantId,
    );
    return {
      enabled: true,
      page: null,
      entries: record
        ? dedupeProjectMemoryEntries(parseStoredEntries(record.entriesJson))
        : [],
    };
  }

  public async saveEntries(
    entries: ProjectMemoryEntry[],
    options: ProjectMemorySaveOptions = {},
  ): Promise<ProjectMemoryContext> {
    const currentMemory = await this.load();
    const nextEntries = options.baseEntries
      ? mergeConcurrentProjectMemoryEntries(
          entries,
          currentMemory.entries,
          options.baseEntries,
        )
      : dedupeProjectMemoryEntries(entries);

    if (nextEntries === null) {
      return currentMemory;
    }
    if (areProjectMemoryEntriesEqual(currentMemory.entries, nextEntries)) {
      return currentMemory;
    }

    const existing = await this.options.stores.projectMemories.get(
      this.options.tenantId,
    );
    const now = new Date().toISOString();
    await this.options.stores.projectMemories.upsert({
      id: this.options.tenantId,
      tenantId: this.options.tenantId,
      entriesJson: JSON.stringify(nextEntries),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    return {
      enabled: true,
      page: null,
      entries: nextEntries,
    };
  }
}

export async function deleteStoreProjectMemory(input: {
  stores: Pick<StorageStores, "projectMemories">;
  tenantId: string;
}): Promise<void> {
  await input.stores.projectMemories.delete(input.tenantId);
}

function parseStoredEntries(entriesJson: string): ProjectMemoryEntry[] {
  const parsed = JSON.parse(entriesJson) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry): ProjectMemoryEntry[] => {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { text?: unknown }).text === "string"
    ) {
      return [{ text: (entry as { text: string }).text }];
    }
    return [];
  });
}
