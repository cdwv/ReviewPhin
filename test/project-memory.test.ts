import { describe, expect, it, vi } from "vitest";

import { GitLabApiError } from "../src/platforms/gitlab/client.js";
import {
  createGitLabProjectMemoryBackend,
  GitLabWikiProjectMemoryBackend,
} from "../src/platforms/gitlab/project-memory-backend.js";
import {
  deleteStoreProjectMemory,
  InStoreMemoryProvider,
} from "../src/memory/store-backend.js";
import {
  mergeProjectMemoryEntries,
  parseProjectMemoryContent,
  renderProjectMemory,
} from "../src/memory/project-memory.js";
import type { ProjectMemoryRecord } from "../src/storage/contract/index.js";
import {
  REVIEWPHIN_MEMORY_PAGE_TITLE,
  projectMemoryToolInputSchema,
} from "../src/memory/types.js";

describe("project memory", () => {
  it("renders and parses the managed wiki format deterministically", () => {
    const rendered = renderProjectMemory([
      { text: "We generally prefer small focused PRs." },
      { text: "Team policy is to avoid snapshot tests for API responses." },
    ]);

    expect(rendered).toContain(`# ${REVIEWPHIN_MEMORY_PAGE_TITLE}`);
    expect(rendered).toContain("## Remembered project knowledge");
    expect(parseProjectMemoryContent(rendered)).toEqual([
      { text: "We generally prefer small focused PRs." },
      { text: "Team policy is to avoid snapshot tests for API responses." },
    ]);
  });

  it("deduplicates near-identical memories and replaces superseded ones", () => {
    const merged = mergeProjectMemoryEntries(
      [
        { text: "Team policy is to avoid snapshot tests for API responses." },
        { text: "We generally prefer pnpm for local scripts." },
      ],
      {
        memory: "Our team policy is to avoid snapshot tests for API responses.",
        supersedes: [
          "Team policy is to avoid snapshot tests for API responses.",
        ],
      },
    );

    expect(merged).toEqual([
      { text: "Our team policy is to avoid snapshot tests for API responses." },
      { text: "We generally prefer pnpm for local scripts." },
    ]);
  });

  it("normalizes multiline tool input into single-line memory entries", () => {
    const parsed = projectMemoryToolInputSchema.parse({
      memory: "For future reference,\nplease add dolphin jokes when they fit.",
      rationale: "Stable tone preference\nfor summaries.",
      supersedes: ["Earlier preference:\nkeep the tone dry."],
    });

    expect(parsed).toEqual({
      memory: "For future reference, please add dolphin jokes when they fit.",
      rationale: "Stable tone preference for summaries.",
      supersedes: ["Earlier preference: keep the tone dry."],
    });
  });

  it("loads the canonical slug directly before attempting a wiki listing", async () => {
    const getProjectWikiPage = vi.fn(
      async (_projectId: number, slug: string) => {
        if (slug !== "reviewphin-memory") {
          throw new GitLabApiError(
            "not found",
            404,
            "missing",
            "https://gitlab.example.com",
          );
        }

        return {
          title: REVIEWPHIN_MEMORY_PAGE_TITLE,
          slug,
          format: "markdown",
          content:
            "## Remembered project knowledge\n- We generally prefer small focused PRs.",
        };
      },
    );
    const backend = new GitLabWikiProjectMemoryBackend({
      client: {
        listProjectWikiPages: vi.fn(async () => []),
        getProjectWikiPage,
      } as never,
      projectId: 1085,
    });

    const memory = await backend.load();

    expect(getProjectWikiPage).toHaveBeenCalledWith(1085, "reviewphin-memory");
    expect(memory.page?.slug).toBe("reviewphin-memory");
  });

  it("falls back to listing wiki metadata when direct slug lookups miss", async () => {
    const getProjectWikiPage = vi.fn(
      async (_projectId: number, slug: string) => {
        if (slug === "reviewphin-memory-page") {
          return {
            title: REVIEWPHIN_MEMORY_PAGE_TITLE,
            slug,
            format: "markdown",
            content:
              "## Remembered project knowledge\n- Team policy is to use squash merges.",
          };
        }

        throw new GitLabApiError(
          "not found",
          404,
          "missing",
          "https://gitlab.example.com",
        );
      },
    );
    const listProjectWikiPages = vi.fn(async () => [
      {
        title: REVIEWPHIN_MEMORY_PAGE_TITLE,
        slug: "reviewphin-memory-page",
        format: "markdown",
      },
    ]);
    const backend = new GitLabWikiProjectMemoryBackend({
      client: {
        listProjectWikiPages,
        getProjectWikiPage,
      } as never,
      projectId: 1085,
    });

    const memory = await backend.load();

    expect(listProjectWikiPages).toHaveBeenCalledWith(1085);
    expect(memory.entries).toEqual([
      { text: "Team policy is to use squash merges." },
    ]);
  });

  it("saves the provided memory entries into the wiki page", async () => {
    const createProjectWikiPage = vi.fn(
      async (
        _projectId: number,
        input: { title: string; content: string },
      ) => ({
        title: input.title,
        slug: "Reviewphin-memory",
        format: "markdown",
        content: input.content,
      }),
    );
    const backend = new GitLabWikiProjectMemoryBackend({
      client: {
        createProjectWikiPage,
        updateProjectWikiPage: vi.fn(),
        listProjectWikiPages: vi.fn(async () => []),
        getProjectWikiPage: vi.fn(async () => {
          throw new GitLabApiError(
            "not found",
            404,
            "missing",
            "https://gitlab.example.com",
          );
        }),
      } as never,
      projectId: 1085,
    });

    const result = await backend.saveEntries([
      {
        text: "For future reference, we generally keep API validation in zod schemas.",
      },
    ]);

    expect(createProjectWikiPage).toHaveBeenCalledWith(
      1085,
      expect.objectContaining({
        title: REVIEWPHIN_MEMORY_PAGE_TITLE,
        format: "markdown",
      }),
    );
    expect(result.entries).toEqual([
      {
        text: "For future reference, we generally keep API validation in zod schemas.",
      },
    ]);
  });

  it("round-trips normalized multiline memory through the managed wiki format", () => {
    const entry = projectMemoryToolInputSchema.parse({
      memory: "For future reference,\nadd dolphin jokes when they fit.",
      rationale: "Stable tone preference",
    }).memory;

    const rendered = renderProjectMemory([{ text: entry }]);

    expect(parseProjectMemoryContent(rendered)).toEqual([
      { text: "For future reference, add dolphin jokes when they fit." },
    ]);
  });

  it("returns empty memory when the page is missing", async () => {
    const getProjectWikiPage = vi.fn(async () => {
      throw new GitLabApiError(
        "not found",
        404,
        "missing",
        "https://gitlab.example.com",
      );
    });
    const backend = new GitLabWikiProjectMemoryBackend({
      client: {
        listProjectWikiPages: vi.fn(async () => []),
        getProjectWikiPage,
      } as never,
      projectId: 1085,
    });

    const memory = await backend.load();

    expect(getProjectWikiPage).toHaveBeenCalledWith(1085, "reviewphin-memory");
    expect(memory.entries).toEqual([]);
    expect(memory.page).toBeNull();
  });

  it("preserves concurrent additions when consolidated memory is saved back", async () => {
    const updateProjectWikiPage = vi.fn(
      async (
        _projectId: number,
        _slug: string,
        input: { content: string },
      ) => ({
        title: REVIEWPHIN_MEMORY_PAGE_TITLE,
        slug: "reviewphin-memory",
        format: "markdown",
        content: input.content,
      }),
    );
    const backend = new GitLabWikiProjectMemoryBackend({
      client: {
        createProjectWikiPage: vi.fn(),
        updateProjectWikiPage,
        getProjectWikiPage: vi.fn(async () => ({
          title: REVIEWPHIN_MEMORY_PAGE_TITLE,
          slug: "reviewphin-memory",
          format: "markdown",
          content:
            "## Remembered project knowledge\n- We generally keep API validation in zod schemas.\n- We generally avoid snapshot tests for API responses.\n- We use pnpm for scripts.",
        })),
        listProjectWikiPages: vi.fn(async () => []),
      } as never,
      projectId: 1085,
    });

    const result = await backend.saveEntries(
      [
        {
          text: "We generally keep API validation in zod schemas and avoid snapshot tests for API responses.",
        },
      ],
      {
        baseEntries: [
          { text: "We generally keep API validation in zod schemas." },
          { text: "We generally avoid snapshot tests for API responses." },
        ],
      },
    );

    expect(updateProjectWikiPage).toHaveBeenCalledOnce();
    expect(result.entries).toEqual([
      {
        text: "We generally keep API validation in zod schemas and avoid snapshot tests for API responses.",
      },
      { text: "We use pnpm for scripts." },
    ]);
  });

  it("abandons stale consolidation when a base entry was superseded concurrently", async () => {
    const updateProjectWikiPage = vi.fn(
      async (
        _projectId: number,
        _slug: string,
        input: { content: string },
      ) => ({
        title: REVIEWPHIN_MEMORY_PAGE_TITLE,
        slug: "reviewphin-memory",
        format: "markdown",
        content: input.content,
      }),
    );
    const backend = new GitLabWikiProjectMemoryBackend({
      client: {
        createProjectWikiPage: vi.fn(),
        updateProjectWikiPage,
        getProjectWikiPage: vi.fn(async () => ({
          title: REVIEWPHIN_MEMORY_PAGE_TITLE,
          slug: "reviewphin-memory",
          format: "markdown",
          content:
            "## Remembered project knowledge\n- We now use Vitest for tests.\n- We generally avoid snapshot tests for API responses.",
        })),
        listProjectWikiPages: vi.fn(async () => []),
      } as never,
      projectId: 1085,
    });

    const result = await backend.saveEntries(
      [
        {
          text: "We generally use Jest and avoid snapshot tests for API responses.",
        },
      ],
      {
        baseEntries: [
          { text: "We generally use Jest for tests." },
          { text: "We generally avoid snapshot tests for API responses." },
        ],
      },
    );

    expect(updateProjectWikiPage).not.toHaveBeenCalled();
    expect(result.entries).toEqual([
      { text: "We now use Vitest for tests." },
      { text: "We generally avoid snapshot tests for API responses." },
    ]);
  });

  it("abandons stale consolidation when a base entry was removed concurrently", async () => {
    const updateProjectWikiPage = vi.fn(
      async (
        _projectId: number,
        _slug: string,
        input: { content: string },
      ) => ({
        title: REVIEWPHIN_MEMORY_PAGE_TITLE,
        slug: "reviewphin-memory",
        format: "markdown",
        content: input.content,
      }),
    );
    const backend = new GitLabWikiProjectMemoryBackend({
      client: {
        createProjectWikiPage: vi.fn(),
        updateProjectWikiPage,
        getProjectWikiPage: vi.fn(async () => ({
          title: REVIEWPHIN_MEMORY_PAGE_TITLE,
          slug: "reviewphin-memory",
          format: "markdown",
          content:
            "## Remembered project knowledge\n- We generally keep API validation in zod schemas.",
        })),
        listProjectWikiPages: vi.fn(async () => []),
      } as never,
      projectId: 1085,
    });

    const result = await backend.saveEntries(
      [
        {
          text: "We generally keep API validation in zod schemas and avoid snapshot tests for API responses.",
        },
      ],
      {
        baseEntries: [
          { text: "We generally keep API validation in zod schemas." },
          { text: "We generally avoid snapshot tests for API responses." },
        ],
      },
    );

    expect(updateProjectWikiPage).not.toHaveBeenCalled();
    expect(result.entries).toEqual([
      { text: "We generally keep API validation in zod schemas." },
    ]);
  });
});

