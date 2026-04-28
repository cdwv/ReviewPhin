import { describe, expect, it, vi } from "vitest";

import { GitLabApiError } from "../src/gitlab/client.js";
import {
  loadProjectMemory,
  mergeProjectMemoryEntries,
  renderProjectMemory,
  parseProjectMemoryContent,
  updateProjectMemory
} from "../src/memory/project-memory.js";
import { REVIEWPHIN_MEMORY_PAGE_TITLE, projectMemoryToolInputSchema } from "../src/memory/types.js";

describe("project memory", () => {
  it("renders and parses the managed wiki format deterministically", () => {
    const rendered = renderProjectMemory([
      { text: "We generally prefer small focused PRs." },
      { text: "Team policy is to avoid snapshot tests for API responses." }
    ]);

    expect(rendered).toContain(`# ${REVIEWPHIN_MEMORY_PAGE_TITLE}`);
    expect(rendered).toContain("## Remembered project knowledge");
    expect(parseProjectMemoryContent(rendered)).toEqual([
      { text: "We generally prefer small focused PRs." },
      { text: "Team policy is to avoid snapshot tests for API responses." }
    ]);
  });

  it("deduplicates near-identical memories and replaces superseded ones", () => {
    const merged = mergeProjectMemoryEntries(
      [
        { text: "Team policy is to avoid snapshot tests for API responses." },
        { text: "We generally prefer pnpm for local scripts." }
      ],
      {
        memory: "Our team policy is to avoid snapshot tests for API responses.",
        supersedes: ["Team policy is to avoid snapshot tests for API responses."]
      }
    );

    expect(merged).toEqual([
      { text: "Our team policy is to avoid snapshot tests for API responses." },
      { text: "We generally prefer pnpm for local scripts." }
    ]);
  });

  it("normalizes multiline tool input into single-line memory entries", () => {
    const parsed = projectMemoryToolInputSchema.parse({
      memory: "For future reference,\nplease add dolphin jokes when they fit.",
      rationale: "Stable tone preference\nfor summaries.",
      supersedes: ["Earlier preference:\nkeep the tone dry."]
    });

    expect(parsed).toEqual({
      memory: "For future reference, please add dolphin jokes when they fit.",
      rationale: "Stable tone preference for summaries.",
      supersedes: ["Earlier preference: keep the tone dry."]
    });
  });

  it("loads the canonical slug directly before attempting a wiki listing", async () => {
    const getProjectWikiPage = vi.fn(async (_projectId: number, slug: string) => {
      if (slug !== "reviewphin-memory") {
        throw new GitLabApiError("not found", 404, "missing", "https://gitlab.example.com");
      }

      return {
        title: REVIEWPHIN_MEMORY_PAGE_TITLE,
        slug,
        format: "markdown",
        content: "## Remembered project knowledge\n- We generally prefer small focused PRs."
      };
    });

    const memory = await loadProjectMemory(
      {
        listProjectWikiPages: vi.fn(async () => []),
        getProjectWikiPage
      } as never,
      1085,
      true
    );

    expect(getProjectWikiPage).toHaveBeenCalledWith(1085, "reviewphin-memory");
    expect(memory.page?.slug).toBe("reviewphin-memory");
  });

  it("falls back to listing wiki metadata when direct slug lookups miss", async () => {
    const getProjectWikiPage = vi
      .fn(async (_projectId: number, slug: string) => {
        if (slug === "reviewphin-memory-page") {
          return {
            title: REVIEWPHIN_MEMORY_PAGE_TITLE,
            slug,
            format: "markdown",
            content: "## Remembered project knowledge\n- Team policy is to use squash merges."
          };
        }

        throw new GitLabApiError("not found", 404, "missing", "https://gitlab.example.com");
      });
    const listProjectWikiPages = vi.fn(async () => [
      {
        title: REVIEWPHIN_MEMORY_PAGE_TITLE,
        slug: "reviewphin-memory-page",
        format: "markdown"
      }
    ]);

    const memory = await loadProjectMemory(
      {
        listProjectWikiPages,
        getProjectWikiPage
      } as never,
      1085,
      true
    );

    expect(listProjectWikiPages).toHaveBeenCalledWith(1085);
    expect(memory.entries).toEqual([{ text: "Team policy is to use squash merges." }]);
  });

  it("creates the wiki page when the first memory is stored", async () => {
    const createProjectWikiPage = vi.fn(async (_projectId: number, input: { title: string; content: string }) => ({
      title: input.title,
      slug: "Reviewphin-memory",
      format: "markdown",
      content: input.content
    }));

    const result = await updateProjectMemory(
      {
        createProjectWikiPage,
        updateProjectWikiPage: vi.fn()
      } as never,
      1085,
      {
        enabled: true,
        page: null,
        entries: []
      },
      {
        memory: "For future reference, we generally keep API validation in zod schemas.",
        rationale: "Stable project convention",
        supersedes: []
      },
      {
        maxChars: 5_000
      }
    );

    expect(result.action).toBe("created");
    expect(createProjectWikiPage).toHaveBeenCalledWith(
      1085,
      expect.objectContaining({
        title: REVIEWPHIN_MEMORY_PAGE_TITLE,
        format: "markdown"
      })
    );
    expect(result.memory.entries).toEqual([
      { text: "For future reference, we generally keep API validation in zod schemas." }
    ]);
  });

  it("round-trips normalized multiline memory through the managed wiki format", () => {
    const entry = projectMemoryToolInputSchema.parse({
      memory: "For future reference,\nadd dolphin jokes when they fit.",
      rationale: "Stable tone preference"
    }).memory;

    const rendered = renderProjectMemory([{ text: entry }]);

    expect(parseProjectMemoryContent(rendered)).toEqual([
      { text: "For future reference, add dolphin jokes when they fit." }
    ]);
  });

  it("returns empty memory when the page is missing", async () => {
    const getProjectWikiPage = vi
      .fn(async (_projectId: number, slug: string) => {
        throw new GitLabApiError("not found", 404, "missing", "https://gitlab.example.com");
      });

    const memory = await loadProjectMemory(
      {
        listProjectWikiPages: vi.fn(async () => []),
        getProjectWikiPage
      } as never,
      1085,
      true
    );

    expect(getProjectWikiPage).toHaveBeenCalledWith(1085, "reviewphin-memory");
    expect(memory.entries).toEqual([]);
    expect(memory.page).toBeNull();
  });

  it("coalesces memory before saving when the content nears the configured budget", async () => {
    const updateProjectWikiPage = vi.fn(async (_projectId: number, _slug: string, input: { content: string }) => ({
      title: REVIEWPHIN_MEMORY_PAGE_TITLE,
      slug: "reviewphin-memory",
      format: "markdown",
      content: input.content
    }));
    const coalesce = vi.fn(async () => [
      { text: "We generally keep API validation in zod schemas and avoid snapshot tests for API responses." }
    ]);

    const result = await updateProjectMemory(
      {
        createProjectWikiPage: vi.fn(),
        updateProjectWikiPage
      } as never,
      1085,
      {
        enabled: true,
        page: {
          title: REVIEWPHIN_MEMORY_PAGE_TITLE,
          slug: "reviewphin-memory",
          format: "markdown",
          content: ""
        },
        entries: [
          { text: "We generally keep API validation in zod schemas." },
          { text: "We generally avoid snapshot tests for API responses." }
        ]
      },
      {
        memory: "For future reference, we generally keep request validation close to zod schemas.",
        rationale: "Stable convention",
        supersedes: []
      },
      {
        maxChars: 220,
        coalesce
      }
    );

    expect(coalesce).toHaveBeenCalledOnce();
    expect(updateProjectWikiPage).toHaveBeenCalledOnce();
    expect(result.memory.entries).toEqual([
      { text: "We generally keep API validation in zod schemas and avoid snapshot tests for API responses." }
    ]);
  });
});
