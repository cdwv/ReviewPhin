import type { Logger } from "pino";
import { join } from "node:path";

import type {
  IPlatform,
  PlatformMaterializedWorkspace,
  PlatformReviewRoutingContext,
  PlatformReviewRuntime,
  ResolvedTenant,
} from "../platforms/IPlatform.js";
import { getPlatformBySlug } from "../platforms/platform-registry.js";
import type {
  DiscussionReconciler,
  ReconcileSummary,
} from "../reconcile/discussion-reconciler.js";
import type { HarnessChatterRunnerFactory } from "../review/harness-chatter.js";
import { buildInteractionPlan } from "../review/interaction-plan.js";
import { readHarnessRunMetrics } from "../harness/run-metrics.js";
import {
  ModelProfileConfigurationError,
  resolveReviewProviderConfig,
} from "../review/model-profiles.js";
import type { ReviewProviderFactory } from "../review/provider.js";
import { InteractionRunArtifacts } from "../review/run-artifacts.js";
import type {
  ReviewContext,
  ReviewResult,
  WebhookReviewTrigger,
} from "../review/types.js";
import type {
  CreateReviewFindingInput,
  InteractionJobRecord,
  TenantRecord,
} from "../storage/contract/index.js";
import { listAll, type StorageHelpers } from "../storage/storage-helpers.js";
import type { TenantRegistry } from "../tenants/tenant-registry.js";
import { createFindingIdentityKey } from "../utils/ids.js";

interface ReviewRuntimeFactoryInput {
  platform: IPlatform;
  storage: StorageHelpers;
  logger: Logger;
  tenant: TenantRecord;
  connection: ResolvedTenant["connection"];
  interactionJobId: string;
  workspaceRoot: string;
  memoryEnabled: boolean;
  interactionRunId?: string | undefined;
  runArtifacts?: InteractionRunArtifacts | undefined;
}

interface ReviewWorkerOptions {
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
    | ((input: ReviewRuntimeFactoryInput) => PlatformReviewRuntime)
    | undefined;
}

export class ReviewWorker {
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
    const createdJob = await this.storage.createOrGetInteractionJob({
      tenantId: resolvedTenant.tenant.id,
      dedupeKey: interactionJob.dedupeKey,
      codeReviewId: interactionJob.codeReviewId,
      commentId: interactionJob.commentId,
      triggerJson: interactionJob.triggerJson,
      headSha: interactionJob.headSha,
      payloadJson: interactionJob.payloadJson,
    });

    if (createdJob.created) {
      const lifecycle = platform.createTriggerLifecycle({
        resolvedTenant,
        job: createdJob.job,
        logger: this.logger,
      });
      await this.syncTriggerLifecycle(createdJob.job, "queued", () =>
        lifecycle.queued(),
      );
    }

