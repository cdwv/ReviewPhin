import type { Logger } from "pino";

import { GitLabApiError } from "./client.js";
import { GitLabClient } from "./client.js";
import type { GitLabClient as GitLabClientContract } from "./client.js";
import type { HarnessRunLoggingContext } from "../../harness/types.js";
import {
  areProjectMemoryEntriesEqual,
  mergeConcurrentProjectMemoryEntries,
} from "../../memory/backend-utils.js";
import {
  createDisabledProjectMemoryBackend,
  type ProjectMemoryBackend,
  type ProjectMemoryCapability,
  type ProjectMemorySaveOptions,
} from "../../memory/backend.js";
import {
  deleteStoreProjectMemory,
  InStoreMemoryProvider,
} from "../../memory/store-backend.js";
import {
  dedupeProjectMemoryEntries,
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
import type { ResolvedTenant } from "../IPlatform.js";
import type { StorageStores } from "../../storage/contract/index.js";
import {
  getGitLabConnectionConfig,
  getGitLabTenantConfig,
} from "./tenant-config.js";

export function createGitLabProjectMemoryBackendForTenant(input: {
  resolvedTenant: ResolvedTenant;
  logger: Logger;
  logging?: HarnessRunLoggingContext | undefined;
  enabled: boolean;
  stores: Pick<StorageStores, "projectMemories">;
}): ProjectMemoryBackend {
  const tenantConfig = getGitLabTenantConfig(input.resolvedTenant.tenant);
  const connectionConfig = getGitLabConnectionConfig(
    input.resolvedTenant.connection,
  );
  const client = new GitLabClient({
    baseUrl: connectionConfig.baseUrl,
    apiToken: connectionConfig.apiToken,
    logger: input.logger.child({
      interactionRunId: input.logging?.interactionRunId ?? null,
      interactionJobId: input.logging?.interactionJobId ?? null,
      tenantId: input.logging?.tenantId ?? input.resolvedTenant.tenant.id,
      component: "project-memory-backend",
    }),
  });

  return createGitLabProjectMemoryBackend({
    client,
    projectId: tenantConfig.projectId,
    tenantId: input.resolvedTenant.tenant.id,
    enabled: input.enabled,
    stores: input.stores,
    logger: input.logger,
  });
}

export function createGitLabProjectMemoryBackend(input: {
  client: GitLabClientContract;
  projectId: number;
  tenantId: string;
  enabled: boolean;
  stores: Pick<StorageStores, "projectMemories">;
  logger?: Logger | undefined;
}): ProjectMemoryBackend {
  if (!input.enabled) {
    return createDisabledProjectMemoryBackend();
  }

  return new GitLabProjectMemorySelectionBackend(input);
}

class GitLabProjectMemorySelectionBackend implements ProjectMemoryBackend {
  public constructor(
    private readonly options: {
      client: GitLabClientContract;
      projectId: number;
      tenantId: string;
      stores: Pick<StorageStores, "projectMemories">;
      logger?: Logger | undefined;
    },
  ) {}

  public async getCapability(): Promise<ProjectMemoryCapability> {
    return (await this.resolveBackend()).getCapability();
  }

  public async load(): Promise<ProjectMemoryContext> {
    return (await this.resolveBackend()).load();
  }

  public async saveEntries(
    entries: ProjectMemoryEntry[],
    options: ProjectMemorySaveOptions = {},
  ): Promise<ProjectMemoryContext> {
    return (await this.resolveBackend()).saveEntries(entries, options);
  }

  private async resolveBackend(): Promise<ProjectMemoryBackend> {
    const project = await this.options.client.getProject(this.options.projectId);
    if (gitLabProjectHasWiki(project)) {
      if (await this.options.stores.projectMemories.get(this.options.tenantId)) {
        await deleteStoreProjectMemory({
          stores: this.options.stores,
          tenantId: this.options.tenantId,
        });
        this.options.logger?.info(
          {
            tenantId: this.options.tenantId,
            projectId: this.options.projectId,
          },
          "deleted store-backed project memory because GitLab wiki is enabled",
        );
      }

      return new GitLabWikiProjectMemoryBackend({
        client: this.options.client,
        projectId: this.options.projectId,
      });
    }

    return new InStoreMemoryProvider({
      stores: this.options.stores,
      tenantId: this.options.tenantId,
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

  public async getCapability(): Promise<ProjectMemoryCapability> {
    try {
      await resolveProjectMemoryPage(this.client, this.projectId);
      return { implemented: true, available: true };
    } catch (error) {
      return {
        implemented: true,
        available: false,
        reason:
          error instanceof Error
            ? error.message
            : "GitLab project wiki is unavailable",
      };
    }
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
      const nextEntries = mergeConcurrentProjectMemoryEntries(
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
  return areProjectMemoryEntriesEqual(left, right);
}

function gitLabProjectHasWiki(project: {
  wiki_enabled?: boolean | undefined;
  wiki_access_level?: string | undefined;
}): boolean {
  if (project.wiki_enabled === true) {
    return true;
  }

  return (
    project.wiki_access_level === "enabled" ||
    project.wiki_access_level === "private"
  );
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
