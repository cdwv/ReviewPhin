import { GitLabApiError, type GitLabClient } from "../gitlab/client.js";
import type { GitLabWikiPage } from "../gitlab/types.js";
import {
  REVIEWPHIN_MEMORY_PAGE_SLUG,
  REVIEWPHIN_MEMORY_PAGE_TITLE,
  REVIEWPHIN_MEMORY_SECTION_HEADING,
  type ProjectMemoryCoalescer,
  type ProjectMemoryContext,
  type ProjectMemoryEntry,
  type ProjectMemoryToolInput,
  type ProjectMemoryUpdateResult
} from "./types.js";

const MEMORY_SAVE_COALESCE_THRESHOLD_RATIO = 0.9;
const MEMORY_COALESCE_TARGET_RATIO = 0.75;

export async function loadProjectMemory(
  client: GitLabClient,
  projectId: number,
  enabled: boolean
): Promise<ProjectMemoryContext> {
  if (!enabled) {
    return {
      enabled: false,
      page: null,
      entries: []
    };
  }

  const page = await resolveProjectMemoryPage(client, projectId);
  return {
    enabled: true,
    page,
    entries: page ? parseProjectMemoryContent(page.content ?? "") : []
  };
}

export async function updateProjectMemory(
  client: GitLabClient,
  projectId: number,
  currentMemory: ProjectMemoryContext,
  input: ProjectMemoryToolInput,
  options: {
    maxChars: number;
    coalesce?: ProjectMemoryCoalescer | undefined;
  }
): Promise<ProjectMemoryUpdateResult> {
  if (!currentMemory.enabled) {
    throw new Error("Project memory is disabled");
  }

  let nextEntries = mergeProjectMemoryEntries(currentMemory.entries, input);
  const unchanged = areMemoryEntriesEqual(currentMemory.entries, nextEntries);
  if (unchanged) {
    return {
      changed: false,
      action: "unchanged",
      memory: {
        ...currentMemory,
        entries: nextEntries
      }
    };
  }

  nextEntries = await maybeCoalesceProjectMemoryEntries(nextEntries, {
    maxChars: options.maxChars,
    triggerChars: Math.floor(options.maxChars * MEMORY_SAVE_COALESCE_THRESHOLD_RATIO),
    targetChars: Math.floor(options.maxChars * MEMORY_COALESCE_TARGET_RATIO),
    coalesce: options.coalesce,
    reason: "save-threshold"
  });

  const content = renderProjectMemory(nextEntries);
  const page =
    currentMemory.page === null
      ? await client.createProjectWikiPage(projectId, {
          title: REVIEWPHIN_MEMORY_PAGE_TITLE,
          content,
          format: "markdown"
        })
      : await client.updateProjectWikiPage(projectId, currentMemory.page.slug, {
          title: REVIEWPHIN_MEMORY_PAGE_TITLE,
          content,
          format: currentMemory.page.format || "markdown"
        });

  return {
    changed: true,
    action: currentMemory.page === null ? "created" : "updated",
    memory: {
      enabled: true,
      page,
      entries: nextEntries
    }
  };
}

export async function resolveProjectMemoryPage(
  client: GitLabClient,
  projectId: number
): Promise<GitLabWikiPage | null> {
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
  const exactMatch = pages.find((page) => normalizeWikiTitle(page.title) === normalizeWikiTitle(REVIEWPHIN_MEMORY_PAGE_TITLE));
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

export function parseProjectMemoryContent(content: string): ProjectMemoryEntry[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const entries: ProjectMemoryEntry[] = [];
  let inManagedSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+/.test(trimmed)) {
      inManagedSection = trimmed.toLowerCase() === `## ${REVIEWPHIN_MEMORY_SECTION_HEADING}`.toLowerCase();
      continue;
    }

    if (!inManagedSection) {
      continue;
    }

    const bulletMatch = /^\s*-\s+(.*\S)\s*$/.exec(line);
    if (!bulletMatch) {
      continue;
    }

    const text = bulletMatch[1];
    if (!text) {
      continue;
    }

    const trimmedText = text.trim();
    if (trimmedText.startsWith("_") && trimmedText.endsWith("_")) {
      continue;
    }

    entries.push({ text: trimmedText });
  }

  return dedupeProjectMemoryEntries(entries);
}

