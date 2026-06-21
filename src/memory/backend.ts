import type { ProjectMemoryContext, ProjectMemoryEntry } from "./types.js";

export interface ProjectMemorySaveOptions {
  baseEntries?: ProjectMemoryEntry[] | undefined;
}

export type ProjectMemoryCapability =
  | {
      implemented: true;
      available: true;
    }
  | {
      implemented: true;
      available: false;
      reason: string;
    }
  | {
      implemented: false;
      available: false;
      reason: string;
    };

export interface ProjectMemoryBackend {
  getCapability(): Promise<ProjectMemoryCapability>;
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
  public async getCapability(): Promise<ProjectMemoryCapability> {
    return {
      implemented: true,
      available: false,
      reason: "Project memory is disabled by operator policy",
    };
  }

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
