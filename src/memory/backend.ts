import type { ProjectMemoryContext, ProjectMemoryEntry } from "./types.js";

export interface ProjectMemorySaveOptions {
  baseEntries?: ProjectMemoryEntry[] | undefined;
}

export interface ProjectMemoryBackend {
  load(): Promise<ProjectMemoryContext>;
  saveEntries(
    entries: ProjectMemoryEntry[],
    options?: ProjectMemorySaveOptions,
  ): Promise<ProjectMemoryContext>;
}

export function createDisabledProjectMemoryBackend(): ProjectMemoryBackend {
  return new DisabledProjectMemoryBackend();
}

class DisabledProjectMemoryBackend implements ProjectMemoryBackend {
  public async load(): Promise<ProjectMemoryContext> {
    return {
      enabled: false,
      page: null,
      entries: [],
    };
  }

  public async saveEntries(
    _entries: ProjectMemoryEntry[],
  ): Promise<ProjectMemoryContext> {
    throw new Error("Project memory is disabled");
  }
}