export function renderProjectMemory(entries: ProjectMemoryEntry[]): string {
  const dedupedEntries = dedupeProjectMemoryEntries(entries);

  return [
    `# ${REVIEWPHIN_MEMORY_PAGE_TITLE}`,
    "",
    "> This page is managed by Reviewphin and stores durable, project-specific context learned from user comments.",
    "",
    `## ${REVIEWPHIN_MEMORY_SECTION_HEADING}`,
    dedupedEntries.length > 0 ? dedupedEntries.map((entry) => `- ${entry.text}`).join("\n") : "_No remembered project knowledge yet._",
    "",
    "## Update policy",
    "- Keep durable project facts, team conventions, preferences, and long-term policies.",
    "- Do not store merge-request-specific remarks, temporary incidents, or one-off review requests."
  ].join("\n");
}

export function getProjectMemoryContentLength(entries: ProjectMemoryEntry[]): number {
  return renderProjectMemory(entries).length;
}

export function mergeProjectMemoryEntries(
  existingEntries: ProjectMemoryEntry[],
  input: Pick<ProjectMemoryToolInput, "memory" | "supersedes">
): ProjectMemoryEntry[] {
  const nextEntries = existingEntries.map((entry) => ({ ...entry }));
  const supersededKeys = new Set(input.supersedes.map(normalizeMemoryText));
  const normalizedIncoming = normalizeMemoryText(input.memory);
  const earliestSupersededIndex = nextEntries.findIndex((entry) => supersededKeys.has(normalizeMemoryText(entry.text)));
  const filteredEntries = nextEntries.filter((entry) => !supersededKeys.has(normalizeMemoryText(entry.text)));
  const existingIndex = filteredEntries.findIndex((entry) => normalizeMemoryText(entry.text) === normalizedIncoming);
  const replacementEntry = { text: input.memory };

  if (existingIndex >= 0) {
    filteredEntries[existingIndex] = replacementEntry;
    return dedupeProjectMemoryEntries(filteredEntries);
  }

  if (earliestSupersededIndex >= 0) {
    filteredEntries.splice(earliestSupersededIndex, 0, replacementEntry);
    return dedupeProjectMemoryEntries(filteredEntries);
  }

  filteredEntries.push(replacementEntry);
  return dedupeProjectMemoryEntries(filteredEntries);
}

function dedupeProjectMemoryEntries(entries: ProjectMemoryEntry[]): ProjectMemoryEntry[] {
  const dedupedEntries: ProjectMemoryEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const text = entry.text.trim();
    if (!text) {
      continue;
    }

    const normalized = normalizeMemoryText(text);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    dedupedEntries.push({ text });
  }

  return dedupedEntries;
}

function areMemoryEntriesEqual(left: ProjectMemoryEntry[], right: ProjectMemoryEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildWikiSlugCandidates(title: string): string[] {
  return Array.from(
    new Set([
      REVIEWPHIN_MEMORY_PAGE_SLUG,
      title.replace(/\s+/g, "-"),
      title.toLowerCase().replace(/\s+/g, "-")
    ])
  );
}

function normalizeWikiTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeMemoryText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

async function maybeCoalesceProjectMemoryEntries(
  entries: ProjectMemoryEntry[],
  options: {
    maxChars: number;
    triggerChars: number;
    targetChars: number;
    coalesce?: ProjectMemoryCoalescer | undefined;
    reason: "prompt-budget" | "save-threshold";
  }
): Promise<ProjectMemoryEntry[]> {
  if (!options.coalesce || getProjectMemoryContentLength(entries) <= options.triggerChars) {
    return entries;
  }

  return dedupeProjectMemoryEntries(
    await options.coalesce({
      entries,
      maxChars: options.maxChars,
      targetChars: options.targetChars,
      reason: options.reason
    })
  );
}
