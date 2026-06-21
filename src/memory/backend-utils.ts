import {
  dedupeProjectMemoryEntries,
  normalizeProjectMemoryText,
} from "./project-memory.js";
import type { ProjectMemoryEntry } from "./types.js";

export function areProjectMemoryEntriesEqual(
  left: ProjectMemoryEntry[],
  right: ProjectMemoryEntry[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeConcurrentProjectMemoryEntries(
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
