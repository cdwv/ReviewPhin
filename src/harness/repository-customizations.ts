import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const REVIEWPHIN_DIRECTORY = ".reviewphin";
export const MAX_REVIEWPHIN_INSTRUCTION_BYTES = 256 * 1024;

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
  try {
    await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  await rejectLinkedContent(root);
  if (!(await isDirectory(root))) return undefined;

  // The bundled CLI omits AGENTS.md in additional instruction directories.
  let instructions: string | undefined;
  try {
    const path = join(root, "AGENTS.md");
    if ((await lstat(path)).size > MAX_REVIEWPHIN_INSTRUCTION_BYTES) {
      throw new Error(
        ".reviewphin/AGENTS.md exceeds the 256 KiB instruction limit",
      );
    }
    instructions = await readFile(path, "utf8");
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

// Workspaces are prepared before session creation. Inspect metadata only;
// Copilot remains responsible for loading modular instructions and skills.
async function rejectLinkedContent(root: string): Promise<void> {
  const pending = [root];
  while (pending.length) {
    const path = pending.pop()!;
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Symbolic links are not supported in .reviewphin: ${path}`,
      );
    }
    if (entry.isDirectory()) {
      for (const name of await readdir(path)) pending.push(join(path, name));
    } else if (!entry.isFile()) {
      throw new Error(`Not a regular customization file: ${path}`);
    }
  }
}
