import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { HarnessRunAttachments } from "./types.js";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
const MAX_ATTACHMENT_BYTES = 10_000_000;

export async function prepareCodexAttachments(
  attachments: HarnessRunAttachments | undefined,
  workspace?: string,
): Promise<{ text: string; images: string[] }> {
  const text: string[] = [];
  const images: string[] = [];
  for (const item of attachments ?? []) {
    if (item.type === "blob") {
      const data = Buffer.from(item.data, "base64");
      if (data.length > MAX_ATTACHMENT_BYTES) {
        text.push(
          `Attachment ${item.displayName ?? "blob"} was too large to include.`,
        );
        continue;
      }
      if (item.mimeType.startsWith("image/"))
        images.push(`data:${item.mimeType};base64,${item.data}`);
      else if (
        item.mimeType.startsWith("text/") ||
        item.mimeType === "application/json"
      )
        text.push(
          `Attachment ${item.displayName ?? "text"}:\n${data.toString("utf8").slice(0, 200000)}`,
        );
      else
        text.push(
          `Attachment ${item.displayName ?? "blob"} has unsupported type ${item.mimeType}.`,
        );
      continue;
    }
    if (item.type === "selection" && item.text) {
      text.push(
        `Selection ${item.displayName}:\n${item.text.slice(0, 200000)}`,
      );
      continue;
    }
    if (item.type === "directory") {
      text.push(
        `Attached directory: ${item.path}. Use the workspace tools to inspect it.`,
      );
      continue;
    }
    const path = item.type === "selection" ? item.filePath : item.path;
    if (!workspace) {
      text.push(`Attachment ${path} is unavailable without a workspace.`);
      continue;
    }
    try {
      const base = await realpath(workspace);
      const target = await realpath(
        isAbsolute(path) ? path : resolve(base, path),
      );
      const rel = relative(base, target);
      if (
        !rel ||
        rel === ".." ||
        rel.startsWith(`..${sep}`) ||
        rel.split(sep).includes(".git")
      )
        throw new Error("outside workspace");
      const info = await stat(target);
      if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES)
        throw new Error("not a regular file or too large");
      const data = await readFile(target);
      const ext = target.split(".").pop()?.toLowerCase() ?? "";
      const mime = IMAGE_TYPES[ext];
      if (mime) images.push(`data:${mime};base64,${data.toString("base64")}`);
      else
        text.push(
          `Attachment ${item.displayName ?? path}:\n${data.toString("utf8").slice(0, 200000)}`,
        );
    } catch {
      text.push(`Attachment ${path} could not be read safely.`);
    }
  }
  return { text: text.join("\n\n"), images };
}
