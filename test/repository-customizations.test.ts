import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRepositoryCustomizations,
  MAX_CUSTOMIZATION_FILE_BYTES,
} from "../src/harness/repository-customizations.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reviewphin-customizations-"));
  roots.push(root);
  await mkdir(join(root, ".reviewphin/skills/security/references"), {
    recursive: true,
  });
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("repository customizations", () => {
  it("does not discover project files without an explicit workspace", async () => {
    expect(await loadRepositoryCustomizations()).toBeUndefined();
    expect(
      await loadRepositoryCustomizations(
        join(tmpdir(), "missing-reviewphin-workspace"),
      ),
    ).toBeUndefined();
  });
  it("registers native directories and reads the dedicated AGENTS without changing shared instructions", async () => {
    const root = await fixture();
    await writeFile(join(root, "AGENTS.md"), "Shared rules");
    await writeFile(join(root, ".reviewphin/AGENTS.md"), "Swimmingly yours");
    await writeFile(
      join(root, ".reviewphin/paths.instructions.md"),
      '---\napplyTo: "**/*.ts"\n---\nCheck types',
    );
    await writeFile(
      join(root, ".reviewphin/skills/security/SKILL.md"),
      "Security guidance",
    );
    await writeFile(
      join(root, ".reviewphin/skills/security/references/checklist.md"),
      "Check permissions",
    );
    const result = await loadRepositoryCustomizations(root);
    expect(result?.instructions).toBe("Swimmingly yours");
    expect(result?.instructionDirectories).toEqual([join(root, ".reviewphin")]);
    expect(result?.skillDirectories).toEqual([
      join(root, ".reviewphin/skills"),
    ]);
    expect(result?.files.map((file) => file.path)).toEqual([
      ".reviewphin/AGENTS.md",
      ".reviewphin/paths.instructions.md",
      ".reviewphin/skills/security/SKILL.md",
      ".reviewphin/skills/security/references/checklist.md",
    ]);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
      "Shared rules",
    );
  });
  it("does not enable skill loading for an empty skills directory", async () => {
    const result = await loadRepositoryCustomizations(await fixture());
    expect(result?.skillDirectories).toEqual([]);
  });
  it("rejects linked directories before exposing them to the SDK", async () => {
    const root = await fixture();
    const outside = await fixture();
    await symlink(outside, join(root, ".reviewphin/linked"), "junction");
    await expect(loadRepositoryCustomizations(root)).rejects.toThrow(
      "Symbolic links",
    );
  });
  it("rejects oversized and malformed text", async () => {
    const root = await fixture();
    await writeFile(
      join(root, ".reviewphin/AGENTS.md"),
      Buffer.alloc(MAX_CUSTOMIZATION_FILE_BYTES + 1),
    );
    await expect(loadRepositoryCustomizations(root)).rejects.toThrow(
      "size limit",
    );
    await writeFile(join(root, ".reviewphin/AGENTS.md"), Buffer.from([0xff]));
    await expect(loadRepositoryCustomizations(root)).rejects.toThrow();
  });
});