    return createdJob;
  }

  public async classifyWebhookTrigger(
    payload: unknown,
    resolvedTenant: ResolvedTenant,
  ): Promise<WebhookReviewTrigger | null> {
    const platform = this.resolvePlatform(resolvedTenant.tenant.platform);
    return platform.classifyWebhookTrigger(resolvedTenant, payload);
  }

  public async processJob(
    jobId: string,
  ): Promise<{ requeueAfterMs?: number } | void> {
    const job = await this.storage.stores.interactionJobs.get(jobId);
    if (!job) {
      this.logger.warn(
        { interactionJobId: jobId },
        "interaction job not found",
      );
      return;
    }

    const resolvedTenant = await this.tenantRegistry.getResolvedTenantById(
      job.tenantId,
    );
    if (!resolvedTenant) {
      throw new Error(`Unknown tenant ${job.tenantId} for job ${job.id}`);
    }
    const { tenant, connection } = resolvedTenant;
    const platform = this.resolvePlatform(tenant.platform);
    const triggerLifecycle = platform.createTriggerLifecycle({
      resolvedTenant,
      job,
      logger: this.logger,
    });

    await this.storage.markJobInProgress(job.id);
    await this.syncTriggerLifecycle(job, "in_progress", () =>
      triggerLifecycle.inProgress(),
    );

    let interactionRunId: string | null = null;
    let runArtifacts: InteractionRunArtifacts | null = null;
    const workspacesToCleanup: PlatformMaterializedWorkspace[] = [];
    let metricsContext: {
      sessionLogPath: string;
      triggerKind: string | null;
      promptMode: string | null;
      promptContextChangedFiles: number;
      promptContextPriorDiscussions: number;
      promptContextComments: number;
    } | null = null;
    let cleanupWorkspace:
      | ((workspace: PlatformMaterializedWorkspace) => Promise<void>)
      | null = null;

    try {
      const runtime = this.reviewRuntimeFactory({
        platform,
        storage: this.storage,
        logger: this.logger,
        tenant,
        connection,
        interactionJobId: job.id,
        workspaceRoot: this.workspaceRoot,
        memoryEnabled: this.memoryEnabled,
      });
      cleanupWorkspace = (workspace) => runtime.cleanupWorkspace(workspace);
      const parsedPayload = JSON.parse(job.payloadJson) as unknown;
      let routingContext = await this.loadRoutingContext({
        runtime,
        job,
      });
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
      const interactionRun = await this.storage.createInteractionRun({
        interactionJobId: job.id,
        tenantId: tenant.id,
        provider: reviewProvider.name,
        model: resolvedProviderConfig.reviewModel,
        modelProfileName: resolvedProviderConfig.modelProfileName,
        providerBaseUrl: resolvedProviderConfig.providerBaseUrl,
        providerType: resolvedProviderConfig.providerType,
        textGenerationModel: resolvedProviderConfig.textGenerationModel,
      });
      interactionRunId = interactionRun.id;
      runArtifacts = new InteractionRunArtifacts(
        this.runLogDir,
        interactionRun.id,
      );
      await runArtifacts.initialize();
      const runRuntime = this.reviewRuntimeFactory({
        platform,
        storage: this.storage,
        logger: this.logger,
        tenant,
        connection,
        interactionJobId: job.id,
        interactionRunId: interactionRun.id,
        runArtifacts,
        workspaceRoot: this.workspaceRoot,
        memoryEnabled: this.memoryEnabled,
      });
      if (job.commentId !== null) {
        await runRuntime
          .resolveTriggerCommentReference({
            codeReviewId: job.codeReviewId,
            commentId: job.commentId,
            triggerJson: job.triggerJson,
          })
          .catch((error: unknown) => {
            throw new AbandonedReviewError(getErrorMessage(error));
          });
      }

      await this.logRunEvent(runArtifacts, "info", "interaction run started", {
        interactionJobId: job.id,
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
        },
      );

      let mappings = await listAll(this.storage.stores.discussionMappings, {
        filters: {
          tenantId: { eq: tenant.id },
          codeReviewId: { eq: routingContext.codeReviewId },
        },
        order: [{ field: "updatedAt", direction: "desc" }],
      });
      mappings = await runtime.syncDiscussionFindingStatuses({
        tenant,
        codeReviewId: routingContext.codeReviewId,
        context: routingContext,
        mappings,
      });
      const priorDiscussions = runtime.buildProviderDiscussions({
        context: routingContext,
        mappings,
      });
      const trigger = runtime.buildReviewTriggerContext({
        job,
        payload: parsedPayload,
        context: routingContext,
        priorDiscussions,
        mappings,
      });
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
      const interactionPlan = buildInteractionPlan({
        trigger,
        previousReviewExists: previousInteraction !== null,
        priorFindings,
      });

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

      const imageAttachments = await runRuntime.materializeAttachments({
        context: routingContext,
        runArtifacts,
        trigger,
      });
      let chatterContext = runtime.buildPromptContext({
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

      if (interactionPlan.memoryCandidate && trigger.kind !== "manual-review") {
        const memoryResult = await chatterRunner.run(
          {
            attachments: imageAttachments.attachments,
            trigger,
            responseTargets: interactionPlan.responseTargets,
            projectMemory: chatterContext.projectMemory,
            replyStyle: interactionPlan.replyStyle,
            phase: "memory",
            reviewContext: chatterContext,
            logging: {
              interactionRunId: interactionRun.id,
              interactionJobId: job.id,
              tenantId: tenant.id,
              runDirectory: runArtifacts.runDirectory,
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
            }),
          },
        );
        await runArtifacts.writeJsonArtifact(
          join("orchestration", "memory-result.json"),
          memoryResult,
        );
        metricsContext = {
          sessionLogPath: runArtifacts.getCopilotSessionLogPath(
            chatterRunner.sessionPaths.memory,
          ),
          triggerKind: trigger.kind,
          promptMode: "memory",
          promptContextChangedFiles: chatterContext.changes.length,
          promptContextPriorDiscussions: chatterContext.priorDiscussions.length,
          promptContextComments: chatterContext.comments.length,
        };

        routingContext = await this.loadRoutingContext({
          runtime: runRuntime,
          job,
        });
        workspacesToCleanup.push(routingContext.workspace);
        chatterContext = runtime.buildPromptContext({
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
        const hydratedContext = await this.hydrateContext({
          runtime: runRuntime,
          job,
          context: routingContext,
        });
        workspacesToCleanup.push(hydratedContext.workspace);
        mappings = await runRuntime.syncDiscussionFindingStatuses({
          tenant,
          codeReviewId: hydratedContext.codeReviewId,
          context: hydratedContext,
          mappings,
        });
        priorFindings = await this.storage.listPriorReviewFindings(
          tenant.id,
          hydratedContext.codeReviewId,
          job.id,
        );
        reviewContext = runRuntime.buildPromptContext({
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

        reviewResult = await reviewProvider.review(reviewContext, {
          attachments: imageAttachments.attachments,
          tenant: this.buildHarnessTenantContext({
            platform,
            tenant,
            connection,
            interactionRunId: interactionRun.id,
            interactionJobId: job.id,
            runDirectory: runArtifacts.runDirectory,
            memoryEnabled: hydratedContext.projectMemory.enabled,
          }),
        });
        await runArtifacts.writeJsonArtifact(
          join("orchestration", "review-result.json"),
          reviewResult,
        );

        await this.storage.replaceReviewFindings(
          interactionRun.id,
          reviewResult.findings.map((finding): CreateReviewFindingInput => {
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
          }),
        );

        reconcileSummary = await this.reconciler.reconcile({
          platform,
          tenant,
          connection,
          context: hydratedContext.summaryContext,
          mappings,
          interactionJobId: job.id,
          interactionRunId: interactionRun.id,
          reviewResult,
          publicationAdapter: runRuntime.createReviewPublicationAdapter({
            context: hydratedContext,
            interactionRunId: interactionRun.id,
          }),
        });

        metricsContext = {
          sessionLogPath: runArtifacts.getCopilotSessionLogPath([
            "copilot",
            "reviewer",
          ]),
          triggerKind: reviewContext.trigger.kind,
          promptMode: reviewContext.scope.mode,
          promptContextChangedFiles: reviewContext.changes.length,
          promptContextPriorDiscussions: reviewContext.priorDiscussions.length,
          promptContextComments: reviewContext.comments.length,
        };

        await this.logRunEvent(
          runArtifacts,
          "info",
          "reconciled review result into platform discussions",
          {
            interactionRunId: interactionRun.id,
            summary: reconcileSummary,
          },
        );
      }

      if (interactionPlan.replyNeeded && trigger.kind !== "manual-review") {
        const replyResult = await chatterRunner.run(
          {
            attachments: imageAttachments.attachments,
            trigger,
            responseTargets: interactionPlan.responseTargets,
            projectMemory:
              reviewContext?.projectMemory ?? chatterContext.projectMemory,
            replyStyle: interactionPlan.replyStyle,
            phase: "reply",
            reviewContext: reviewContext ?? chatterContext,
            reviewerReplyHandoff: reviewResult?.replyHandoff ?? null,
            reviewResult,
            logging: {
              interactionRunId: interactionRun.id,
              interactionJobId: job.id,
              tenantId: tenant.id,
              runDirectory: runArtifacts.runDirectory,
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
            }),
          },
        );
        await runArtifacts.writeJsonArtifact(
          join("orchestration", "reply-result.json"),
          replyResult,
        );

        const publishOutcomes = await runRuntime.publishChatterReplies({
          codeReviewId: routingContext.codeReviewId,
          result: replyResult,
          plannedTargets: interactionPlan.responseTargets,
        });
        await runArtifacts.writeJsonArtifact(
          join("orchestration", "reply-publish-outcomes.json"),
          publishOutcomes,
        );
        const failedPublishOutcomes = publishOutcomes.filter(
          (outcome) => outcome.status === "failed",
        );
        if (failedPublishOutcomes.length > 0) {
          await this.logRunEvent(
            runArtifacts,
            "warn",
            "some chatter replies failed to publish",
            {
              interactionRunId: interactionRun.id,
              failedReplyCount: failedPublishOutcomes.length,
              publishedReplyCount:
                publishOutcomes.length - failedPublishOutcomes.length,
              publishOutcomes,
            },
          );
        }

        metricsContext = {
          sessionLogPath: runArtifacts.getCopilotSessionLogPath(
            chatterRunner.sessionPaths.reply,
          ),
          triggerKind: trigger.kind,
          promptMode: "reply",
          promptContextChangedFiles:
            reviewContext?.changes.length ?? chatterContext.changes.length,
          promptContextPriorDiscussions:
            reviewContext?.priorDiscussions.length ??
            chatterContext.priorDiscussions.length,
          promptContextComments:
            reviewContext?.comments.length ?? chatterContext.comments.length,
        };
      }

      await this.storage.completeInteractionRun(
        interactionRun.id,
        reviewResult ? JSON.stringify(reviewResult) : null,
      );
      await this.storage.markJobCompleted(job.id);
      await this.syncTriggerLifecycle(job, "completed", () =>
        triggerLifecycle.completed(
          runRuntime.buildTriggerOutcome({
            reviewResult,
            reconcileSummary,
          }),
        ),
      );
      this.logger.info(
        {
          interactionJobId: job.id,
          interactionRunId: interactionRun.id,
          summary: reconcileSummary,
        },
        "interaction job completed",
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const isAbandonedReview = error instanceof AbandonedReviewError;

      if (interactionRunId) {
        if (isAbandonedReview) {
          await this.storage.cancelInteractionRun(
            interactionRunId,
            errorMessage,
          );
        } else {
          await this.storage.failInteractionRun(interactionRunId, errorMessage);
        }
      }

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

      const nextRetryCount = job.retryCount + 1;
      if (isAbandonedReview) {
        await this.storage.markJobCancelled(
          job.id,
          nextRetryCount,
          errorMessage,
        );
        await this.syncTriggerLifecycle(job, "failed", () =>
          triggerLifecycle.failed(errorMessage),
        );
        throw error;
      }

      if (
        !isNonRetryableReviewError(error) &&
        nextRetryCount <= this.maxJobRetries
      ) {
        await this.storage.markJobQueued(job.id, nextRetryCount, errorMessage);
        await this.syncTriggerLifecycle(job, "retry", () =>
          triggerLifecycle.retry(errorMessage),
        );
        this.logger.warn(
          {
            err: error,
            interactionJobId: job.id,
            retryCount: nextRetryCount,
          },
          "interaction job failed and will be retried",
        );
        return { requeueAfterMs: this.retryBackoffMs * nextRetryCount };
      }

      await this.storage.markJobFailed(job.id, nextRetryCount, errorMessage);
      await this.syncTriggerLifecycle(job, "failed", () =>
        triggerLifecycle.failed(errorMessage),
      );
      throw error;
    } finally {
      if (interactionRunId && runArtifacts && metricsContext) {
        await this.persistInteractionRunMetrics({
          interactionRunId,
          ...metricsContext,
        });
      }

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

  private async persistInteractionRunMetrics(input: {
    interactionRunId: string;
    sessionLogPath: string;
    triggerKind: string | null;
    promptMode: string | null;
    promptContextChangedFiles: number;
    promptContextPriorDiscussions: number;
    promptContextComments: number;
  }): Promise<void> {
    try {
      const metrics = await readHarnessRunMetrics(input.sessionLogPath);
      if (!metrics) {
        return;
      }

      await this.storage.upsertInteractionRunMetrics({
        interactionRunId: input.interactionRunId,
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
        premiumRequests: metrics.premiumRequests,
        repeatedViewReads: metrics.repeatedViewReads,
        repeatedViewPathsJson: JSON.stringify(metrics.repeatedViewPaths),
      });
    } catch (error) {
      this.logger.warn(
        { err: error, interactionRunId: input.interactionRunId },
        "failed to persist interaction run metrics",
      );
    }
  }

  private async loadRoutingContext(input: {
    runtime: PlatformReviewRuntime;
    job: InteractionJobRecord;
  }): Promise<PlatformReviewRoutingContext> {
    return input.runtime.loadRoutingContext(input.job);
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
  }) {
    return input.platform.buildHarnessTenantContext({
      resolvedTenant: {
        tenant: input.tenant,
        connection: input.connection,
      },
      storage: this.storage,
      logger: this.logger,
      memoryEnabled: input.memoryEnabled,
      logging: {
        interactionRunId: input.interactionRunId,
        interactionJobId: input.interactionJobId,
        tenantId: input.tenant.id,
        runDirectory: input.runDirectory,
      },
    });
  }

  private async syncTriggerLifecycle(
    job: InteractionJobRecord,
    phase: string,
    update: () => Promise<void>,
  ): Promise<void> {
    try {
      await update();
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          interactionJobId: job.id,
          triggerLifecyclePhase: phase,
        },
        "failed to synchronize provider trigger lifecycle",
      );
    }
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
