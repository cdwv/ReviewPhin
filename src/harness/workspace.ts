export const DEFAULT_REPOSITORY_INSTRUCTION_FILES = [
  "AGENTS.md",
  ".github/copilot-instructions.md",
] as const;

export const DEFAULT_REPOSITORY_INSTRUCTION_DIRECTORY =
  ".github/instructions";

export function isDefaultRepositoryInstructionFile(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    DEFAULT_REPOSITORY_INSTRUCTION_FILES.includes(
      normalized as (typeof DEFAULT_REPOSITORY_INSTRUCTION_FILES)[number],
    ) ||
    (normalized.startsWith(
      `${DEFAULT_REPOSITORY_INSTRUCTION_DIRECTORY}/`,
    ) &&
      normalized.endsWith(".instructions.md"))
  );
}
