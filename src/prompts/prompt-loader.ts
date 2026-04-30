import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const promptCache = new Map<string, string>();

export function loadPromptContent(file: string): string {
  const cached = promptCache.get(file);
  if (cached) {
    return cached;
  }

  const path = resolvePromptPath(file);
  const content = readFileSync(path, "utf8").trim();
  promptCache.set(file, content);
  return content;
}

function resolvePromptPath(file: string): string {
  const candidates = getProjectRootCandidates().map((projectRoot) => join(projectRoot, "prompts", ...file.split("/")));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Prompt file not found: ${file}`);
}

function getProjectRootCandidates(): string[] {
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return Array.from(new Set([resolve(process.cwd()), moduleRoot]));
}