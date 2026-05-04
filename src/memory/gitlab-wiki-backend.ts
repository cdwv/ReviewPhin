import type { Logger } from "pino";

import { GitLabClient } from "../gitlab/client.js";
import type { GitLabClient as GitLabClientContract } from "../gitlab/client.js";
import type { GitLabWikiPage } from "../gitlab/types.js";
import type { HarnessRunLoggingContext, HarnessTenantContext } from "../harness/types.js";
import type { ProjectMemoryBackend, ProjectMemoryBackendFactory, ProjectMemorySaveOptions } from "./backend.js";
import {
  dedupeProjectMemoryEntries,
  normalizeProjectMemoryText,
  parseProjectMemoryContent,
  renderProjectMemory,
  resolveProjectMemoryPage
} from "./project-memory.js";
import type { ProjectMemoryContext, ProjectMemoryEntry } from "./types.js";
import { REVIEWPHIN_MEMORY_PAGE_TITLE } from "./types.js";

export class GitLabProjectMemoryBackendFactory implements ProjectMemoryBackendFactory {
  public createForHarnessRun(input: {
    tenant: HarnessTenantContext;
    logger: Logger;
    logging?: HarnessRunLoggingContext | undefined;
  }): ProjectMemoryBackend {
    if (!input.tenant.memoryEnabled) {
      return new DisabledProjectMemoryBackend();
    }

    const client = new GitLabClient({
      baseUrl: input.tenant.baseUrl,
      apiToken: input.tenant.apiToken,
      logger: input.logger.child({
        interactionRunId: input.logging?.interactionRunId ?? null,
        interactionJobId: input.logging?.interactionJobId ?? null,
        tenantId: input.logging?.tenantId ?? input.tenant.id,
        component: "project-memory-backend"
      })
    });

    return new GitLabWikiProjectMemoryBackend({
      client,
      projectId: input.tenant.projectId
    });
  }

  public createForGitLabClient(input: {
    client: GitLabClientContract;
    projectId: number;
    enabled: boolean;
  }): ProjectMemoryBackend {
    if (!input.enabled) {
      return new DisabledProjectMemoryBackend();
    }

    return new GitLabWikiProjectMemoryBackend({
      client: input.client,
      projectId: input.projectId
    });
  }
}

export class GitLabWikiProjectMemoryBackend implements ProjectMemoryBackend {
  private readonly client: GitLabClientContract;
  private readonly projectId: number;

  public constructor(options: {
    client: GitLabClientContract;
    projectId: number;
  }) {
    this.client = options.client;
    this.projectId = options.projectId;
  }

  public async load(): Promise<ProjectMemoryContext> {
    const page = await resolveProjectMemoryPage(this.client, this.projectId);
    return {
      enabled: true,
      page,
      entries: page ? parseProjectMemoryContent(page.content ?? "") : []
    };
  }

  public async saveEntries(
    entries: ProjectMemoryEntry[],
    options: ProjectMemorySaveOptions = {}
  ): Promise<ProjectMemoryContext> {
    const currentMemory = await this.load();
    if (options.baseEntries && !areEntriesEqual(currentMemory.entries, options.baseEntries)) {
      const nextEntries = mergeConcurrentEntries(entries, currentMemory.entries, options.baseEntries);
      if (nextEntries === null) {
        return currentMemory;
      }

      return this.persistEntries(currentMemory.page, nextEntries);
    }

    const nextEntries = dedupeProjectMemoryEntries(entries);
    return this.persistEntries(currentMemory.page, nextEntries);
  }

  private async persistEntries(
    currentPage: GitLabWikiPage | null,
    entries: ProjectMemoryEntry[]
  ): Promise<ProjectMemoryContext> {
    const content = renderProjectMemory(entries);
    const page =
      currentPage === null
        ? await this.client.createProjectWikiPage(this.projectId, {
            title: REVIEWPHIN_MEMORY_PAGE_TITLE,
            content,
            format: "markdown"
          })
        : await this.client.updateProjectWikiPage(this.projectId, currentPage.slug, {
            title: REVIEWPHIN_MEMORY_PAGE_TITLE,
            content,
            format: currentPage.format || "markdown"
          });

    return {
      enabled: true,
      page,
      entries: dedupeProjectMemoryEntries(entries)
    };
  }
}

class DisabledProjectMemoryBackend implements ProjectMemoryBackend {
  public async load(): Promise<ProjectMemoryContext> {
    return createDisabledProjectMemoryContext();
  }

  public async saveEntries(_entries: ProjectMemoryEntry[]): Promise<ProjectMemoryContext> {
    throw new Error("Project memory is disabled");
  }
}

function createDisabledProjectMemoryContext(): ProjectMemoryContext {
  return {
    enabled: false,
    page: null,
    entries: []
  };
}

function areEntriesEqual(left: ProjectMemoryEntry[], right: ProjectMemoryEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeConcurrentEntries(
  consolidatedEntries: ProjectMemoryEntry[],
  currentEntries: ProjectMemoryEntry[],
  baseEntries: ProjectMemoryEntry[]
): ProjectMemoryEntry[] | null {
  const baseKeys = new Set(baseEntries.map((entry) => normalizeProjectMemoryText(entry.text)));
  const currentKeys = new Set(currentEntries.map((entry) => normalizeProjectMemoryText(entry.text)));
  for (const baseKey of baseKeys) {
    if (!currentKeys.has(baseKey)) {
      return null;
    }
  }

  const preservedEntries = currentEntries.filter((entry) => !baseKeys.has(normalizeProjectMemoryText(entry.text)));
  return dedupeProjectMemoryEntries([...consolidatedEntries, ...preservedEntries]);
}
