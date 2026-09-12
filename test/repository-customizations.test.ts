import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadRepositoryCustomizations } from "../src/harness/repository-customizations.js";

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
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
      "Shared rules",
    );
  });
  it("leaves skill discovery to Copilot even when the directory is empty", async () => {
    const root = await fixture();
    const result = await loadRepositoryCustomizations(root);
    expect(result?.skillDirectories).toEqual([
      join(root, ".reviewphin/skills"),
    ]);
    expect(result?.instructions).toBeUndefined();
  });
  it("registers modular instructions without requiring AGENTS.md or skills", async () => {
    const root = await fixture();
    await rm(join(root, ".reviewphin/skills"), { recursive: true });
    await writeFile(
      join(root, ".reviewphin/review.instructions.md"),
      "Review guidance",
    );
    expect(await loadRepositoryCustomizations(root)).toEqual({
      instructionDirectories: [join(root, ".reviewphin")],
      skillDirectories: [],
    });
  });
  it("does not decode or validate skill reference assets", async () => {
    const root = await fixture();
    await writeFile(join(root, ".reviewphin/AGENTS.md"), "Review guidance");
    await writeFile(
      join(root, ".reviewphin/skills/security/references/data.bin"),
      Buffer.from([0xff, 0x00]),
    );
    expect((await loadRepositoryCustomizations(root))?.instructions).toBe(
      "Review guidance",
    );
  });
});