describe("InStoreMemoryProvider", () => {
  it("loads empty enabled memory when no row exists", async () => {
    const store = createProjectMemoryStore();
    const backend = new InStoreMemoryProvider({
      stores: { projectMemories: store },
      tenantId: "tenant-1",
    });

    await expect(backend.load()).resolves.toEqual({
      enabled: true,
      page: null,
      entries: [],
    });
  });

  it("loads, dedupes, and saves entries in the tenant row", async () => {
    const store = createProjectMemoryStore();
    await store.upsert({
      id: "tenant-1",
      tenantId: "tenant-1",
      entriesJson: JSON.stringify([
        { text: "Use pnpm for scripts." },
        { text: "Use pnpm for scripts." },
      ]),
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    const backend = new InStoreMemoryProvider({
      stores: { projectMemories: store },
      tenantId: "tenant-1",
    });

    await expect(backend.load()).resolves.toMatchObject({
      entries: [{ text: "Use pnpm for scripts." }],
    });

    const saved = await backend.saveEntries([
      { text: "Use Vitest for focused tests." },
      { text: "Use Vitest for focused tests." },
    ]);

    expect(saved.entries).toEqual([{ text: "Use Vitest for focused tests." }]);
    await expect(store.get("tenant-1")).resolves.toMatchObject({
      id: "tenant-1",
      tenantId: "tenant-1",
      entriesJson: JSON.stringify([{ text: "Use Vitest for focused tests." }]),
      createdAt: "2026-06-20T00:00:00.000Z",
    });
  });

  it("preserves concurrent additions and abandons stale consolidation", async () => {
    const store = createProjectMemoryStore();
    await store.upsert({
      id: "tenant-1",
      tenantId: "tenant-1",
      entriesJson: JSON.stringify([
        { text: "Use Zod for API validation." },
        { text: "Avoid broad snapshot tests." },
        { text: "Use pnpm for scripts." },
      ]),
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    const backend = new InStoreMemoryProvider({
      stores: { projectMemories: store },
      tenantId: "tenant-1",
    });

    await expect(
      backend.saveEntries(
        [{ text: "Use Zod and avoid broad snapshot tests." }],
        {
          baseEntries: [
            { text: "Use Zod for API validation." },
            { text: "Avoid broad snapshot tests." },
          ],
        },
      ),
    ).resolves.toMatchObject({
      entries: [
        { text: "Use Zod and avoid broad snapshot tests." },
        { text: "Use pnpm for scripts." },
      ],
    });

    await expect(
      backend.saveEntries(
        [{ text: "Use Jest and pnpm." }],
        {
          baseEntries: [
            { text: "Use Jest for tests." },
            { text: "Use pnpm for scripts." },
          ],
        },
      ),
    ).resolves.toMatchObject({
      entries: [
        { text: "Use Zod and avoid broad snapshot tests." },
        { text: "Use pnpm for scripts." },
      ],
    });
  });

  it("deletes store memory for a tenant", async () => {
    const store = createProjectMemoryStore();
    await store.upsert({
      id: "tenant-1",
      tenantId: "tenant-1",
      entriesJson: "[]",
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    });

    await deleteStoreProjectMemory({
      stores: { projectMemories: store },
      tenantId: "tenant-1",
    });

    await expect(store.get("tenant-1")).resolves.toBeNull();
  });
});

describe("GitLab project memory selection", () => {
  it("uses store-backed memory when project metadata reports wiki disabled", async () => {
    const store = createProjectMemoryStore();
    await store.upsert({
      id: "tenant-1",
      tenantId: "tenant-1",
      entriesJson: JSON.stringify([{ text: "Use store memory." }]),
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    const backend = createGitLabProjectMemoryBackend({
      client: {
        getProject: vi.fn(async () => ({
          id: 1085,
          web_url: "https://gitlab.example.com/group/project",
          path_with_namespace: "group/project",
          http_url_to_repo: "https://gitlab.example.com/group/project.git",
          wiki_enabled: false,
        })),
      } as never,
      projectId: 1085,
      tenantId: "tenant-1",
      enabled: true,
      stores: { projectMemories: store },
    });

    await expect(backend.load()).resolves.toMatchObject({
      enabled: true,
      page: null,
      entries: [{ text: "Use store memory." }],
    });
  });

  it("uses GitLab wiki memory and deletes store memory when wiki is enabled", async () => {
    const store = createProjectMemoryStore();
    await store.upsert({
      id: "tenant-1",
      tenantId: "tenant-1",
      entriesJson: JSON.stringify([{ text: "Use stale store memory." }]),
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    const backend = createGitLabProjectMemoryBackend({
      client: {
        getProject: vi.fn(async () => ({
          id: 1085,
          web_url: "https://gitlab.example.com/group/project",
          path_with_namespace: "group/project",
          http_url_to_repo: "https://gitlab.example.com/group/project.git",
          wiki_enabled: true,
        })),
        getProjectWikiPage: vi.fn(async () => ({
          title: REVIEWPHIN_MEMORY_PAGE_TITLE,
          slug: "reviewphin-memory",
          format: "markdown",
          content:
            "## Remembered project knowledge\n- Use GitLab wiki memory.",
        })),
        listProjectWikiPages: vi.fn(async () => []),
      } as never,
      projectId: 1085,
      tenantId: "tenant-1",
      enabled: true,
      stores: { projectMemories: store },
    });

    await expect(backend.load()).resolves.toMatchObject({
      page: { slug: "reviewphin-memory" },
      entries: [{ text: "Use GitLab wiki memory." }],
    });
    await expect(store.get("tenant-1")).resolves.toBeNull();
  });
});

function createProjectMemoryStore() {
  const records = new Map<string, ProjectMemoryRecord>();
  return {
    get: vi.fn(async (id: string) => records.get(id) ?? null),
    getMany: vi.fn(async (ids: string[]) =>
      ids.flatMap((id) => records.get(id) ?? []),
    ),
    find: vi.fn(async () => null),
    list: vi.fn(async () => [...records.values()]),
    upsert: vi.fn(async (record: ProjectMemoryRecord) => {
      records.set(record.id, record);
    }),
    upsertMany: vi.fn(async (entries: ProjectMemoryRecord[]) => {
      for (const record of entries) {
        records.set(record.id, record);
      }
    }),
    replace: vi.fn(async (record: ProjectMemoryRecord) => {
      records.set(record.id, record);
    }),
    replaceMany: vi.fn(async () => {}),
    update: vi.fn(async ({ id, value }) => {
      records.set(id, value);
    }),
    updateMany: vi.fn(async () => {}),
    patch: vi.fn(async ({ id, value }) => {
      const current = records.get(id);
      if (current) {
        records.set(id, { ...current, ...value });
      }
    }),
    patchMany: vi.fn(async () => {}),
    delete: vi.fn(async (id: string) => {
      records.delete(id);
    }),
    deleteMany: vi.fn(async (ids: string[]) => {
      for (const id of ids) {
        records.delete(id);
      }
    }),
  };
}
