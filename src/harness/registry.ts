import { defineTool } from "@github/copilot-sdk";

import type { ProjectMemoryService } from "../memory/service.js";
import { projectMemoryToolInputSchema } from "../memory/types.js";
import { renderPrompt } from "../prompts/instruction-renderer.js";
import type { HarnessSubagentId, HarnessToolId } from "./types.js";

export interface ResolvedHarnessTools {
  registeredTools: ReturnType<typeof defineTool>[];
  availableTools: string[];
  enabledToolIds: HarnessToolId[];
}

interface HarnessRegistryContext {
  memoryService?: ProjectMemoryService | null | undefined;
}

const READ_ONLY_TOOL_IDS: HarnessToolId[] = ["glob", "rg", "view"];

export function resolveHarnessTools(
  toolIds: HarnessToolId[],
  context: HarnessRegistryContext,
): ResolvedHarnessTools {
  const selectedToolIds = dedupePreservingOrder(toolIds);
  const registeredTools: ReturnType<typeof defineTool>[] = [];
  const availableTools: string[] = [];
  const enabledToolIds: HarnessToolId[] = [];

  for (const toolId of selectedToolIds) {
    if (READ_ONLY_TOOL_IDS.includes(toolId)) {
      availableTools.push(toolId);
      enabledToolIds.push(toolId);
      continue;
    }

    if (toolId !== "add_memory_entry" || !context.memoryService) {
      continue;
    }

    registeredTools.push(
      defineTool("add_memory_entry", {
        description:
          "Persist durable project knowledge into the selected ReviewPhin project memory backend",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["memory", "rationale"],
          properties: {
            memory: {
              type: "string",
              description:
                "One durable project fact, preference, convention, or team policy to remember",
            },
            rationale: {
              type: "string",
              description:
                "Why this is long-term useful project memory instead of a one-off review detail",
            },
            supersedes: {
              type: "array",
              items: {
                type: "string",
              },
              description:
                "Existing memory entries that should be replaced by the new memory",
            },
          },
        },
        handler: async (args) => {
          const memoryService = context.memoryService;
          if (!memoryService) {
            throw new Error("Project memory service was not configured");
          }
          const input = projectMemoryToolInputSchema.parse(args);
          const result = await memoryService.addEntry(input);

          return result.changed
            ? `Project memory ${result.action}; it now contains ${result.memory.entries.length} entr${result.memory.entries.length === 1 ? "y" : "ies"}.`
            : "Project memory already contained that knowledge, so no wiki update was needed.";
        },
      }),
    );
    availableTools.push("add_memory_entry");
    enabledToolIds.push("add_memory_entry");
  }

  return {
    registeredTools,
    availableTools,
    enabledToolIds,
  };
}

export function resolveHarnessSubagents(
  subagentIds: HarnessSubagentId[],
  enabledToolIds: HarnessToolId[],
): Array<{
  name: HarnessSubagentId;
  displayName: string;
  description: string;
  tools: string[];
  prompt: string;
  infer: true;
}> {
  const enabledToolSet = new Set(enabledToolIds);

  return dedupePreservingOrder(subagentIds).map((subagentId) => {
    const definition = subagentRegistry[subagentId];
    return {
      name: subagentId,
      displayName: definition.displayName,
      description: definition.description,
      tools: definition.toolIds.filter((toolId) => enabledToolSet.has(toolId)),
      prompt: renderPrompt(definition.promptTemplateId, {}),
      infer: true as const,
    };
  });
}

const subagentRegistry: Record<
  HarnessSubagentId,
  {
    displayName: string;
    description: string;
    toolIds: HarnessToolId[];
    promptTemplateId: "subagent.context-analyst" | "subagent.review-author";
  }
> = {
  "context-analyst": {
    displayName: "Context Analyst",
    description: "Gathers evidence from diffs, instructions, and nearby code",
    toolIds: READ_ONLY_TOOL_IDS,
    promptTemplateId: "subagent.context-analyst",
  },
  "review-author": {
    displayName: "Review Author",
    description:
      "Produces platform-ready review findings and discussion dispositions",
    toolIds: READ_ONLY_TOOL_IDS,
    promptTemplateId: "subagent.review-author",
  },
};

function dedupePreservingOrder<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
