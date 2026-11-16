import { mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWorkspaceFile } from "../src/harness/codex-workspace.js";

describe("Codex workspace read", () => {
  it("reads files in the workspace but rejects traversal and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewphin-workspace-"));
    try {
      await writeFile(join(root, "example.ts"), "export const example = 1;\n");
      await symlink("/etc/passwd", join(root, "escape"));
      expect(await readWorkspaceFile(root, "example.ts")).toBe(
        await readFile(join(root, "example.ts"), "utf8"),
      );
      await expect(readWorkspaceFile(root, "../outside")).rejects.toThrow();
      await expect(readWorkspaceFile(root, "escape")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
