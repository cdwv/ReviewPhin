import type {
  AssistantMessageEvent,
  ProviderConfig,
  SessionEvent,
} from "@github/copilot-sdk";

export type HarnessSelectionSource =
  | "merge-request-override"
  | "tenant"
  | "default"
  | "fallback";
export type HarnessProviderType = "openai" | "azure" | "anthropic" | null;
export type HarnessToolId = "glob" | "rg" | "view" | "add_memory_entry";
export type HarnessSubagentId = "context-analyst" | "review-author";

export interface HarnessModelConfig {
  modelProfileName: string | null;
  selectionSource: HarnessSelectionSource;
  reviewModel: string | null;
  textGenerationModel: string | null;
  authToken: string | null;
  provider: ProviderConfig | undefined;
  providerBaseUrl: string | null;
  providerType: HarnessProviderType;
}

export interface HarnessTenantContext {
  id: string;
  baseUrl: string;
  projectId: number;
  apiToken: string;
  memoryEnabled: boolean;
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
  mergeRequestIid?: number | null | undefined;
  workspacePath?: string | null | undefined;
}

export interface HarnessRunSpec {
  prompt: string;
  modelConfig: HarnessModelConfig;
  model?: string | undefined;
  workingDirectory?: string | undefined;
  tenant?: HarnessTenantContext | undefined;
  tools: HarnessToolId[];
  subagents: HarnessSubagentId[];
  agent?: HarnessSubagentId | undefined;
  logging?: HarnessRunLoggingContext | undefined;
  metadata?: HarnessRunMetadata | undefined;
  timeoutMs?: number | undefined;
}

export interface HarnessRunResult {
  response: AssistantMessageEvent | undefined;
  events: SessionEvent[];
}
