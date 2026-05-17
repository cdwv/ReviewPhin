import type { Logger } from "pino";

import { generateCtdFromFieldsDescriptor } from "../flotiq-ctd-builder.js";

export const CTDS = [
  generateCtdFromFieldsDescriptor("model_profile", "Config/Model Profile", {
    name: { type: "string", label: "Name", required: true },
    providerBaseUrl: {
      type: "string",
      label: "Provider Base URL",
      required: false,
    },
    providerType: {
      type: "string",
      label: "Provider Type",
      required: false,
      allowedValues: ["openai", "azure", "anthropic"],
      default: "openai",
    },
    authToken: {
      type: "string",
      label: "Auth Token",
      required: false,
      isPassword: true,
    },
    reviewModel: { type: "string", label: "Review Model", required: false },
    textGenerationModel: {
      type: "string",
      label: "Text Generation Model",
      required: false,
    },
    wireApi: {
      type: "string",
      label: "Wire API",
      required: false,
      allowedValues: ["completions", "responses"],
      default: "responses",
    },
    isDefault: { type: "boolean", label: "Is Default", required: true },
  }),
  generateCtdFromFieldsDescriptor("tenant", "Config/Tenant", {
    key: {
      type: "string",
      label: "Key",
      required: true,
      helpText:
        "Unique key to identify the tenant, usually {baseUrl}::{projectId}",
    },
    baseUrl: { type: "string", label: "Base URL", required: true },
    projectId: { type: "number", label: "Project ID", required: true },
    apiToken: {
      type: "string",
      label: "API Token",
      required: true,
      isPassword: true,
    },
    webhookSecret: {
      type: "string",
      label: "Webhook Secret",
      required: true,
      isPassword: true,
    },
    botUserId: { type: "number", label: "Bot User ID", required: true },
    botUsername: { type: "string", label: "Bot Username", required: true },
    modelProfileName: {
      type: "datasource",
      label: "Model Profile Name",
      required: false,
      relationContentType: "model_profile",
    },
  }),
  generateCtdFromFieldsDescriptor(
    "interaction_job",
    "Run History/Interaction Job",
    {
      tenantId: {
        type: "datasource",
        label: "Tenant ID",
        required: true,
        relationContentType: "tenant",
      },
      dedupeKey: { type: "string", label: "Dedupe Key", required: true },
      projectId: { type: "number", label: "Project ID", required: true },
      mergeRequestIid: {
        type: "number",
        label: "Merge Request IID",
        required: true,
      },
      noteId: { type: "number", label: "Note ID", required: true },
      headSha: { type: "string", label: "Head SHA", required: true },
      status: { type: "string", label: "Status", required: true },
      payloadJson: {
        type: "string",
        label: "Payload JSON",
        required: true,
        inputType: "textarea",
      },
      retryCount: { type: "number", label: "Retry Count", required: true },
      lastError: { type: "string", label: "Last Error", required: false },
      enqueuedAt: { type: "string", label: "Enqueued At", required: true },
      startedAt: { type: "string", label: "Started At", required: false },
      finishedAt: { type: "string", label: "Finished At", required: false },
    },
  ),
  generateCtdFromFieldsDescriptor(
    "interaction_run",
    "Run History/Interaction Run",
    {
      interactionJobId: {
        type: "datasource",
        label: "Interaction Job ID",
        required: true,
        relationContentType: "interaction_job",
      },
      tenantId: {
        type: "datasource",
        label: "Tenant ID",
        required: true,
        relationContentType: "tenant",
      },
      provider: { type: "string", label: "Provider", required: true },
      model: { type: "string", label: "Model", required: false },
      modelProfileName: {
        type: "datasource",
        label: "Model Profile Name",
        required: false,
        relationContentType: "model_profile",
      },
      providerBaseUrl: {
        type: "string",
        label: "Provider Base URL",
        required: false,
      },
      providerType: {
        type: "string",
        label: "Provider Type",
        required: false,
      },
      textGenerationModel: {
        type: "string",
        label: "Text Generation Model",
        required: false,
      },
      status: { type: "string", label: "Status", required: true },
      resultJson: {
        type: "string",
        label: "Result JSON",
        required: false,
        inputType: "textarea",
      },
      error: { type: "string", label: "Error", required: false },
      startedAt: { type: "string", label: "Started At", required: true },
      finishedAt: { type: "string", label: "Finished At", required: false },
    },
  ),
  generateCtdFromFieldsDescriptor(
    "review_finding",
    "Code Review/Review Finding",
    {
      interactionRunId: {
        type: "datasource",
        label: "Interaction Run ID",
        required: true,
        relationContentType: "interaction_run",
      },
      identityKey: { type: "string", label: "Identity Key", required: true },
      severity: { type: "string", label: "Severity", required: true },
      category: { type: "string", label: "Category", required: true },
      title: { type: "string", label: "Title", required: true },
      body: {
        type: "string",
        label: "Body",
        required: true,
        inputType: "textMarkdown",
      },
      anchorJson: {
        type: "string",
        label: "Anchor JSON",
        required: false,
        inputType: "textarea",
      },
      suggestionJson: {
        type: "string",
        label: "Suggestion JSON",
        required: false,
        inputType: "textarea",
      },
      status: { type: "string", label: "Status", required: true },
    },
  ),
  generateCtdFromFieldsDescriptor(
    "discussion_mapping",
    "Code Review/Discussion Mapping",
    {
      tenantId: {
        type: "datasource",
        label: "Tenant ID",
        required: true,
        relationContentType: "tenant",
      },
      projectId: { type: "number", label: "Project ID", required: true },
      mergeRequestIid: {
        type: "number",
        label: "Merge Request IID",
        required: true,
      },
      identityKey: { type: "string", label: "Identity Key", required: true },
      findingFingerprint: {
        type: "string",
        label: "Finding Fingerprint",
        required: true,
      },
      title: { type: "string", label: "Title", required: true },
      severity: { type: "string", label: "Severity", required: true },
      category: { type: "string", label: "Category", required: true },
      body: {
        type: "string",
        label: "Body",
        required: true,
        inputType: "textMarkdown",
      },
      gitlabDiscussionId: {
        type: "string",
        label: "GitLab Discussion ID",
        required: true,
      },
      gitlabNoteId: { type: "number", label: "GitLab Note ID", required: true },
      anchorJson: {
        type: "string",
        label: "Anchor JSON",
        required: false,
        inputType: "textarea",
      },
      positionJson: {
        type: "string",
        label: "Position JSON",
        required: false,
        inputType: "textarea",
      },
      botDiscussion: {
        type: "boolean",
        label: "Bot Discussion",
        required: true,
      },
      botNote: { type: "boolean", label: "Bot Note", required: true },
      noteAuthorId: {
        type: "number",
        label: "Note Author ID",
        required: false,
      },
      noteAuthorUsername: {
        type: "string",
        label: "Note Author Username",
        required: false,
      },
      status: { type: "string", label: "Status", required: true },
      lastInteractionRunId: {
        type: "datasource",
        label: "Last Interaction Run ID",
        required: false,
        relationContentType: "interaction_run",
      },
    },
  ),
  generateCtdFromFieldsDescriptor(
    "merge_request_snapshot",
    "Code Review/Merge Request Snapshot",
    {
      interactionJobId: {
        type: "datasource",
        label: "Interaction Job ID",
        required: true,
        relationContentType: "interaction_job",
      },
      tenantId: {
        type: "datasource",
        label: "Tenant ID",
        required: true,
        relationContentType: "tenant",
      },
      mergeRequestIid: {
        type: "number",
        label: "Merge Request IID",
        required: true,
      },
      headSha: { type: "string", label: "Head SHA", required: true },
      mergeRequestJson: {
        type: "string",
        label: "Merge Request JSON",
        required: true,
        inputType: "textarea",
      },
      versionsJson: {
        type: "string",
        label: "Versions JSON",
        required: true,
        inputType: "textarea",
      },
      changesJson: {
        type: "string",
        label: "Changes JSON",
        required: true,
        inputType: "textarea",
      },
      notesJson: {
        type: "string",
        label: "Notes JSON",
        required: true,
        inputType: "textarea",
      },
      discussionsJson: {
        type: "string",
        label: "Discussions JSON",
        required: true,
        inputType: "textarea",
      },
      instructionsJson: {
        type: "string",
        label: "Instructions JSON",
        required: true,
        inputType: "textarea",
      },
      projectMemoryJson: {
        type: "string",
        label: "Project Memory JSON",
        required: false,
        inputType: "textarea",
      },
      workspaceStrategy: {
        type: "string",
        label: "Workspace Strategy",
        required: true,
      },
    },
  ),
  generateCtdFromFieldsDescriptor(
    "interaction_run_metrics",
    "Run History/Interaction Run Metrics",
    {
      interactionRunId: {
        type: "datasource",
        label: "Interaction Run ID",
        required: true,
        relationContentType: "interaction_run",
      },
      triggerKind: {
        type: "string",
        label: "Trigger Kind",
        required: false,
      },
      promptMode: {
        type: "string",
        label: "Prompt Mode",
        required: false,
      },
      promptChars: {
        type: "number",
        label: "Prompt Chars",
        required: true,
      },
      promptContextChangedFiles: {
        type: "number",
        label: "Prompt Context Changed Files",
        required: true,
      },
      promptContextPriorThreads: {
        type: "number",
        label: "Prompt Context Prior Threads",
        required: true,
      },
      promptContextNotes: {
        type: "number",
        label: "Prompt Context Notes",
        required: true,
      },
      assistantTurns: {
        type: "number",
        label: "Assistant Turns",
        required: true,
      },
      assistantCalls: {
        type: "number",
        label: "Assistant Calls",
        required: true,
      },
      toolExecutions: {
        type: "number",
        label: "Tool Executions",
        required: true,
      },
      viewToolCalls: {
        type: "number",
        label: "View Tool Calls",
        required: true,
      },
      globToolCalls: {
        type: "number",
        label: "Glob Tool Calls",
        required: true,
      },
      inputTokens: {
        type: "number",
        label: "Input Tokens",
        required: true,
      },
      outputTokens: {
        type: "number",
        label: "Output Tokens",
        required: true,
      },
      cacheReadTokens: {
        type: "number",
        label: "Cache Read Tokens",
        required: true,
      },
      cacheWriteTokens: {
        type: "number",
        label: "Cache Write Tokens",
        required: true,
      },
      reasoningTokens: {
        type: "number",
        label: "Reasoning Tokens",
        required: true,
      },
      apiDurationMs: {
        type: "number",
        label: "API Duration Ms",
        required: true,
      },
      premiumRequests: {
        type: "number",
        label: "Premium Requests",
        required: true,
      },
      repeatedViewReads: {
        type: "number",
        label: "Repeated View Reads",
        required: true,
      },
      repeatedViewPathsJson: {
        type: "string",
        label: "Repeated View Paths JSON",
        required: true,
        inputType: "textarea",
      },
    },
  ),

  generateCtdFromFieldsDescriptor("migrations", "Config/Migrations History", {
    name: { type: "string", label: "Name", required: true, unique: true },
  }),
];

