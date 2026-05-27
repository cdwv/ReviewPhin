import type { Logger } from "pino";

import { GitLabApiError } from "./client.js";
import { GitLabClient } from "./client.js";
import type { GitLabClient as GitLabClientContract } from "./client.js";
import type {
  HarnessRunLoggingContext,
} from "../../harness/types.js";
import {
  createDisabledProjectMemoryBackend,
  type ProjectMemoryBackend,
  type ProjectMemorySaveOptions,
} from "../../memory/backend.js";
import {
  dedupeProjectMemoryEntries,
  normalizeProjectMemoryText,
  parseProjectMemoryContent,
  renderProjectMemory,
} from "../../memory/project-memory.js";
import type {
  ProjectMemoryContext,
  ProjectMemoryEntry,
  ProjectMemoryPage,
} from "../../memory/types.js";
import {
  REVIEWPHIN_MEMORY_PAGE_SLUG,
  REVIEWPHIN_MEMORY_PAGE_TITLE,
} from "../../memory/types.js";
import type { TenantRecord } from "../../storage/contract/current.js";
import { getGitLabTenantConfig } from "./tenant-config.js";

export function createGitLabProjectMemoryBackendForTenant(input: {
  tenant: TenantRecord;
  logger: Logger;
  logging?: HarnessRunLoggingContext | undefined;
  enabled: boolean;
}): ProjectMemoryBackend {
  const tenantConfig = getGitLabTenantConfig(input.tenant);
  const client = new GitLabClient({
    baseUrl: tenantConfig.baseUrl,
    apiToken: tenantConfig.apiToken,
    logger: input.logger.child({
      interactionRunId: input.logging?.interactionRunId ?? null,
      interactionJobId: input.logging?.interactionJobId ?? null,
      tenantId: input.logging?.tenantId ?? input.tenant.id,
      component: "project-memory-backend",
    }),
  });

  return createGitLabProjectMemoryBackend({
    client,
    projectId: tenantConfig.projectId,
    enabled: input.enabled,
  });
}

export function createGitLabProjectMemoryBackend(input: {
  client: GitLabClientContract;
  projectId: number;
  enabled: boolean;
}): ProjectMemoryBackend {
  if (!input.enabled) {
    return createDisabledProjectMemoryBackend();
  }

  return new GitLabWikiProjectMemoryBackend({
    client: input.client,
    projectId: input.projectId,
  });
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
      entries: page ? parseProjectMemoryContent(page.content ?? "") : [],
    };
  }

  public async saveEntries(
    entries: ProjectMemoryEntry[],
    options: ProjectMemorySaveOptions = {},
  ): Promise<ProjectMemoryContext> {
    const currentMemory = await this.load();
    if (
      options.baseEntries &&
      !areEntriesEqual(currentMemory.entries, options.baseEntries)
    ) {
      const nextEntries = mergeConcurrentEntries(
        entries,
        currentMemory.entries,
        options.baseEntries,
      );
      if (nextEntries === null) {
        return currentMemory;
      }

      return this.persistEntries(currentMemory.page, nextEntries);
    }

    const nextEntries = dedupeProjectMemoryEntries(entries);
    return this.persistEntries(currentMemory.page, nextEntries);
  }

  private async persistEntries(
    currentPage: ProjectMemoryPage | null,
    entries: ProjectMemoryEntry[],
  ): Promise<ProjectMemoryContext> {
    const content = renderProjectMemory(entries);
    const page =
      currentPage === null
        ? await this.client.createProjectWikiPage(this.projectId, {
            title: REVIEWPHIN_MEMORY_PAGE_TITLE,
            content,
            format: "markdown",
          })
        : await this.client.updateProjectWikiPage(
            this.projectId,
            currentPage.slug,
            {
              title: REVIEWPHIN_MEMORY_PAGE_TITLE,
              content,
              format: currentPage.format || "markdown",
            },
          );

    return {
      enabled: true,
      page,
      entries: dedupeProjectMemoryEntries(entries),
    };
  }
}

function areEntriesEqual(
  left: ProjectMemoryEntry[],
  right: ProjectMemoryEntry[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeConcurrentEntries(
  consolidatedEntries: ProjectMemoryEntry[],
  currentEntries: ProjectMemoryEntry[],
  baseEntries: ProjectMemoryEntry[],
): ProjectMemoryEntry[] | null {
  const baseKeys = new Set(
    baseEntries.map((entry) => normalizeProjectMemoryText(entry.text)),
  );
  const currentKeys = new Set(
    currentEntries.map((entry) => normalizeProjectMemoryText(entry.text)),
  );
  for (const baseKey of baseKeys) {
    if (!currentKeys.has(baseKey)) {
      return null;
    }
  }

  const preservedEntries = currentEntries.filter(
    (entry) => !baseKeys.has(normalizeProjectMemoryText(entry.text)),
  );
  return dedupeProjectMemoryEntries([
    ...consolidatedEntries,
    ...preservedEntries,
  ]);
}

async function resolveProjectMemoryPage(
  client: GitLabClientContract,
  projectId: number,
): Promise<ProjectMemoryPage | null> {
  const attemptedSlugs = new Set<string>();
  for (const slug of buildWikiSlugCandidates(REVIEWPHIN_MEMORY_PAGE_TITLE)) {
    attemptedSlugs.add(slug);
    try {
      return await client.getProjectWikiPage(projectId, slug);
    } catch (error) {
      if (!(error instanceof GitLabApiError) || error.status !== 404) {
        throw error;
      }
    }
  }

  const pages = await client.listProjectWikiPages(projectId);
  const exactMatch = pages.find(
    (page) =>
      normalizeWikiTitle(page.title) ===
      normalizeWikiTitle(REVIEWPHIN_MEMORY_PAGE_TITLE),
  );
  if (!exactMatch) {
    return null;
  }

  if (exactMatch.content !== undefined) {
    return exactMatch;
  }

  if (attemptedSlugs.has(exactMatch.slug)) {
    return null;
  }

  try {
    return await client.getProjectWikiPage(projectId, exactMatch.slug);
  } catch (error) {
    if (error instanceof GitLabApiError && error.status === 404) {
      return null;
    }

    throw error;
  }
}

function buildWikiSlugCandidates(title: string): string[] {
  return Array.from<string>(
    new Set<string>([
      REVIEWPHIN_MEMORY_PAGE_SLUG,
      title.replace(/\s+/g, "-"),
      title.toLowerCase().replace(/\s+/g, "-"),
    ]),
  );
}

function normalizeWikiTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}
