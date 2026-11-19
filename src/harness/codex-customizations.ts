import { glob } from "glob";
import { readWorkspaceFile } from "./codex-workspace.js";

/** Load repository-wide rules and advertise review skills to the agent. */
export async function loadCodexCustomizations(root: string): Promise<string> {
  const instructions = await glob(
    [
      ".reviewphin/**/*.instructions.md",
      ".github/copilot-instructions.md",
      ".github/instructions/**/*.instructions.md",
    ],
    {
      cwd: root,
      nodir: true,
      follow: false,
      dot: true,
    },
  );
  const skills = await glob(".reviewphin/skills/*/SKILL.md", {
    cwd: root,
    nodir: true,
    follow: false,
    dot: true,
  });
  const parts: string[] = [];
  for (const path of instructions.sort()) {
    const text = await readWorkspaceFile(root, path);
    parts.push(
      `Review instructions from ${path}; honor any applyTo scope in the frontmatter:\n${text}`,
    );
  }
  for (const path of skills.sort()) {
    const text = await readWorkspaceFile(root, path);
    const header = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (header)
      parts.push(
        `Available review skill (${path}). Read the file using view when relevant:\n${header[0]}`,
      );
  }
  return parts.join("\n\n");
}
