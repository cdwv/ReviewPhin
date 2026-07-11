import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { ZodObject, ZodRawShape } from "zod";

import type {
  HarnessRunAttachments,
  HarnessRunLoggingContext,
  HarnessTenantContext,
} from "../harness/types.js";
import type { ProjectMemoryBackend } from "../memory/backend.js";
import type { InteractionRunArtifacts } from "../review/run-artifacts.js";
import type {
  ChatterBatchResult,
  ProviderDiscussionContext,
  ResponseTarget,
  ReviewContext,
  ReviewResult,
  ReviewSummaryContext,
  ReviewTriggerContext,
  TriggerCommentReference,
  WebhookReviewTrigger,
} from "../review/types.js";
import type {
  DiscussionMappingRecord,
  InteractionJobRecord,
  PlatformConnectionRecord,
  PlatformConnectionStatus,
  PreviousCompletedInteractionRecord,
  TenantRecord,
} from "../storage/contract/current.js";
import type { StorageHelpers } from "../storage/storage-helpers.js";
import type { PlatformReviewPublicationAdapter } from "./review-adapter.js";
import type { ReconcileSummary } from "../reconcile/discussion-reconciler.js";

export interface PlatformWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody: Buffer;
  pathSuffix: string;
}

export interface ResolvedTenant {
  tenant: TenantRecord;
  connection: PlatformConnectionRecord;
}

export interface PlatformSetupContext {
  pathSuffix: string;
  rawBody: Buffer;
  storage?: StorageHelpers | undefined;
}

export interface PlatformMaterializedWorkspace {
  rootPath: string;
  cleanupRoot: string;
  strategy: string;
}

export interface PlatformConnectionLifecycleResult {
  status: PlatformConnectionStatus;
  notices?: readonly string[] | undefined;
}

export interface PlatformReviewRoutingContext {
  codeReviewId: number;
  summaryContext: ReviewSummaryContext;
  workspace: PlatformMaterializedWorkspace;
  projectMemory: ReviewContext["projectMemory"];
  changedFileCount: number;
  commentCount: number;
  discussionCount: number;
  platformContext: unknown;
}

export interface PlatformTriggerLifecycle {
  queued(): Promise<void>;
  inProgress(): Promise<void>;
  completed(outcome?: PlatformTriggerOutcome): Promise<void>;
  retry(error: string): Promise<void>;
  failed(error: string): Promise<void>;
}

export interface PlatformTriggerOutcome {
  summary: string;
  links?:
    | ReadonlyArray<{
        label: string;
        url: string;
      }>
    | undefined;
}

export type PlatformSetupHandler = (input: {
  request: FastifyRequest;
  reply: FastifyReply;
  context: PlatformSetupContext;
}) => Promise<void> | void;

export interface PlatformReviewRuntime {
  loadRoutingContext(
    job: InteractionJobRecord,
  ): Promise<PlatformReviewRoutingContext>;
  hydrate(input: {
    job: InteractionJobRecord;
    context?: PlatformReviewRoutingContext | undefined;
  }): Promise<PlatformReviewRoutingContext>;
  buildProviderDiscussions(input: {
    context: PlatformReviewRoutingContext;
    mappings: DiscussionMappingRecord[];
  }): ProviderDiscussionContext[];
  buildReviewTriggerContext(input: {
    job: InteractionJobRecord;
    payload: unknown;
    context: PlatformReviewRoutingContext;
    priorDiscussions: ProviderDiscussionContext[];
    mappings: DiscussionMappingRecord[];
  }): ReviewTriggerContext;
  locateTriggerCommentReference(input: {
    context: PlatformReviewRoutingContext;
    commentId: number;
  }): TriggerCommentReference;
  buildPromptContext(input: {
    attachments: ReviewContext["attachments"];
    attachmentIssues: ReviewContext["attachmentIssues"];
    interactionRunId: string;
    tenant: TenantRecord;
    job: InteractionJobRecord;
    runArtifacts: InteractionRunArtifacts;
    trigger: ReviewContext["trigger"];
    context: PlatformReviewRoutingContext;
    mappings: DiscussionMappingRecord[];
    priorFindings: Awaited<
      ReturnType<StorageHelpers["listPriorReviewFindings"]>
    >;
    previousInteraction: PreviousCompletedInteractionRecord | null;
  }): ReviewContext;
  syncDiscussionFindingStatuses(input: {
    tenant: TenantRecord;
    codeReviewId: number;
    context: PlatformReviewRoutingContext;
    mappings: DiscussionMappingRecord[];
  }): Promise<DiscussionMappingRecord[]>;
  createReviewPublicationAdapter(input: {
    context: PlatformReviewRoutingContext;
    interactionRunId: string;
  }): PlatformReviewPublicationAdapter;
  resolveTriggerCommentReference(input: {
    codeReviewId: number;
    commentId: number;
    triggerJson?: string | undefined;
  }): Promise<TriggerCommentReference>;
  materializeAttachments(input: {
    context: PlatformReviewRoutingContext;
    trigger: ReviewContext["trigger"];
    runArtifacts: InteractionRunArtifacts;
  }): Promise<{
    attachments: HarnessRunAttachments;
    breadcrumbs: ReviewContext["attachments"];
    issues: ReviewContext["attachmentIssues"];
  }>;
  publishChatterReplies(input: {
    codeReviewId: number;
    result: ChatterBatchResult;
    plannedTargets: ResponseTarget[];
    guard: {
      assertOwned(): void;
    };
  }): Promise<
    Array<{
      target: ResponseTarget;
      status: "published" | "failed";
      commentId?: number | undefined;
      error?: string | undefined;
    }>
  >;
  buildTriggerOutcome(input: {
    reviewResult: ReviewResult | null;
    reconcileSummary: ReconcileSummary | null;
  }): PlatformTriggerOutcome | undefined;
  cleanupWorkspace(workspace: PlatformMaterializedWorkspace): Promise<void>;
}

