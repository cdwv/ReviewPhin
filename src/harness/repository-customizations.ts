import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const REVIEWPHIN_DIRECTORY = ".reviewphin";
export const MAX_CUSTOMIZATION_FILES = 128;
export const MAX_CUSTOMIZATION_FILE_BYTES = 256 * 1024;
export const MAX_CUSTOMIZATION_BYTES = 2 * 1024 * 1024;

export interface RepositoryCustomizations {
  instructionDirectories: string[];
  skillDirectories: string[];
  instructions?: string;
  files: Array<{ path: string; bytes: number }>;
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

/** Validate the entire opt-in directory before allowing the runtime to read it. */
export async function loadRepositoryCustomizations(
  workingDirectory?: string,
): Promise<RepositoryCustomizations | undefined> {
  if (!workingDirectory) return undefined;
  const workspace = resolve(workingDirectory);
  const root = join(workspace, REVIEWPHIN_DIRECTORY);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(
      ".reviewphin must be a regular directory, not a symbolic link",
    );
  }
  const files: RepositoryCustomizations["files"] = [];
  let totalBytes = 0;
  let entryCount = 0;
  let instructions: string | undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(join(workspace, directory))).sort()) {
      const path = `${directory}/${entry}`;
      if (
        ++entryCount > MAX_CUSTOMIZATION_FILES * 2 ||
        !isReviewPhinPath(path)
      ) {
        throw new Error(
          ".reviewphin has too many entries or an unsupported path",
        );
      }
      const stat = await lstat(join(workspace, path));
      if (stat.isSymbolicLink())
        throw new Error(
          `Symbolic links are not supported in .reviewphin: ${path}`,
        );
      if (stat.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!stat.isFile())
        throw new Error(`Not a regular customization file: ${path}`);
      totalBytes += stat.size;
      if (
        files.length >= MAX_CUSTOMIZATION_FILES ||
        stat.size > MAX_CUSTOMIZATION_FILE_BYTES ||
        totalBytes > MAX_CUSTOMIZATION_BYTES
      ) {
        throw new Error(
          ".reviewphin exceeds the customization file or size limit",
        );
      }
      let content: string;
      try {
        content = decoder.decode(await readFile(join(workspace, path)));
      } catch (error) {
        throw new Error(`Cannot read customization as UTF-8 text: ${path}`, {
          cause: error,
        });
      }
      if (content.includes("\0"))
        throw new Error(`Customization files must be UTF-8 text: ${path}`);
      files.push({ path, bytes: stat.size });
      if (path === ".reviewphin/AGENTS.md" && content.trim())
        instructions = content;
    }
  }
  await visit(REVIEWPHIN_DIRECTORY);
  return {
    instructionDirectories: files.some((file) =>
      file.path.endsWith(".instructions.md"),
    )
      ? [root]
      : [],
    skillDirectories: files.some((file) =>
      /^\.reviewphin\/skills\/[^/]+\/SKILL\.md$/.test(file.path),
    )
      ? [join(root, "skills")]
      : [],
    ...(instructions ? { instructions } : {}),
    files,
  };
}
