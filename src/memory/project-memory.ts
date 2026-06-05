import {
  REVIEWPHIN_MEMORY_PAGE_TITLE,
  REVIEWPHIN_MEMORY_SECTION_HEADING,
  type ProjectMemoryEntry,
  type ProjectMemoryToolInput,
} from "./types.js";

export function parseProjectMemoryContent(
  content: string,
): ProjectMemoryEntry[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const entries: ProjectMemoryEntry[] = [];
  let inManagedSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+/.test(trimmed)) {
      inManagedSection =
        trimmed.toLowerCase() ===
        `## ${REVIEWPHIN_MEMORY_SECTION_HEADING}`.toLowerCase();
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
    dedupedEntries.length > 0
      ? dedupedEntries.map((entry) => `- ${entry.text}`).join("\n")
      : "_No remembered project knowledge yet._",
    "",
    "## Update policy",
    "- Keep durable project facts, team conventions, preferences, and long-term policies.",
    "- Do not store code-review-specific remarks, temporary incidents, or one-off review requests.",
  ].join("\n");
}

export function getProjectMemoryContentLength(
  entries: ProjectMemoryEntry[],
): number {
  return renderProjectMemory(entries).length;
}

export function mergeProjectMemoryEntries(
  existingEntries: ProjectMemoryEntry[],
  input: Pick<ProjectMemoryToolInput, "memory" | "supersedes">,
): ProjectMemoryEntry[] {
  const nextEntries = existingEntries.map((entry) => ({ ...entry }));
  const supersededKeys = new Set(input.supersedes.map(normalizeMemoryText));
  const normalizedIncoming = normalizeProjectMemoryText(input.memory);
  const earliestSupersededIndex = nextEntries.findIndex((entry) =>
    supersededKeys.has(normalizeProjectMemoryText(entry.text)),
  );
  const filteredEntries = nextEntries.filter(
    (entry) => !supersededKeys.has(normalizeProjectMemoryText(entry.text)),
  );
  const existingIndex = filteredEntries.findIndex(
    (entry) => normalizeMemoryText(entry.text) === normalizedIncoming,
  );
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

export function dedupeProjectMemoryEntries(
  entries: ProjectMemoryEntry[],
): ProjectMemoryEntry[] {
  const dedupedEntries: ProjectMemoryEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const text = entry.text.trim();
    if (!text) {
      continue;
    }

    const normalized = normalizeProjectMemoryText(text);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    dedupedEntries.push({ text });
  }

  return dedupedEntries;
}

export function normalizeProjectMemoryText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

function normalizeMemoryText(value: string): string {
  return normalizeProjectMemoryText(value);
}