type Unpacked<T> = T extends (infer U)[] ? U : T;
type CtdDefinition = Unpacked<typeof CTDS>;

export async function ensureCTDsExist(apiKey: string, logger?: Logger) {
  const flotiqApiKey = apiKey;
  if (!flotiqApiKey) {
    logger?.warn(
      "FLOTIQ_API_KEY is not set. Skipping CTD creation. Please set FLOTIQ_API_KEY to ensure CTDs are created.",
    );
    throw new Error(
      "FLOTIQ_API_KEY is not set. Cannot ensure CTDs exist without API key.",
    );
  }

  for (const ctd of CTDS) {
    await ensureCtdExists(ctd, flotiqApiKey, logger);
  }
}

async function ensureCtdExists(
  ctd: CtdDefinition,
  apiKey: string,
  logger?: Logger,
): Promise<void> {
  logger?.info({ ctdName: ctd.name }, "Ensuring Flotiq CTD exists.");
  const existingCtd = await fetchExistingCtd(ctd.name, apiKey, logger);

  if (!existingCtd) {
    await createCtd(ctd, apiKey, logger);
    return;
  }

  logger?.info({ ctdName: ctd.name }, "Flotiq CTD already exists.");
  if (!ctdNeedsUpdate(existingCtd, ctd)) {
    return;
  }

  logger?.warn(
    { ctdName: ctd.name },
    "Existing Flotiq CTD differs from desired schema. Please review and update it if necessary.",
  );
  await updateCtd(existingCtd.name, ctd, apiKey, logger);
}

