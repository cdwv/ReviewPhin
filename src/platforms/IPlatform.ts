import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { ZodObject, ZodRawShape } from "zod";

import type {
  HarnessRunAttachments,
  HarnessRunLoggingContext,
  HarnessTenantContext,
} from "../harness/types.js";
import type { InteractionRunArtifacts } from "../review/run-artifacts.js";
import type {
  ChatterBatchResult,
  ProviderDiscussionContext,
  ResponseTarget,
  ReviewContext,
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
import type { PlatformReviewDiscussionAdapter } from "./review-adapter.js";

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
}

export interface PlatformMaterializedWorkspace {
  rootPath: string;
  cleanupRoot: string;
  strategy: string;
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

export type PlatformHydratedReviewContext = PlatformReviewRoutingContext;

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
    payload: unknown;
    context: PlatformReviewRoutingContext;
    priorDiscussions: ProviderDiscussionContext[];
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
  createReviewDiscussionAdapter(input: {
    context: PlatformReviewRoutingContext;
    interactionRunId: string;
  }): PlatformReviewDiscussionAdapter;
  resolveTriggerCommentReference(input: {
    codeReviewId: number;
    commentId: number;
  }): Promise<TriggerCommentReference>;
  ensureTriggerCommentReaction(input: {
    codeReviewId: number;
    comment: TriggerCommentReference;
    reactionName: string;
    interactionJobId: string;
  }): Promise<void>;
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
  }): Promise<
    Array<{
      target: ResponseTarget;
      status: "published" | "failed";
      commentId?: number | undefined;
      error?: string | undefined;
    }>
  >;
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
  parseWebhookPayload(payload: unknown): unknown;
  identifyTenantKey(
    payload: unknown,
    req?: PlatformWebhookRequest,
  ): Promise<string | null> | string | null;
  isWebhookRequestAuthorized(
    resolvedTenant: ResolvedTenant,
    req: PlatformWebhookRequest,
  ): boolean | Promise<boolean>;
  classifyWebhookTrigger(
    resolvedTenant: ResolvedTenant,
    payload: unknown,
  ): WebhookReviewTrigger | Promise<WebhookReviewTrigger | null> | null;
  createInteractionJob(input: {
    resolvedTenant: ResolvedTenant;
    payload: unknown;
  }): Promise<{
    dedupeKey: string;
    codeReviewId: number;
    commentId: number;
    headSha: string;
    payloadJson: string;
  }>;
  createReviewRuntime(input: {
    storage: StorageHelpers;
    logger: Logger;
    resolvedTenant?: ResolvedTenant;
    tenant?: TenantRecord;
    connection?: PlatformConnectionRecord;
    interactionJobId: string;
    workspaceRoot: string;
    memoryEnabled: boolean;
    interactionRunId?: string | undefined;
    runArtifacts?: InteractionRunArtifacts | undefined;
  }): PlatformReviewRuntime;
  buildHarnessTenantContext(input: {
    resolvedTenant: ResolvedTenant;
    logger: Logger;
    memoryEnabled: boolean;
    logging?: HarnessRunLoggingContext | undefined;
  }): HarnessTenantContext;
  getReviewSummaryInstructions(resolvedTenant: ResolvedTenant): string[];
  getTenantRegistrationSchema(): ZodObject<ZodRawShape>;
  getConnectionRegistrationSchema(): ZodObject<ZodRawShape>;
  onBeforeAddConnection?(
    connectionConfig: Record<string, unknown>,
  ): PlatformConnectionStatus | Promise<PlatformConnectionStatus>;
  onBeforeUpdateConnection?(
    connection: PlatformConnectionRecord,
    connectionConfig: Record<string, unknown>,
  ): PlatformConnectionStatus | Promise<PlatformConnectionStatus>;
  onBeforeAddTenant?(
    tenantConfig: Record<string, unknown>,
    connection: PlatformConnectionRecord,
  ): void | Promise<void>;
}
