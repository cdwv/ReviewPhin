import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type PromptFileName = "main.md" | "context-analyst.md" | "review-author.md";

const promptCache = new Map<PromptFileName, string>();

export function loadReviewPromptFile(name: PromptFileName): string {
  const cached = promptCache.get(name);
  if (cached) {
    return cached;
  }

  const path = resolvePromptPath(name);
  const content = readFileSync(path, "utf8").trim();
  promptCache.set(name, content);
  return content;
}

function resolvePromptPath(name: PromptFileName): string {
  const candidates = [
    resolve(process.cwd(), "prompts", "review", name),
    resolve(process.cwd(), "..", "prompts", "review", name)
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Review prompt file not found: ${name}`);
}