async function fetchExistingCtd(
  name: string,
  apiKey: string,
  logger?: Logger,
): Promise<(CtdDefinition & { id: string }) | null> {
  const existsRequest = await fetch(
    `https://api.flotiq.com/api/v1/internal/contenttype/${name}`,
    {
      method: "GET",
      headers: createFlotiqHeaders(apiKey),
    },
  );

  if (existsRequest.status === 404) {
    return null;
  }

  if (!existsRequest.ok) {
    await throwRequestError(`fetch CTD for ${name}`, existsRequest, logger);
  }

  return (await existsRequest.json()) as CtdDefinition & { id: string };
}

function ctdNeedsUpdate(
  existingCtd: CtdDefinition & { id: string },
  desiredCtd: CtdDefinition,
): boolean {
  return (
    JSON.stringify(existingCtd.schemaDefinition) !==
      JSON.stringify(desiredCtd.schemaDefinition) ||
    JSON.stringify(existingCtd.metaDefinition) !==
      JSON.stringify(desiredCtd.metaDefinition) ||
    existingCtd.label !== desiredCtd.label ||
    existingCtd.name !== desiredCtd.name
  );
}

async function updateCtd(
  name: string,
  ctd: CtdDefinition,
  apiKey: string,
  logger?: Logger,
): Promise<void> {
  const updateRequest = await fetch(
    `https://api.flotiq.com/api/v1/internal/contenttype/${name}`,
    {
      method: "PUT",
      headers: createFlotiqHeaders(apiKey),
      body: JSON.stringify(ctd),
    },
  );

  if (updateRequest.status === 200) {
    logger?.info({ ctdName: ctd.name }, "Flotiq CTD updated.");
    return;
  }

  await throwRequestError(`update CTD for ${ctd.name}`, updateRequest, logger);
}

async function createCtd(
  ctd: CtdDefinition,
  apiKey: string,
  logger?: Logger,
): Promise<void> {
  logger?.info({ ctdName: ctd.name }, "Creating Flotiq CTD.");
  const createRequest = await fetch(
    `https://api.flotiq.com/api/v1/internal/contenttype`,
    {
      method: "POST",
      headers: createFlotiqHeaders(apiKey),
      body: JSON.stringify(ctd),
    },
  );

  if (createRequest.ok) {
    logger?.info({ ctdName: ctd.name }, "Flotiq CTD created.");
    return;
  }

  await throwRequestError(`create CTD for ${ctd.name}`, createRequest, logger);
}

function createFlotiqHeaders(apiKey: string): HeadersInit {
  return {
    "X-Auth-Token": apiKey,
    "Content-Type": "application/json",
  };
}

async function throwRequestError(
  action: string,
  request: Response,
  logger?: Logger,
): Promise<never> {
  const responseText = await request.text();
  logger?.error(
    { action, responseText, status: request.status },
    `Failed to ${action}.`,
  );
  throw new Error(`Failed to ${action}. Status: ${request.status}`);
}

export default ensureCTDsExist;
