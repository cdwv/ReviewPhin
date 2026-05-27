import { z } from "zod";

export const REVIEWPHIN_MEMORY_PAGE_TITLE = "Reviewphin memory";
export const REVIEWPHIN_MEMORY_PAGE_SLUG = "reviewphin-memory";
export const REVIEWPHIN_MEMORY_SECTION_HEADING = "Remembered project knowledge";

export interface ProjectMemoryEntry {
  text: string;
}

export interface ProjectMemoryPage {
  content?: string | undefined;
  format: string;
  slug: string;
  title: string;
  encoding?: string | undefined;
}

export type ProjectMemoryCoalesceReason = "prompt-budget" | "save-threshold";

export interface ProjectMemoryCoalesceInput {
  entries: ProjectMemoryEntry[];
  maxChars: number;
  targetChars: number;
  reason: ProjectMemoryCoalesceReason;
}

export type ProjectMemoryCoalescer = (
  input: ProjectMemoryCoalesceInput,
) => Promise<ProjectMemoryEntry[]>;

export interface ProjectMemoryContext {
  enabled: boolean;
  page: ProjectMemoryPage | null;
  entries: ProjectMemoryEntry[];
}

function normalizeProjectMemoryToolText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

const projectMemoryToolTextSchema = z
  .string()
  .transform((value) => normalizeProjectMemoryToolText(value))
  .pipe(z.string().min(1).max(500));

export const projectMemoryToolInputSchema = z.object({
  memory: projectMemoryToolTextSchema,
  rationale: projectMemoryToolTextSchema,
  supersedes: z.array(projectMemoryToolTextSchema).max(10).default([]),
});

export type ProjectMemoryToolInput = z.infer<
  typeof projectMemoryToolInputSchema
>;

export interface ProjectMemoryUpdateResult {
  changed: boolean;
  action: "created" | "updated" | "unchanged";
  memory: ProjectMemoryContext;
}
