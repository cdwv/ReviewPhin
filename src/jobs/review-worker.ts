import {
  batchCheckpointSchema,
  replyPublicationMarker,
  type BatchCheckpoint,
} from "../review/batch-checkpoint.js";
import {
  type InteractionRouter,
  reduceRoutingDecisions,
  validateReplyCoverage,
  type InteractionRoutingResult,
} from "../review/interaction-router.js";
import type { Logger } from "pino";
import { join } from "node:path";

import { reviewPhinVersion } from "../app-version.js";
import type {
  IPlatform,
  PlatformMaterializedWorkspace,
  PlatformReviewRoutingContext,
  PlatformReviewRuntime,
  PlatformTriggerLifecycle,
  ResolvedTenant,
} from "../platforms/IPlatform.js";
import { getPlatformBySlug } from "../platforms/platform-registry.js";
import {
  NoOpPlatformTriggerLifecycle,
  syncPlatformTriggerLifecycle,
  syncPlatformTriggerLifecycleForJob,
} from "../platforms/trigger-lifecycle.js";
import type {
  DiscussionReconciler,
  ReconcileSummary,
} from "../reconcile/discussion-reconciler.js";
import type { HarnessChatterRunnerFactory } from "../review/harness-chatter.js";
import { projectActiveReviewFindings } from "../review/active-findings.js";
import { buildManualReviewPlan } from "../review/interaction-plan.js";
import type { HarnessSessionMetricsEnvelope } from "../harness/types.js";
import {
  ModelProfileConfigurationError,
  resolveReviewProviderConfig,
} from "../review/model-profiles.js";
import { getReviewPublicationMode } from "../review/publication.js";
import type { ReviewProviderFactory } from "../review/provider.js";
import { InteractionRunArtifacts } from "../review/run-artifacts.js";
import { resolveReviewOverview } from "../review/summary.js";
import type {
  InteractionRequestContext,
  ReviewContext,
  ReviewResult,
  WebhookReviewTrigger,
} from "../review/types.js";
import type {
  CreateReviewFindingInput,
  InteractionJobRecord,
  InteractionRunRecord,
  TenantRecord,
} from "../storage/contract/index.js";
import { listAll, type StorageHelpers } from "../storage/storage-helpers.js";
import {
  ClaimScopedStorage,
  type JobClaimContext,
  LeaseLostError,
} from "../storage/storage-helpers.js";
import type { TenantRegistry } from "../tenants/tenant-registry.js";
import { createFindingIdentityKey } from "../utils/ids.js";

interface ReviewRuntimeFactoryInput {
  platform: IPlatform;
  storage: StorageHelpers;
  logger: Logger;
  tenant: TenantRecord;
  connection: ResolvedTenant["connection"];
  interactionJobId: string;
  workspaceAttemptId: string;
  workspaceRoot: string;
  memoryEnabled: boolean;
  interactionRunId?: string | undefined;
  runArtifacts?: InteractionRunArtifacts | undefined;
}

interface ReviewWorkerOptions {
  debounceMs?: number | undefined;
  interactionRouter: Pick<InteractionRouter, "route">;
  storage: StorageHelpers;
  tenantRegistry: TenantRegistry;
  reviewProviderFactory: ReviewProviderFactory;
  chatterRunnerFactory: HarnessChatterRunnerFactory;
  reconciler: DiscussionReconciler;
  logger: Logger;
  runLogDir: string;
  workspaceRoot?: string | undefined;
  memoryEnabled?: boolean | undefined;
  maxJobRetries: number;
  retryBackoffMs: number;
  platformResolver?: ((platformSlug: string) => IPlatform | null) | undefined;
  reviewRuntimeFactory?:
    ((input: ReviewRuntimeFactoryInput) => PlatformReviewRuntime) | undefined;
}

export class ReviewWorker {
  private readonly debounceMs: number;
  private readonly interactionRouter: Pick<InteractionRouter, "route">;
  private readonly storage: StorageHelpers;
  private readonly tenantRegistry: TenantRegistry;
  private readonly reviewProviderFactory: ReviewProviderFactory;
  private readonly chatterRunnerFactory: HarnessChatterRunnerFactory;
  private readonly reconciler: DiscussionReconciler;
  private readonly logger: Logger;
  private readonly runLogDir: string;
  private readonly workspaceRoot: string;
  private readonly memoryEnabled: boolean;
  private readonly maxJobRetries: number;
  private readonly retryBackoffMs: number;
  private readonly platformResolver: (platformSlug: string) => IPlatform | null;
  private readonly reviewRuntimeFactory: (
    input: ReviewRuntimeFactoryInput,
  ) => PlatformReviewRuntime;

  public constructor(options: ReviewWorkerOptions) {
    this.debounceMs = options.debounceMs ?? 15000;
    this.interactionRouter = options.interactionRouter;
    this.storage = options.storage;
    this.tenantRegistry = options.tenantRegistry;
    this.reviewProviderFactory = options.reviewProviderFactory;
    this.chatterRunnerFactory = options.chatterRunnerFactory;
    this.reconciler = options.reconciler;
    this.logger = options.logger;
    this.runLogDir = options.runLogDir;
    this.workspaceRoot =
      options.workspaceRoot ?? join("tmp", "review-worker-workspaces");
    this.memoryEnabled = options.memoryEnabled ?? false;
    this.maxJobRetries = options.maxJobRetries;
    this.retryBackoffMs = options.retryBackoffMs;
    this.platformResolver = options.platformResolver ?? getPlatformBySlug;
    this.reviewRuntimeFactory =
      options.reviewRuntimeFactory ??
      ((input) =>
        input.platform.createReviewRuntime({
          storage: input.storage,
          logger: input.logger,
          resolvedTenant: {
            tenant: input.tenant,
            connection: input.connection,
          },
          interactionJobId: input.interactionJobId,
          workspaceAttemptId: input.workspaceAttemptId,
          workspaceRoot: input.workspaceRoot,
          memoryEnabled: input.memoryEnabled,
          interactionRunId: input.interactionRunId,
          runArtifacts: input.runArtifacts,
        }));
  }

