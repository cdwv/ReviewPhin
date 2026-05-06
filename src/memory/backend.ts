import type { Logger } from "pino";

import type { GitLabClient } from "../gitlab/client.js";
import type {
  HarnessRunLoggingContext,
  HarnessTenantContext,
} from "../harness/types.js";
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

export interface ProjectMemoryBackendFactory {
  createForHarnessRun(input: {
    tenant: HarnessTenantContext;
    logger: Logger;
    logging?: HarnessRunLoggingContext | undefined;
  }): ProjectMemoryBackend;
  createForGitLabClient(input: {
    client: GitLabClient;
    projectId: number;
    enabled: boolean;
  }): ProjectMemoryBackend;
}
