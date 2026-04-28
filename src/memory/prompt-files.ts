import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PromptFileName = "coalesce.md";

const promptCache = new Map<PromptFileName, string>();

export function loadProjectMemoryPromptFile(name: PromptFileName): string {
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
  const candidates = getProjectRootCandidates().map((projectRoot) =>
    join(projectRoot, "prompts", "memory", name)
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Project memory prompt file not found: ${name}`);
}

function getProjectRootCandidates(): string[] {
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return Array.from(new Set([resolve(process.cwd()), moduleRoot]));
}
