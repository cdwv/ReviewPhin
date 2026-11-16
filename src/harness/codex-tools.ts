import { spawn } from "node:child_process";
import { glob } from "glob";
import { z } from "zod";
import { executeGitReadonly, gitReadonlyParameters } from "./git-readonly.js";
import { readWorkspaceFile } from "./codex-workspace.js";
import { projectMemoryToolInputSchema } from "../memory/types.js";
import type { ProjectMemoryService } from "../memory/service.js";
import type { HarnessRunSpec } from "./types.js";

const pathInput = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
});
const globInput = z.object({ pattern: z.string().min(1).max(300) });
const searchInput = z.object({
  query: z.string().min(1).max(300),
  pattern: z.string().max(300).optional(),
});
const memorySchema = {
  type: "object",
  properties: {
    memory: { type: "string" },
    rationale: { type: "string" },
    supersedes: { type: "array", items: { type: "string" } },
  },
  required: ["memory", "rationale"],
  additionalProperties: false,
};

export function createCodexTools(
  spec: HarnessRunSpec,
  memory: Pick<ProjectMemoryService, "addEntry"> | null,
) {
  const tools: {
    type: "function";
    name: string;
    description: string;
    inputSchema: object;
  }[] = [];
  const handlers = new Map<string, (args: unknown) => Promise<string>>();
  const add = (
    name: string,
    description: string,
    schema: object,
    handler: (args: unknown) => Promise<string>,
  ) => {
    tools.push({ type: "function", name, description, inputSchema: schema });
    handlers.set(name, handler);
  };
  const root = spec.workingDirectory;
  if (root && spec.tools.includes("view"))
    add(
      "view",
      "Read a file in the review workspace",
      {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", minimum: 0 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async (args) => {
        const input = pathInput.parse(args);
        return readWorkspaceFile(root, input.path, input.offset);
      },
    );
  if (root && spec.tools.includes("glob"))
    add(
      "glob",
      "List repository files matching a glob pattern",
      {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
        additionalProperties: false,
      },
      async (args) => {
        const { pattern } = globInput.parse(args);
        if (pattern.startsWith("/") || pattern.split("/").includes(".."))
          throw new Error("Invalid pattern");
        const files = await glob(pattern, {
          cwd: root,
          nodir: true,
          follow: false,
          ignore: [".git/**"],
          maxDepth: 30,
        });
        const result = files.slice(0, 500).join("\n");
        return files.length > 500
          ? `${result}\n[File list truncated; narrow the glob pattern.]`
          : result;
      },
    );
  if (root && spec.tools.includes("rg"))
    add(
      "rg",
      "Search repository files with a regular expression",
      {
        type: "object",
        properties: { query: { type: "string" }, pattern: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      async (args) => {
        const { query, pattern = "**/*" } = searchInput.parse(args);
        if (pattern.startsWith("/") || pattern.split("/").includes(".."))
          throw new Error("Invalid pattern");
        return runSearch(root, query, pattern);
      },
    );
  if (spec.gitReadonly && spec.tools.includes("git_readonly")) {
    const context = spec.gitReadonly;
    add(
      "git_readonly",
      "Inspect the trusted review revisions with read-only Git operations",
      gitReadonlyParameters,
      async (args) => executeGitReadonly(args, context),
    );
  }
  if (memory && spec.tools.includes("add_memory_entry"))
    add(
      "add_memory_entry",
      "Persist durable project knowledge",
      memorySchema,
      async (args) => {
        const result = await memory.addEntry(
          projectMemoryToolInputSchema.parse(args),
        );
        return result.changed
          ? `Project memory ${result.action}.`
          : "Project memory already contained that knowledge.";
      },
    );
  return {
    tools,
    call: async (name: string, args: unknown) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Tool ${name} is unavailable`);
      return handler(args);
    },
  };
}

async function runSearch(
  root: string,
  query: string,
  pattern: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "rg",
      [
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--hidden",
        "--glob",
        "!.git/**",
        "--glob",
        pattern,
        "--",
        query,
        ".",
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Search timed out"));
    }, 15000);
    child.stdout.on("data", (chunk: Buffer) => {
      const available = Math.max(0, 100000 - bytes);
      chunks.push(chunk.subarray(0, available));
      bytes += chunk.length;
      if (bytes > 100000) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString().slice(0, 2000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!truncated && code !== 0 && code !== 1) {
        reject(new Error(`Search failed: ${stderr.slice(0, 2000)}`));
        return;
      }
      resolve(
        Buffer.concat(chunks).toString("utf8") +
          (truncated ? "\n[Search output truncated; narrow the search.]" : ""),
      );
    });
  });
}