export interface IPlatform {
  getPlatformInfo(): {
    name: string;
    description: string;
    slug: string;
  };
  getSetupHandler?(): PlatformSetupHandler | null;
  getTenantKey(
    tenantConfig: Record<string, unknown>,
    connection: PlatformConnectionRecord,
  ): string;
  parseWebhookPayload(payload: unknown, req?: PlatformWebhookRequest): unknown;
  identifyTenantKey(
    payload: unknown,
    req?: PlatformWebhookRequest,
  ): Promise<string | null> | string | null;
  shouldIgnoreWebhookWithoutTenant?(
    payload: unknown,
    req: PlatformWebhookRequest,
  ): boolean | Promise<boolean>;
  isWebhookRequestAuthorized(
    resolvedTenant: ResolvedTenant,
    req: PlatformWebhookRequest,
  ): boolean | Promise<boolean>;
  handleWebhookEvent?(
    resolvedTenant: ResolvedTenant,
    payload: unknown,
  ): boolean | Promise<boolean>;
  classifyWebhookTrigger(
    resolvedTenant: ResolvedTenant,
    payload: unknown,
  ): WebhookReviewTrigger | Promise<WebhookReviewTrigger | null> | null;
  createInteractionJob(input: {
    resolvedTenant: ResolvedTenant;
    payload: unknown;
    trigger: WebhookReviewTrigger;
    storage: StorageHelpers;
  }): Promise<{
    dedupeKey: string;
    codeReviewId: number;
    commentId: number | null;
    triggerJson: string;
    headSha: string;
    payloadJson: string;
  }>;
  createTriggerLifecycle(input: {
    resolvedTenant: ResolvedTenant;
    job: InteractionJobRecord;
    logger: Logger;
  }): PlatformTriggerLifecycle;
  createReviewRuntime(input: {
    storage: StorageHelpers;
    logger: Logger;
    resolvedTenant?: ResolvedTenant;
    tenant?: TenantRecord;
    connection?: PlatformConnectionRecord;
    interactionJobId: string;
    workspaceAttemptId?: string | undefined;
    workspaceRoot: string;
    memoryEnabled: boolean;
    interactionRunId?: string | undefined;
    runArtifacts?: InteractionRunArtifacts | undefined;
  }): PlatformReviewRuntime;
  createProjectMemoryBackend(input: {
    resolvedTenant: ResolvedTenant;
    storage: StorageHelpers;
    logger: Logger;
    enabled: boolean;
    logging?: HarnessRunLoggingContext | undefined;
  }): ProjectMemoryBackend;
  buildHarnessTenantContext(input: {
    resolvedTenant: ResolvedTenant;
    storage: StorageHelpers;
    logger: Logger;
    memoryEnabled: boolean;
    logging?: HarnessRunLoggingContext | undefined;
  }): HarnessTenantContext;
  getReviewSummaryInstructions(resolvedTenant: ResolvedTenant): string[];
  getTenantRegistrationSchema(): ZodObject<ZodRawShape>;
  getConnectionRegistrationSchema(): ZodObject<ZodRawShape>;
  getConnectionSetupUrl?(
    connectionConfig: Record<string, unknown>,
  ): string | null;
  onBeforeAddConnection?(
    connectionConfig: Record<string, unknown>,
  ): PlatformConnectionStatus | Promise<PlatformConnectionStatus>;
  onBeforeUpdateConnection?(
    connection: PlatformConnectionRecord,
    connectionConfig: Record<string, unknown>,
  ): PlatformConnectionStatus | Promise<PlatformConnectionStatus>;
  onBeforeRecreateConnection?(
    connection: PlatformConnectionRecord,
    connectionConfig: Record<string, unknown>,
  ):
    | PlatformConnectionLifecycleResult
    | Promise<PlatformConnectionLifecycleResult>;
  onBeforeRemoveConnection?(
    connection: PlatformConnectionRecord,
  ): readonly string[] | Promise<readonly string[]>;
  onBeforeAddTenant?(
    tenantConfig: Record<string, unknown>,
    connection: PlatformConnectionRecord,
  ): void | Promise<void>;
}
