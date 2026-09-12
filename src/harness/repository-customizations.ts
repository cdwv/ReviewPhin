import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const REVIEWPHIN_DIRECTORY = ".reviewphin";

export interface RepositoryCustomizations {
  instructionDirectories: string[];
  skillDirectories: string[];
  instructions?: string;
}

export function isReviewPhinPath(path: string): boolean {
  return (
    path.startsWith(`${REVIEWPHIN_DIRECTORY}/`) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || part.includes(":"),
      )
  );
}

/** Register local directories; Copilot discovers their modular rules and skills. */
export async function loadRepositoryCustomizations(
  workingDirectory?: string,
): Promise<RepositoryCustomizations | undefined> {
  if (!workingDirectory) return undefined;
  const root = resolve(workingDirectory, REVIEWPHIN_DIRECTORY);
  if (!(await isDirectory(root))) return undefined;

  // The bundled CLI omits AGENTS.md in additional instruction directories.
  let instructions: string | undefined;
  try {
    instructions = await readFile(join(root, "AGENTS.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const skills = join(root, "skills");
  return {
    instructionDirectories: [root],
    skillDirectories: (await isDirectory(skills)) ? [skills] : [],
    ...(instructions?.trim() ? { instructions } : {}),
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
