import { z } from "zod";
import type {
  HarnessModelConfig,
  HarnessRunLoggingContext,
  HarnessRunResult,
  HarnessRunSpec,
  HarnessTenantContext,
} from "../harness/types.js";
import { buildProjectMemoryCoalescePrompt } from "../prompts/prompt-builders.js";
import { createId } from "../utils/ids.js";
import type {
  ProjectMemoryCoalesceInput,
  ProjectMemoryEntry,
} from "./types.js";

interface ProjectMemoryConsolidatorOptions {
  runSession: <TParsed = unknown>(
    spec: HarnessRunSpec<TParsed>,
  ) => Promise<HarnessRunResult<TParsed>>;
}

export class ProjectMemoryConsolidator {
  private readonly runSession: ProjectMemoryConsolidatorOptions["runSession"];

  public constructor(options: ProjectMemoryConsolidatorOptions) {
    this.runSession = options.runSession;
  }

  public async coalesce(input: {
    modelConfig: HarnessModelConfig;
    tenant?: HarnessTenantContext | undefined;
    logging?: HarnessRunLoggingContext | undefined;
    coalesceInput: ProjectMemoryCoalesceInput;
  }): Promise<ProjectMemoryEntry[]> {
    if (input.coalesceInput.entries.length === 0) {
      return [];
    }

    const response = await this.runSession({
      prompt: buildProjectMemoryCoalescePrompt(input.coalesceInput),
      modelConfig: input.modelConfig,
      model: selectConsolidationModel(input.modelConfig),
      tenant: input.tenant,
      tools: [],
      subagents: [],
      logging: {
        interactionRunId: input.logging?.interactionRunId ?? null,
        interactionJobId: input.logging?.interactionJobId ?? null,
        tenantId: input.logging?.tenantId ?? input.tenant?.id ?? null,
        parentInteractionRunId:
          input.logging?.parentInteractionRunId ??
          input.logging?.interactionRunId ??
          null,
        runDirectory: input.logging?.runDirectory,
        pathSegments: [
          ...(input.logging?.pathSegments ?? ["copilot"]),
          "memory-consolidation",
          createId("session"),
        ],
        sessionKind: "memory-consolidation",
      },
      responseFormat: {
        schema: coalescedEntriesResponseSchema,
        looksLike: (value) => "entries" in value,
      },
    });

    return parseCoalescedEntries(
      response.parsed,
      response.response?.data.content,
      response.parseError?.message,
    );
  }
}

function selectConsolidationModel(
  input: HarnessModelConfig,
): string | undefined {
  return input.textGenerationModel ?? input.reviewModel ?? undefined;
}

function parseCoalescedEntries(
  payload: { entries: unknown[] } | undefined,
  content: string | undefined,
  parseErrorMessage: string | undefined,
): ProjectMemoryEntry[] {
  const trimmed = content?.trim();
  if (!trimmed) {
    throw new Error("Project memory consolidator returned no content");
  }

  if (!payload || !Array.isArray(payload.entries)) {
    throw new Error(
      parseErrorMessage ??
        "Project memory consolidator did not return an entries array",
    );
  }

  const entries = payload.entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((text) => ({ text }));

  if (entries.length === 0) {
    throw new Error("Project memory consolidator returned no usable entries");
  }

  return entries;
}

const coalescedEntriesResponseSchema = z.object({
  entries: z.array(z.unknown()),
});