  public async createInteractionJobFromWebhook(
    payload: unknown,
    resolvedTenant: ResolvedTenant,
    trigger: WebhookReviewTrigger,
  ): Promise<{
    job: InteractionJobRecord;
    created: boolean;
  }> {
    const platform = this.resolvePlatform(resolvedTenant.tenant.platform);
    const interactionJob = await platform.createInteractionJob({
      resolvedTenant,
      payload,
      trigger,
      storage: this.storage,
    });
    const request = {
      tenantId: resolvedTenant.tenant.id,
      dedupeKey: interactionJob.dedupeKey,
      codeReviewId: interactionJob.codeReviewId,
      commentId: interactionJob.commentId,
      triggerJson: interactionJob.triggerJson,
      headSha: interactionJob.headSha,
      payloadJson: interactionJob.payloadJson,
    };
    const admission =
      trigger.kind === "check-run-requested-action"
        ? null
        : await this.storage.stores.interactionJobs.admitInteractionTrigger({
            request,
            now: new Date().toISOString(),
            debounceMs: this.debounceMs,
          });
    const createdJob = admission
      ? { job: admission.job, created: admission.outcome !== "duplicate" }
      : await this.storage.createOrGetInteractionJob(request);
    const lifecycleJob = {
      ...createdJob.job,
      commentId: request.commentId ?? null,
      triggerJson: request.triggerJson ?? createdJob.job.triggerJson,
      payloadJson: request.payloadJson,
    };

    const lifecycle = platform.createTriggerLifecycle({
      resolvedTenant,
      job: lifecycleJob,
      logger: this.logger,
    });
    await syncPlatformTriggerLifecycleForJob({
      logger: this.logger,
      job: createdJob.job,
      lifecycle,
    });

    return createdJob;
  }

  public async reconcileTriggerLifecycle(
    job: InteractionJobRecord,
  ): Promise<void> {
    try {
      const resolvedTenant = await this.tenantRegistry.getResolvedTenantById(
        job.tenantId,
      );
      if (!resolvedTenant) {
        return;
      }
      const platform = this.platformResolver(resolvedTenant.tenant.platform);
      if (!platform) {
        return;
      }
      const lifecycle = await this.createBatchTriggerLifecycle(
        platform,
        resolvedTenant,
        job,
      );
      await syncPlatformTriggerLifecycleForJob({
        logger: this.logger,
        job,
        lifecycle,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, interactionJobId: job.id, status: job.status },
        "failed to reconcile provider trigger lifecycle from job state",
      );
    }
  }

  public async classifyWebhookTrigger(
    payload: unknown,
    resolvedTenant: ResolvedTenant,
  ): Promise<WebhookReviewTrigger | null> {
    const platform = this.resolvePlatform(resolvedTenant.tenant.platform);
    return platform.classifyWebhookTrigger(resolvedTenant, payload);
  }

