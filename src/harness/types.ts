import type {
  AssistantMessageEvent,
  MessageOptions,
  ProviderConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import type { ZodIssue, ZodType } from "zod";
import type { ProjectMemoryBackend } from "../memory/backend.js";
import type { ModelReasoningEffort } from "../storage/contract/index.js";

export type HarnessSelectionSource =
  | "code-review-override"
  | "tenant"
  | "default"
  | "fallback";
export type HarnessProviderType = "openai" | "azure" | "anthropic" | null;
export type HarnessToolId = "glob" | "rg" | "view" | "add_memory_entry";
export type HarnessSubagentId = "context-analyst" | "review-author";
export type HarnessRunAttachment = NonNullable<
  MessageOptions["attachments"]
>[number];
export type HarnessRunAttachments = NonNullable<MessageOptions["attachments"]>;

export interface HarnessModelConfig {
  modelProfileName: string | null;
  selectionSource: HarnessSelectionSource;
  reviewModel: string | null;
  textGenerationModel: string | null;
  reviewReasoningEffort: ModelReasoningEffort | null;
  textGenerationReasoningEffort: ModelReasoningEffort | null;
  authToken: string | null;
  provider: ProviderConfig | undefined;
  providerBaseUrl: string | null;
  providerType: HarnessProviderType;
}

export interface HarnessTenantContext {
  id: string;
  memoryEnabled: boolean;
  projectMemoryBackend: ProjectMemoryBackend;
}

export interface HarnessRunLoggingContext {
  interactionRunId: string | null;
  interactionJobId: string | null;
  tenantId: string | null;
  parentInteractionRunId?: string | null | undefined;
  runDirectory?: string | undefined;
  pathSegments?: string[] | undefined;
  sessionKind?: string | null | undefined;
}

export interface HarnessRunMetadata {
  codeReviewId?: number | null | undefined;
  workspacePath?: string | null | undefined;
}

export interface HarnessResponseFormat<TParsed = unknown> {
  schema: ZodType<TParsed>;
  looksLike?: ((value: Record<string, unknown>) => boolean) | undefined;
}

export interface HarnessRunParseError {
  reason: "no-json" | "schema-mismatch";
  message: string;
  zodIssues?: ZodIssue[] | undefined;
}

export interface HarnessRunSpec<TParsed = unknown> {
  prompt: string;
  attachments?: HarnessRunAttachments | undefined;
  modelConfig: HarnessModelConfig;
  model?: string | undefined;
  reasoningEffort?: ModelReasoningEffort | undefined;
  workingDirectory?: string | undefined;
  tenant?: HarnessTenantContext | undefined;
  tools: HarnessToolId[];
  subagents: HarnessSubagentId[];
  agent?: HarnessSubagentId | undefined;
  logging?: HarnessRunLoggingContext | undefined;
  metadata?: HarnessRunMetadata | undefined;
  timeoutMs?: number | undefined;
  responseFormat?: HarnessResponseFormat<TParsed> | undefined;
}

export interface HarnessRunResult<TParsed = unknown> {
  response: AssistantMessageEvent | undefined;
  events: SessionEvent[];
  parsed?: TParsed | undefined;
  parseError?: HarnessRunParseError | undefined;
}
