import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_FILE_BYTES = 200_000;

/** Read a bounded page of a regular file inside the hydrated repository. */
export async function readWorkspaceFile(
  root: string,
  path: string,
  offset = 0,
): Promise<string> {
  if (
    isAbsolute(path) ||
    path.includes("\0") ||
    path.split(/[\\/]/).includes(".git")
  )
    throw new Error("Invalid workspace path");
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid offset");
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, path);
  const relativePath = relative(canonicalRoot, candidate);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  )
    throw new Error("Path is outside workspace");
  const canonicalFile = await realpath(candidate);
  const canonicalRelative = relative(canonicalRoot, canonicalFile);
  if (
    !canonicalRelative ||
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${sep}`) ||
    canonicalRelative.split(sep).includes(".git")
  )
    throw new Error("Path is outside workspace");
  const file = await open(
    canonicalFile,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Path is not a regular file");
    const buffer = Buffer.alloc(
      Math.min(MAX_FILE_BYTES, Math.max(0, info.size - offset)),
    );
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return offset + bytesRead < info.size
      ? `${text}\n[File truncated. Continue with offset ${offset + bytesRead}.]`
      : text;
  } finally {
    await file.close();
  }
}