  /**
   * Best-effort trigger-lifecycle reconciliation for an orphaned interaction run
   * that a runner has just marked failed. Maps the owning job's current state to
   * a provider-side lifecycle action per the storage-v005 contract:
   *
   * - a queued job maps to `retry`;
   * - an in-progress job owned by a replacement claim performs no action because
   *   the replacement attempt owns the provider lifecycle;
   * - a `failed`, `cancelled`, or `expired` job maps to `failed`;
   * - a `completed` job performs no action because the winning attempt already
   *   completed its lifecycle.
   */
  public async reconcileOrphanLifecycle(
    run: InteractionRunRecord,
  ): Promise<void> {
    try {
      const job = await this.storage.stores.interactionJobs.get(
        run.interactionJobId,
      );
      if (!job) {
        return;
      }

      const resolvedTenant = await this.tenantRegistry.getResolvedTenantById(
        job.tenantId,
      );
      if (!resolvedTenant) {
        return;
      }

      const platform = this.platformResolver(resolvedTenant.tenant.platform);
      if (!platform) {
        return;
      }
      const lifecycle = this.createTriggerLifecycle(
        platform,
        resolvedTenant,
        job,
      );

      const message =
        job.lastError ??
        "Interaction run abandoned after its owning claim was lost.";
      if (job.status === "queued") {
        await lifecycle.retry(message);
      } else if (
        job.status === "failed" ||
        job.status === "cancelled" ||
        job.status === "expired"
      ) {
        await lifecycle.failed(message);
      }
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          interactionRunId: run.id,
          interactionJobId: run.interactionJobId,
        },
        "failed to reconcile orphaned run trigger lifecycle",
      );
    }
  }

  public async processClaimedJob(
    job: InteractionJobRecord,
    context: JobClaimContext,
  ): Promise<void> {
    const jobStore = this.storage.stores.interactionJobs;
    const scoped = new ClaimScopedStorage(this.storage.stores, context);

    const resolvedTenant = await this.tenantRegistry.getResolvedTenantById(
      job.tenantId,
    );
    if (!resolvedTenant) {
      throw new Error(`Unknown tenant ${job.tenantId} for job ${job.id}`);
    }
    const { tenant, connection } = resolvedTenant;
    const platform = this.resolvePlatform(tenant.platform);
    const publicationEnabled =
      getReviewPublicationMode(job.triggerJson) === "publish";
    const triggerLifecycle = await this.createBatchTriggerLifecycle(
      platform,
      resolvedTenant,
      job,
    );

    context.assertOwned();
    await syncPlatformTriggerLifecycle({
      logger: this.logger,
      job,
      phase: "in_progress",
      update: () => triggerLifecycle.inProgress(),
    });
    context.assertOwned();

    let checkpoint: BatchCheckpoint | null = null;
    let interactionRunId: string | null = null;
    let runArtifacts: InteractionRunArtifacts | null = null;
    const workspacesToCleanup: PlatformMaterializedWorkspace[] = [];
    let cleanupWorkspace:
      ((workspace: PlatformMaterializedWorkspace) => Promise<void>) | null =
      null;

    try {
      const runtime = this.reviewRuntimeFactory({
        platform,
        storage: scoped,
        logger: this.logger,
        tenant,
        connection,
        interactionJobId: job.id,
        workspaceAttemptId: context.claimToken,
        workspaceRoot: this.workspaceRoot,
        memoryEnabled: this.memoryEnabled,
      });
      cleanupWorkspace = (workspace) => runtime.cleanupWorkspace(workspace);
      if (job.batchKind === "comment") {
        const attempts = await listAll(this.storage.stores.interactionRuns, {
          filters: { interactionJobId: { eq: job.id } },
          order: [{ field: "startedAt", direction: "desc" }],
        });
        const saved = attempts.find((attempt) => attempt.repliesJson !== null);
        if (saved?.repliesJson)
          checkpoint = batchCheckpointSchema.parse(
            JSON.parse(saved.repliesJson),
          );
      }
      if (job.batchKind === "comment" && runtime.getCurrentHead) {
        const headSha = await runtime.getCurrentHead(job);
        if (checkpoint && checkpoint.headSha !== headSha) {
          if (
            checkpoint.reviewPublished ||
            checkpoint.publishedReplyKeys.length
          )
            throw new AbandonedReviewError(
              "Code review head changed after partial batch publication; request a new review for the new head",
            );
          checkpoint = null;
        }
        context.assertOwned();
        if (
          !(await jobStore.setInteractionJobHeadForClaim({
            jobId: job.id,
            claimToken: context.claimToken,
            headSha,
          }))
        )
          throw new LeaseLostError();
        job = { ...job, headSha };
      }
      const requestRecords =
        job.batchKind === "comment"
          ? await listAll(this.storage.stores.interactionRequests, {
              filters: { interactionJobId: { eq: job.id } },
              order: [
                { field: "receivedAt", direction: "asc" },
                { field: "id", direction: "asc" },
              ],
            })
          : [];
      if (job.batchKind === "comment" && !requestRecords.length)
        throw new Error("Collected job has no requests");
      const parsedPayload = JSON.parse(job.payloadJson) as unknown;
      context.assertOwned();
      let routingContext = await this.loadRoutingContext({
        runtime,
        job,
      });
      context.assertOwned();
      workspacesToCleanup.push(routingContext.workspace);
      if (job.commentId !== null) {
        runtime.locateTriggerCommentReference({
          context: routingContext,
          commentId: job.commentId,
        });
      }

      const resolvedProviderConfig = await resolveReviewProviderConfig({
        storage: this.storage,
        tenant,
        codeReview: routingContext.summaryContext.codeReview,
      });
      const reviewProvider = this.reviewProviderFactory.createProvider(
        resolvedProviderConfig,
      );
      const chatterRunner = this.chatterRunnerFactory.createRunner(
        resolvedProviderConfig,
      );
      context.assertOwned();
      const interactionRun = await scoped.createInteractionRun({
        interactionJobId: job.id,
        tenantId: tenant.id,
        provider: reviewProvider.name,
        model: resolvedProviderConfig.reviewModel,
        modelProfileName: resolvedProviderConfig.modelProfileName,
        providerBaseUrl: resolvedProviderConfig.providerBaseUrl,
        providerType: resolvedProviderConfig.providerType,
        textGenerationModel: resolvedProviderConfig.textGenerationModel,
        reviewReasoningEffort: resolvedProviderConfig.reviewReasoningEffort,
        textGenerationReasoningEffort:
          resolvedProviderConfig.textGenerationReasoningEffort,
      });
      interactionRunId = interactionRun.id;
      const saveCheckpoint = async () => {
        if (
          checkpoint &&
          !(await jobStore.saveInteractionRunRepliesForClaim({
            jobId: job.id,
            claimToken: context.claimToken,
            interactionRunId: interactionRun.id,
            repliesJson: JSON.stringify(checkpoint),
          }))
        )
          throw new LeaseLostError();
      };
      runArtifacts = new InteractionRunArtifacts(
        this.runLogDir,
        interactionRun.id,
      );
      await runArtifacts.initialize();
      const runRuntime = this.reviewRuntimeFactory({
        platform,
        storage: scoped,
        logger: this.logger,
        tenant,
        connection,
        interactionJobId: job.id,
        workspaceAttemptId: context.claimToken,
        interactionRunId: interactionRun.id,
        runArtifacts,
        workspaceRoot: this.workspaceRoot,
        memoryEnabled: this.memoryEnabled,
      });
      if (job.commentId !== null) {
        context.assertOwned();
        await runRuntime
          .resolveTriggerCommentReference({
            codeReviewId: job.codeReviewId,
            commentId: job.commentId,
            triggerJson: job.triggerJson,
          })
          .catch((error: unknown) => {
            throw new AbandonedReviewError(getErrorMessage(error));
          });
        context.assertOwned();
      }

      await this.logRunEvent(runArtifacts, "info", "interaction run started", {
        reviewPhinVersion,
        interactionJobId: job.id,
        interactionRunId: interactionRun.id,
        interactionJobClaimToken: context.claimToken,
        reviewReasoningEffort: interactionRun.reviewReasoningEffort,
        textGenerationReasoningEffort:
          interactionRun.textGenerationReasoningEffort,
        tenantId: tenant.id,
        codeReviewId: job.codeReviewId,
        modelProfileName: resolvedProviderConfig.modelProfileName,
        selectionSource: resolvedProviderConfig.selectionSource,
        reviewModel: resolvedProviderConfig.reviewModel,
        textGenerationModel: resolvedProviderConfig.textGenerationModel,
        providerBaseUrl: resolvedProviderConfig.providerBaseUrl,
        providerType: resolvedProviderConfig.providerType,
      });

      await this.logRunEvent(
        runArtifacts,
        "info",
        "lightweight routing context loaded",
        {
          interactionJobId: job.id,
          codeReviewId: job.codeReviewId,
          changedFiles: routingContext.changedFileCount,
          commentCount: routingContext.commentCount,
          discussionCount: routingContext.discussionCount,
          workspaceStrategy: routingContext.workspace.strategy,
          ...(routingContext.workspace.gitPreparationError
            ? {
                gitPreparationError:
                  routingContext.workspace.gitPreparationError,
              }
            : {}),
        },
      );

      let mappings = await listAll(this.storage.stores.discussionMappings, {
        filters: {
          tenantId: { eq: tenant.id },
          codeReviewId: { eq: routingContext.codeReviewId },
        },
        order: [{ field: "updatedAt", direction: "desc" }],
      });
      context.assertOwned();
      mappings = await runtime.syncDiscussionFindingStatuses({
        tenant,
        codeReviewId: routingContext.codeReviewId,
        context: routingContext,
        mappings,
      });
      context.assertOwned();
      const priorDiscussions = runtime.buildProviderDiscussions({
        context: routingContext,
        mappings,
      });
      let trigger = runtime.buildReviewTriggerContext({
        job,
        payload: parsedPayload,
        context: routingContext,
        priorDiscussions,
        mappings,
      });
      const requests: InteractionRequestContext[] = requestRecords.map(
        (request) => {
          const requestTrigger = runtime.buildReviewTriggerContext({
            job: {
              ...job,
              commentId: request.commentId,
              triggerJson: request.triggerJson,
              payloadJson: request.payloadJson,
            },
            payload: JSON.parse(request.payloadJson) as unknown,
            context: routingContext,
            priorDiscussions,
            mappings,
          });
          if (requestTrigger.kind === "manual-review")
            throw new Error("Manual trigger cannot belong to a comment batch");
          return { id: request.id, trigger: requestTrigger };
        },
      );
      // Jobs queued before batching was introduced still use model routing.
      if (!requests.length && trigger.kind !== "manual-review")
        requests.push({ id: job.id, trigger });
      for (const request of requests) {
        context.assertOwned();
        await runRuntime.resolveTriggerCommentReference({
          codeReviewId: job.codeReviewId,
          commentId: request.trigger.commentId,
          triggerJson: requestRecords.find((r) => r.id === request.id)
            ?.triggerJson,
        });
      }
      const previousInteraction =
        await this.storage.getLatestCompletedInteractionForCodeReview(
          tenant.id,
          routingContext.codeReviewId,
          job.id,
        );
      let priorFindings = await this.storage.listPriorReviewFindings(
        tenant.id,
        routingContext.codeReviewId,
        job.id,
      );
      let routing: InteractionRoutingResult | null = null;
      if (requests.length) {
        const routingStartedAt = Date.now();
        routing =
          checkpoint?.routing ??
          (await this.interactionRouter.route(
            {
              requests,
              previousReviewExists: previousInteraction !== null,
              priorFindings,
              discussions: priorDiscussions,
              memoryEnabled: routingContext.projectMemory.enabled,
            },
            resolvedProviderConfig,
            {
              interactionRunId: interactionRun.id,
              interactionJobId: job.id,
              tenantId: tenant.id,
              runDirectory: runArtifacts.runDirectory,
              onMetrics: this.createMetricsSink(jobStore, context, {
                interactionRunId: interactionRun.id,
                triggerKind: trigger.kind,
                promptMode: "routing",
                promptContextChangedFiles: 0,
                promptContextPriorDiscussions: priorDiscussions.length,
                promptContextComments: requests.length,
              }),
            },
          ));
        context.assertOwned();
        // Prefer a reviewing request as the representative used by legacy scope helpers.
        trigger =
          requests.find((r) =>
            routing?.decisions.some((d) => d.requestId === r.id && d.review),
          )?.trigger ?? requests[0]!.trigger;
        await runArtifacts.writeJsonArtifact(
          join("orchestration", "routing.json"),
          {
            ...routing,
            promptVersion: 1,
            model:
              routing.model !== undefined
                ? routing.model
                : (resolvedProviderConfig.routingModel ?? null),
            reasoningEffort:
              routing.reasoningEffort !== undefined
                ? routing.reasoningEffort
                : (resolvedProviderConfig.routingReasoningEffort ?? null),
            elapsedMs: Date.now() - routingStartedAt,
            recovered: checkpoint !== null,
            requestCount: requests.length,
          },
        );
      }
      if (routing && job.batchKind === "comment") {
        if (
          checkpoint &&
          JSON.stringify(checkpoint.requestIds) !==
            JSON.stringify(requests.map((r) => r.id))
        )
          throw new Error(
            "Saved batch membership does not match the claimed job",
          );
        checkpoint ??= {
          version: 1,
          headSha: job.headSha,
          requestIds: requests.map((r) => r.id),
          routing,
          memoryDone: false,
          reviewResult: null,
          reviewPublished: false,
          replyResult: null,
          publishedReplyKeys: [],
        };
        await saveCheckpoint();
      }
      const replyRequests = requests.filter((r) =>
        routing?.decisions.some((d) => d.requestId === r.id && d.reply),
      );
      const interactionPlan = routing
        ? reduceRoutingDecisions(requests, routing.decisions)
        : buildManualReviewPlan(trigger);

      await runArtifacts.writeJsonArtifact(
        join("orchestration", "plan.json"),
        interactionPlan,
      );
      await this.logRunEvent(runArtifacts, "info", "interaction plan created", {
        interactionRunId: interactionRun.id,
        triggerKind: trigger.kind,
        reviewNeeded: interactionPlan.reviewNeeded,
        replyNeeded: interactionPlan.replyNeeded,
        memoryCandidate: interactionPlan.memoryCandidate,
        responseTargetCount: interactionPlan.responseTargets.length,
        rerunReason: interactionPlan.rerunReason,
      });

      context.assertOwned();
      const imageAttachments = await runRuntime.materializeAttachments({
        context: routingContext,
        runArtifacts,
        trigger,
        ...(requests.length
          ? { triggers: requests.map((request) => request.trigger) }
          : {}),
      });
      context.assertOwned();
      let chatterContext = runtime.buildPromptContext({
        ...(requests.length ? { requests } : {}),
        attachments: imageAttachments.breadcrumbs,
        attachmentIssues: imageAttachments.issues,
        interactionRunId: interactionRun.id,
        tenant,
        job,
        runArtifacts,
        trigger,
        context: routingContext,
        mappings,
        priorFindings,
        previousInteraction,
      });

      if (
        interactionPlan.memoryCandidate &&
        !checkpoint?.memoryDone &&
        trigger.kind !== "manual-review"
      ) {
        context.assertOwned();
        const memoryResult = await chatterRunner.run(
          {
            attachments: imageAttachments.attachments,
            trigger,
            responseTargets: interactionPlan.responseTargets,
            projectMemory: chatterContext.projectMemory,
            replyStyle: interactionPlan.replyStyle,
            ...(requests.length ? { requests } : {}),
            phase: "memory",
            reviewContext: chatterContext,
            logging: {
              interactionRunId: interactionRun.id,
              interactionJobId: job.id,
              tenantId: tenant.id,
              runDirectory: runArtifacts.runDirectory,
              onMetrics: this.createMetricsSink(jobStore, context, {
                interactionRunId: interactionRun.id,
                triggerKind: trigger.kind,
                promptMode: "memory",
                promptContextChangedFiles: chatterContext.changes.length,
                promptContextPriorDiscussions:
                  chatterContext.priorDiscussions.length,
                promptContextComments: chatterContext.comments.length,
              }),
            },
          },
          {
            tenant: this.buildHarnessTenantContext({
              platform,
              tenant,
              connection,
              interactionRunId: interactionRun.id,
              interactionJobId: job.id,
              runDirectory: runArtifacts.runDirectory,
              memoryEnabled: routingContext.projectMemory.enabled,
              platformWritesEnabled: publicationEnabled,
              onMetrics: this.createMetricsSink(jobStore, context, {
                interactionRunId: interactionRun.id,
                triggerKind: trigger.kind,
                promptMode: "memory-consolidation",
                promptContextChangedFiles: chatterContext.changes.length,
                promptContextPriorDiscussions:
                  chatterContext.priorDiscussions.length,
                promptContextComments: chatterContext.comments.length,
              }),
            }),
          },
        );
        await runArtifacts.writeJsonArtifact(
          join("orchestration", "memory-result.json"),
          memoryResult,
        );
        context.assertOwned();
        if (checkpoint) {
          checkpoint.memoryDone = true;
          await saveCheckpoint();
        }
        routingContext = runRuntime.refreshProjectMemory
          ? await runRuntime.refreshProjectMemory(job, routingContext)
          : routingContext;
        context.assertOwned();
        workspacesToCleanup.push(routingContext.workspace);
        chatterContext = runtime.buildPromptContext({
          ...(requests.length ? { requests } : {}),
          attachments: imageAttachments.breadcrumbs,
          attachmentIssues: imageAttachments.issues,
          interactionRunId: interactionRun.id,
          tenant,
          job,
          runArtifacts,
          trigger,
          context: routingContext,
          mappings,
          priorFindings,
          previousInteraction,
        });
      }

      let reviewResult: ReviewResult | null = null;
      let reviewContext: ReviewContext | null = null;
      let reconcileSummary: ReconcileSummary | null = null;

      if (interactionPlan.reviewNeeded) {
        context.assertOwned();
        const hydratedContext = await this.hydrateContext({
          runtime: runRuntime,
          job,
          context: routingContext,
        });
        context.assertOwned();
        workspacesToCleanup.push(hydratedContext.workspace);
        context.assertOwned();
        mappings = await runRuntime.syncDiscussionFindingStatuses({
          tenant,
          codeReviewId: hydratedContext.codeReviewId,
          context: hydratedContext,
          mappings,
        });
        context.assertOwned();
        priorFindings = await this.storage.listPriorReviewFindings(
          tenant.id,
          hydratedContext.codeReviewId,
          job.id,
        );
        reviewContext = runRuntime.buildPromptContext({
          ...(requests.length ? { requests } : {}),
          attachments: imageAttachments.breadcrumbs,
          attachmentIssues: imageAttachments.issues,
          interactionRunId: interactionRun.id,
          tenant,
          job,
          runArtifacts,
          trigger,
          context: hydratedContext,
          mappings,
          priorFindings,
          previousInteraction,
        });
        reviewContext = {
          ...reviewContext,
          logging: {
            ...reviewContext.logging,
            interactionRunId: interactionRun.id,
            interactionJobId: job.id,
            tenantId: tenant.id,
            runDirectory: runArtifacts.runDirectory,
            onMetrics: this.createMetricsSink(jobStore, context, {
              interactionRunId: interactionRun.id,
              triggerKind: reviewContext.trigger.kind,
              promptMode: reviewContext.scope.mode,
              promptContextChangedFiles: reviewContext.changes.length,
              promptContextPriorDiscussions:
                reviewContext.priorDiscussions.length,
              promptContextComments: reviewContext.comments.length,
            }),
          },
        };

        await this.logRunEvent(
          runArtifacts,
          "info",
          "starting reviewer session",
          {
            interactionRunId: interactionRun.id,
            workspacePath: hydratedContext.workspace.rootPath,
            changedFiles: hydratedContext.changedFileCount,
            promptMode: reviewContext.scope.mode,
            triggerKind: reviewContext.trigger.kind,
            promptContextChangedFiles: reviewContext.changes.length,
          },
        );

        context.assertOwned();
        const modelReviewResult =
          checkpoint?.reviewResult ??
          (await reviewProvider.review(reviewContext, {
            attachments: imageAttachments.attachments,
            tenant: this.buildHarnessTenantContext({
              platform,
              tenant,
              connection,
              interactionRunId: interactionRun.id,
              interactionJobId: job.id,
              runDirectory: runArtifacts.runDirectory,
              memoryEnabled: hydratedContext.projectMemory.enabled,
              platformWritesEnabled: publicationEnabled,
              onMetrics: this.createMetricsSink(jobStore, context, {
                interactionRunId: interactionRun.id,
                triggerKind: reviewContext.trigger.kind,
                promptMode: "memory-consolidation",
                promptContextChangedFiles: reviewContext.changes.length,
                promptContextPriorDiscussions:
                  reviewContext.priorDiscussions.length,
                promptContextComments: reviewContext.comments.length,
              }),
            }),
          }));
        const activeFindings = projectActiveReviewFindings({
          priorFindings: reviewContext.scope.priorFindings,
          discussionIdentities: mappings.map((mapping) => ({
            discussionId: mapping.id,
            identityKey: mapping.identityKey,
          })),
          reviewResult: modelReviewResult,
        });
        // Canonicalize readiness before any no-publish output or persistence.
        reviewResult = {
          ...modelReviewResult,
          overview: resolveReviewOverview(modelReviewResult, activeFindings),
        };
        if (checkpoint) {
          checkpoint.reviewResult = reviewResult;
          await saveCheckpoint();
        }
        await runArtifacts.writeJsonArtifact(
          join("orchestration", "review-result.json"),
          reviewResult,
        );

        context.assertOwned();
        const findingsPersisted = await jobStore.replaceReviewFindingsForClaim({
          jobId: context.jobId,
          claimToken: context.claimToken,
          interactionRunId: interactionRun.id,
          findings: reviewResult.findings.map(
            (finding): CreateReviewFindingInput => {
              const identityKey = createFindingIdentityKey({
                title: finding.title,
                category: finding.category,
                path: finding.anchor?.path,
                startLine: finding.anchor?.startLine,
                endLine: finding.anchor?.endLine,
                side: finding.anchor?.side,
              });
              return {
                interactionRunId: interactionRun.id,
                identityKey,
                severity: finding.severity,
                category: finding.category,
                title: finding.title,
                body: finding.body,
                anchorJson: finding.anchor
                  ? JSON.stringify(finding.anchor)
                  : null,
                suggestionJson: finding.suggestion
                  ? JSON.stringify(finding.suggestion)
                  : null,
                status: "open",
              };
            },
          ),
        });
        if (!findingsPersisted) {
          throw new LeaseLostError();
        }

        if (publicationEnabled && !checkpoint?.reviewPublished) {
          await this.assertCurrentHead(runRuntime, job, context);
          context.assertOwned();
          reconcileSummary = await this.reconciler.reconcile({
            platform,
            tenant,
            connection,
            context: hydratedContext.summaryContext,
            mappings,
            interactionJobId: job.id,
            interactionRunId: interactionRun.id,
            reviewResult: requests.length
              ? {
                  ...reviewResult,
                  priorDispositions: reviewResult.priorDispositions.map(
                    (disposition) => {
                      if (
                        !replyRequests.some(
                          (request) =>
                            request.trigger.targetDiscussionId ===
                            disposition.discussionId,
                        )
                      )
                        return disposition;
                      const { replyBody: _replyBody, ...stateChange } =
                        disposition;
                      return {
                        ...stateChange,
                        action:
                          stateChange.action === "reply"
                            ? ("keep" as const)
                            : stateChange.action,
                      };
                    },
                  ),
                }
              : reviewResult,
            storage: scoped,
            guard: context,
            publicationAdapter: runRuntime.createReviewPublicationAdapter({
              context: hydratedContext,
              interactionRunId: interactionRun.id,
            }),
          });
          // Reconciliation may carry forward active findings from earlier runs.
          if (reconcileSummary.resolvedOverview) {
            reviewResult = {
              ...reviewResult,
              overview: reconcileSummary.resolvedOverview,
            };
          }
          context.assertOwned();
          if (checkpoint) {
            checkpoint.reviewPublished = true;
            checkpoint.reviewResult = reviewResult;
            await saveCheckpoint();
          }

          await this.logRunEvent(
            runArtifacts,
            "info",
            "reconciled review result into platform discussions",
            {
              interactionRunId: interactionRun.id,
              summary: reconcileSummary,
            },
          );
        } else {
          await this.logRunEvent(
            runArtifacts,
            "info",
            "skipped review publication for local test",
            { interactionRunId: interactionRun.id },
          );
        }
      }

      if (interactionPlan.replyNeeded && trigger.kind !== "manual-review") {
        context.assertOwned();
        const replyResult =
          checkpoint?.replyResult ??
          (await chatterRunner.run(
            {
              attachments: imageAttachments.attachments,
              trigger,
              responseTargets: interactionPlan.responseTargets,
              projectMemory:
                reviewContext?.projectMemory ?? chatterContext.projectMemory,
              replyStyle: interactionPlan.replyStyle,
              ...(requests.length ? { requests: replyRequests } : {}),
              phase: "reply",
              reviewContext: reviewContext ?? chatterContext,
              reviewerReplyHandoff: reviewResult?.replyHandoff ?? null,
              reviewResult,
              logging: {
                interactionRunId: interactionRun.id,
                interactionJobId: job.id,
                tenantId: tenant.id,
                runDirectory: runArtifacts.runDirectory,
                onMetrics: this.createMetricsSink(jobStore, context, {
                  interactionRunId: interactionRun.id,
                  triggerKind: trigger.kind,
                  promptMode: "reply",
                  promptContextChangedFiles:
                    reviewContext?.changes.length ??
                    chatterContext.changes.length,
                  promptContextPriorDiscussions:
                    reviewContext?.priorDiscussions.length ??
                    chatterContext.priorDiscussions.length,
                  promptContextComments:
                    reviewContext?.comments.length ??
                    chatterContext.comments.length,
                }),
              },
            },
            {
              tenant: this.buildHarnessTenantContext({
                platform,
                tenant,
                connection,
                interactionRunId: interactionRun.id,
                interactionJobId: job.id,
                runDirectory: runArtifacts.runDirectory,
                memoryEnabled:
                  reviewContext?.projectMemory.enabled ??
                  routingContext.projectMemory.enabled,
                platformWritesEnabled: publicationEnabled,
                onMetrics: this.createMetricsSink(jobStore, context, {
                  interactionRunId: interactionRun.id,
                  triggerKind: trigger.kind,
                  promptMode: "memory-consolidation",
                  promptContextChangedFiles:
                    reviewContext?.changes.length ??
                    chatterContext.changes.length,
                  promptContextPriorDiscussions:
                    reviewContext?.priorDiscussions.length ??
                    chatterContext.priorDiscussions.length,
                  promptContextComments:
                    reviewContext?.comments.length ??
                    chatterContext.comments.length,
                }),
              }),
            },
          ));
        await runArtifacts.writeJsonArtifact(
          join("orchestration", "reply-result.json"),
          replyResult,
        );

        context.assertOwned();
        if (requests.length) validateReplyCoverage(replyRequests, replyResult);
        if (publicationEnabled)
          await this.assertCurrentHead(runRuntime, job, context);
        if (checkpoint) {
          checkpoint.replyResult = replyResult;
          await saveCheckpoint();
        }
        const publishOutcomes = [];
        if (publicationEnabled) {
          for (const reply of replyResult.replies) {
            context.assertOwned();
            const marker = checkpoint
              ? replyPublicationMarker(job.id, reply.coveredRequestIds ?? [])
              : null;
            if (marker && checkpoint?.publishedReplyKeys.includes(marker))
              continue;
            await this.assertCurrentHead(runRuntime, job, context);
            const outcomes = await runRuntime.publishChatterReplies({
              codeReviewId: routingContext.codeReviewId,
              result: {
                memory: null,
                replies: [
                  {
                    ...reply,
                    replyBody: marker
                      ? reply.replyBody + "\n\n" + marker
                      : reply.replyBody,
                  },
                ],
              },
              plannedTargets: interactionPlan.responseTargets,
              guard: context,
            });
            context.assertOwned();
            publishOutcomes.push(...outcomes);
            if (outcomes.length !== 1 || outcomes[0]?.status !== "published")
              throw new Error("A planned chatter reply failed to publish");
            if (marker && checkpoint) {
              checkpoint.publishedReplyKeys.push(marker);
              await saveCheckpoint();
            }
          }
        }
        await runArtifacts.writeJsonArtifact(
          join("orchestration", "reply-publish-outcomes.json"),
          publishOutcomes,
        );
      }

      // Commit order: findings/metrics, run terminal transition, then job
      // transition. Never transition the job first because clearing its claim
      // would make the run transition unverifiable.
      context.assertOwned();
      await scoped.completeInteractionRun(
        interactionRun.id,
        reviewResult ? JSON.stringify(reviewResult) : null,
      );
      // Publish the completed lifecycle while the claim is still active (the job
      // has not yet been transitioned, so ownership is intact), then re-check
      // ownership before releasing the claim. Never publish lifecycle mutations
      // after the job transition clears ownership.
      if (!this.claimIsOwned(context, job, "completed", interactionRunId)) {
        return;
      }
      await syncPlatformTriggerLifecycle({
        logger: this.logger,
        job,
        phase: "completed",
        update: () =>
          triggerLifecycle.completed(
            runRuntime.buildTriggerOutcome({
              reviewResult,
              reconcileSummary,
            }),
          ),
      });
      if (!this.claimIsOwned(context, job, "completed", interactionRunId)) {
        return;
      }
      const jobCompleted = await jobStore.transitionClaim({
        jobId: context.jobId,
        claimToken: context.claimToken,
        status: "completed",
        retryCount: job.retryCount,
        lastError: null,
        availableAt: job.availableAt,
        finishedAt: new Date().toISOString(),
      });
      if (!jobCompleted) {
        this.logJobLeaseLost(job, "completed", interactionRunId);
        return;
      }
      this.logger.info(
        {
          interactionJobId: job.id,
          interactionRunId: interactionRun.id,
          summary: reconcileSummary,
        },
        "interaction job completed",
      );
    } catch (error) {
      if (error instanceof LeaseLostError) {
        this.logJobLeaseLost(job, "processing", interactionRunId);
        return;
      }

      const errorMessage = getErrorMessage(error);
      const isAbandonedReview = error instanceof AbandonedReviewError;

      if (runArtifacts) {
        await this.logRunEvent(
          runArtifacts,
          "error",
          "interaction job failed",
          {
            interactionJobId: job.id,
            interactionRunId,
            error: serializeError(error),
          },
        );
      }

      if (interactionRunId) {
        if (!checkpoint?.reviewPublished)
          await jobStore.replaceReviewFindingsForClaim({
            jobId: context.jobId,
            claimToken: context.claimToken,
            interactionRunId,
            findings: [],
          });
        try {
          if (isAbandonedReview) {
            await scoped.cancelInteractionRun(interactionRunId, errorMessage);
          } else {
            if (checkpoint?.reviewResult) {
              const saved = await jobStore.transitionInteractionRunForClaim({
                jobId: job.id,
                claimToken: context.claimToken,
                interactionRunId,
                status: "failed",
                resultJson: JSON.stringify(checkpoint.reviewResult),
                error: errorMessage,
                finishedAt: new Date().toISOString(),
              });
              if (!saved) throw new LeaseLostError();
            } else
              await scoped.failInteractionRun(interactionRunId, errorMessage);
          }
        } catch (transitionError) {
          if (!(transitionError instanceof LeaseLostError)) {
            throw transitionError;
          }
          this.logJobLeaseLost(job, "run-failure", interactionRunId);
          return;
        }
      }

      const nextRetryCount = job.retryCount + 1;
      const now = new Date().toISOString();
      let phase: "failed" | "retry";
      let transition: {
        status: "queued" | "failed" | "cancelled";
        retryCount: number;
        lastError: string | null;
        availableAt: string;
        finishedAt: string | null;
      };
      if (isAbandonedReview) {
        phase = "failed";
        transition = {
          status: "cancelled",
          retryCount: nextRetryCount,
          lastError: errorMessage,
          availableAt: job.availableAt,
          finishedAt: now,
        };
      } else if (
        !isNonRetryableReviewError(error) &&
        nextRetryCount <= this.maxJobRetries
      ) {
        phase = "retry";
        const availableAt = new Date(
          Date.now() + this.retryBackoffMs * nextRetryCount,
        ).toISOString();
        transition = {
          status: "queued",
          retryCount: nextRetryCount,
          lastError: errorMessage,
          availableAt,
          finishedAt: null,
        };
        this.logger.warn(
          {
            err: error,
            interactionJobId: job.id,
            retryCount: nextRetryCount,
          },
          "interaction job failed and will be retried",
        );
      } else {
        phase = "failed";
        transition = {
          status: "failed",
          retryCount: nextRetryCount,
          lastError: errorMessage,
          availableAt: job.availableAt,
          finishedAt: now,
        };
      }

      // Publish the lifecycle mutation while the claim is still active (the job
      // transition below is what releases ownership), then re-check ownership
      // before transitioning the job. Never publish lifecycle mutations after
      // ownership is released.
      if (!this.claimIsOwned(context, job, phase, interactionRunId)) {
        return;
      }
      await syncPlatformTriggerLifecycle({
        logger: this.logger,
        job,
        phase,
        update: () =>
          phase === "retry"
            ? triggerLifecycle.retry(errorMessage)
            : triggerLifecycle.failed(errorMessage),
      });

      if (!this.claimIsOwned(context, job, phase, interactionRunId)) {
        return;
      }
      const jobTransitioned = await jobStore.transitionClaim({
        jobId: context.jobId,
        claimToken: context.claimToken,
        ...transition,
      });
      if (!jobTransitioned) {
        this.logJobLeaseLost(job, phase, interactionRunId);
        return;
      }
    } finally {
      for (const workspace of Array.from(
        new Map(
          workspacesToCleanup.map((entry) => [entry.cleanupRoot, entry]),
        ).values(),
      ).reverse()) {
        try {
          if (!cleanupWorkspace) {
            continue;
          }
          await cleanupWorkspace(workspace);
        } catch (error) {
          if (runArtifacts) {
            await this.logRunEvent(
              runArtifacts,
              "warn",
              "workspace cleanup failed after interaction completion",
              {
                interactionJobId: job.id,
                cleanupRoot: workspace.cleanupRoot,
                error: serializeError(error),
              },
            );
          }
          this.logger.warn(
            {
              err: error,
              interactionJobId: job.id,
              cleanupRoot: workspace.cleanupRoot,
            },
            "workspace cleanup failed after interaction completion",
          );
        }
      }
    }
  }

  private async assertCurrentHead(
    runtime: PlatformReviewRuntime,
    job: InteractionJobRecord,
    context: JobClaimContext,
  ): Promise<void> {
    context.assertOwned();
    if (
      job.batchKind === "comment" &&
      runtime.getCurrentHead &&
      (await runtime.getCurrentHead(job)) !== job.headSha
    )
      throw new Error("Code review head changed before publication");
    context.assertOwned();
  }

  private async createBatchTriggerLifecycle(
    platform: IPlatform,
    tenant: ResolvedTenant,
    job: InteractionJobRecord,
  ): Promise<PlatformTriggerLifecycle> {
    const requests =
      job.batchKind === "comment"
        ? await listAll(this.storage.stores.interactionRequests, {
            filters: { interactionJobId: { eq: job.id } },
          })
        : [];
    const lifecycles = requests.length
      ? requests.map((r) =>
          this.createTriggerLifecycle(platform, tenant, {
            ...job,
            commentId: r.commentId,
            triggerJson: r.triggerJson,
            payloadJson: r.payloadJson,
          }),
        )
      : [this.createTriggerLifecycle(platform, tenant, job)];
    const each = async (
      fn: (lifecycle: PlatformTriggerLifecycle) => Promise<void>,
    ) => {
      // A failed reaction on one comment must not hide the remaining comments.
      const results = await Promise.allSettled(lifecycles.map(fn));
      const failure = results.find((r) => r.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    };
    return {
      queued: () => each((l) => l.queued()),
      inProgress: () => each((l) => l.inProgress()),
      completed: (outcome) => each((l) => l.completed(outcome)),
      retry: (error) => each((l) => l.retry(error)),
      failed: (error) => each((l) => l.failed(error)),
    };
  }

  private async logRunEvent(
    runArtifacts: InteractionRunArtifacts,
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    this.logger[level](data, message);
    try {
      await runArtifacts.appendAppLog({
        timestamp: new Date().toISOString(),
        level,
        message,
        data,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, message },
        "failed to persist run app log",
      );
    }
  }

  private logJobLeaseLost(
    job: InteractionJobRecord,
    phase: string,
    interactionRunId?: string | null,
  ): void {
    this.logger.warn(
      {
        interactionJobId: job.id,
        interactionRunId: interactionRunId ?? null,
        phase,
      },
      "interaction job lease lost; stopping without further state updates",
    );
  }

  private claimIsOwned(
    context: JobClaimContext,
    job: InteractionJobRecord,
    phase: string,
    interactionRunId?: string | null,
  ): boolean {
    try {
      context.assertOwned();
      return true;
    } catch (error) {
      if (!(error instanceof LeaseLostError)) {
        throw error;
      }
      this.logJobLeaseLost(job, phase, interactionRunId);
      return false;
    }
  }

  private createMetricsSink(
    jobStore: StorageHelpers["stores"]["interactionJobs"],
    context: JobClaimContext,
    input: {
      interactionRunId: string;
      triggerKind: string | null;
      promptMode: string | null;
      promptContextChangedFiles: number;
      promptContextPriorDiscussions: number;
      promptContextComments: number;
    },
  ): (envelope: HarnessSessionMetricsEnvelope) => Promise<void> {
    return async (envelope) => {
      const metrics = envelope.metrics;
      const saved = await jobStore.upsertInteractionRunMetricsForClaim({
        jobId: context.jobId,
        claimToken: context.claimToken,
        interactionRunId: input.interactionRunId,
        metrics: {
          interactionRunId: input.interactionRunId,
          harness: envelope.harness,
          harnessSessionKey: envelope.harnessSessionKey,
          sessionType: envelope.sessionType,
          triggerKind: input.triggerKind,
          promptMode: input.promptMode,
          promptChars: metrics.promptChars,
          promptContextChangedFiles: input.promptContextChangedFiles,
          promptContextPriorDiscussions: input.promptContextPriorDiscussions,
          promptContextComments: input.promptContextComments,
          assistantTurns: metrics.assistantTurns,
          assistantCalls: metrics.assistantCalls,
          toolExecutions: metrics.toolExecutions,
          viewToolCalls: metrics.viewToolCalls,
          globToolCalls: metrics.globToolCalls,
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          cacheReadTokens: metrics.cacheReadTokens,
          cacheWriteTokens: metrics.cacheWriteTokens,
          reasoningTokens: metrics.reasoningTokens,
          apiDurationMs: metrics.apiDurationMs,
          usageUnit: metrics.usageUnit,
          usageAmount: metrics.usageAmount,
          usageByModelJson: JSON.stringify(metrics.usageByModel),
          repeatedViewReads: metrics.repeatedViewReads,
          repeatedViewPathsJson: JSON.stringify(metrics.repeatedViewPaths),
        },
      });
      if (!saved) {
        throw new LeaseLostError();
      }
    };
  }

  private async loadRoutingContext(input: {
    runtime: PlatformReviewRuntime;
    job: InteractionJobRecord;
  }): Promise<PlatformReviewRoutingContext> {
    return input.runtime.loadRoutingContext(input.job);
  }

  private createTriggerLifecycle(
    platform: IPlatform,
    resolvedTenant: ResolvedTenant,
    job: InteractionJobRecord,
  ): PlatformTriggerLifecycle {
    if (getReviewPublicationMode(job.triggerJson) === "no-publish") {
      return new NoOpPlatformTriggerLifecycle();
    }
    return platform.createTriggerLifecycle({
      resolvedTenant,
      job,
      logger: this.logger,
    });
  }

  private async hydrateContext(input: {
    runtime: PlatformReviewRuntime;
    job: InteractionJobRecord;
    context: PlatformReviewRoutingContext;
  }): Promise<PlatformReviewRoutingContext> {
    return input.runtime.hydrate({
      job: input.job,
      context: input.context,
    });
  }

  private resolvePlatform(platformSlug: string): IPlatform {
    return (
      this.platformResolver(platformSlug) ??
      (() => {
        throw new Error(`Unknown platform ${platformSlug}`);
      })()
    );
  }

  private buildHarnessTenantContext(input: {
    platform: IPlatform;
    tenant: TenantRecord;
    connection: ResolvedTenant["connection"];
    interactionRunId: string;
    interactionJobId: string;
    runDirectory: string;
    memoryEnabled: boolean;
    platformWritesEnabled: boolean;
    onMetrics?:
      ((metrics: HarnessSessionMetricsEnvelope) => Promise<void>) | undefined;
  }) {
    return input.platform.buildHarnessTenantContext({
      resolvedTenant: {
        tenant: input.tenant,
        connection: input.connection,
      },
      // Project-memory writes are intentionally outside v005 claim fencing.
      // The surrounding session is checked before and after, but an in-flight
      // memory update may finish after lease loss.
      storage: this.storage,
      logger: this.logger,
      memoryEnabled: input.memoryEnabled,
      platformWritesEnabled: input.platformWritesEnabled,
      logging: {
        interactionRunId: input.interactionRunId,
        interactionJobId: input.interactionJobId,
        tenantId: input.tenant.id,
        runDirectory: input.runDirectory,
        onMetrics: input.onMetrics,
      },
    });
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

function isNonRetryableReviewError(error: unknown): boolean {
  return (
    error instanceof ModelProfileConfigurationError ||
    error instanceof AbandonedReviewError
  );
}

class AbandonedReviewError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AbandonedReviewError";
  }
}
