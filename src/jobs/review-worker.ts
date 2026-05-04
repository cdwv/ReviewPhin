import type { Logger } from "pino";

import { isBotUser } from "../gitlab/bot-user.js";
import { GitLabClient } from "../gitlab/client.js";
import type { GitLabNoteHookPayload, TriggerNoteReference } from "../gitlab/types.js";
import { parseGitLabNoteHook } from "../gitlab/webhook.js";
import { extractWebhookHeadSha } from "../gitlab/webhook.js";
import type { MergeRequestContextHydrator } from "../gitlab/hydrator.js";
import type { WorkspaceMaterializer } from "../gitlab/workspace.js";
import { buildProviderThreads, type ReconcileSummary, DiscussionReconciler } from "../reconcile/discussion-reconciler.js";
import { readHarnessRunMetrics } from "../harness/run-metrics.js";
import { ModelProfileConfigurationError, resolveReviewProviderConfig } from "../review/model-profiles.js";
import type { ReviewProviderFactory } from "../review/provider.js";
import { InteractionRunArtifacts } from "../review/run-artifacts.js";
import { buildScopedReviewContext } from "../review/review-scope.js";
import { buildReviewTriggerContext, classifyWebhookTrigger, locateTriggerNoteReference } from "../review/trigger.js";
import type { ReviewContext, WebhookReviewTrigger } from "../review/types.js";
import type { CreateReviewFindingInput, InteractionJobRecord, Storage, TenantRecord } from "../storage/types.js";
import type { TenantRegistry } from "../tenants/tenant-registry.js";
import { createInteractionJobDedupeKey, createFindingIdentityKey } from "../utils/ids.js";

const REVIEW_STARTED_REACTION = "eyes";
const REVIEW_COMPLETED_REACTION = "white_check_mark";
const REVIEW_FAILED_REACTION = "confounded";

interface ReviewWorkerOptions {
  storage: Storage;
  tenantRegistry: TenantRegistry;
  hydrator: MergeRequestContextHydrator;
  workspaceMaterializer: WorkspaceMaterializer;
  reviewProviderFactory: ReviewProviderFactory;
  reconciler: DiscussionReconciler;
  logger: Logger;
  runLogDir: string;
  maxJobRetries: number;
  retryBackoffMs: number;
}

export class ReviewWorker {
  private readonly storage: Storage;
  private readonly tenantRegistry: TenantRegistry;
  private readonly hydrator: MergeRequestContextHydrator;
  private readonly workspaceMaterializer: WorkspaceMaterializer;
  private readonly reviewProviderFactory: ReviewProviderFactory;
  private readonly reconciler: DiscussionReconciler;
  private readonly logger: Logger;
  private readonly runLogDir: string;
  private readonly maxJobRetries: number;
  private readonly retryBackoffMs: number;

  public constructor(options: ReviewWorkerOptions) {
    this.storage = options.storage;
    this.tenantRegistry = options.tenantRegistry;
    this.hydrator = options.hydrator;
    this.workspaceMaterializer = options.workspaceMaterializer;
    this.reviewProviderFactory = options.reviewProviderFactory;
    this.reconciler = options.reconciler;
    this.logger = options.logger;
    this.runLogDir = options.runLogDir;
    this.maxJobRetries = options.maxJobRetries;
    this.retryBackoffMs = options.retryBackoffMs;
  }

  public async createInteractionJobFromWebhook(
    payload: GitLabNoteHookPayload,
    tenant: TenantRecord,
    trigger: WebhookReviewTrigger
  ): Promise<{
    job: InteractionJobRecord;
    created: boolean;
  }> {
    const headSha = extractWebhookHeadSha(payload);
    const createdJob = await this.storage.createOrGetInteractionJob({
      tenantId: tenant.id,
      dedupeKey: createInteractionJobDedupeKey({
        baseUrl: tenant.baseUrl,
        projectId: tenant.projectId,
        mergeRequestIid: payload.merge_request.iid,
        noteId: payload.object_attributes.id,
        noteAction: payload.object_attributes.action,
        noteUpdatedAt: payload.object_attributes.updated_at,
        noteBody: payload.object_attributes.note
      }),
      projectId: tenant.projectId,
      mergeRequestIid: payload.merge_request.iid,
      noteId: payload.object_attributes.id,
      headSha,
      payloadJson: JSON.stringify(payload)
    });

    if (createdJob.created) {
      const client = this.createGitLabClient(tenant, createdJob.job.id);
      await this.ensureTriggerNoteReaction(
        client,
        tenant,
        createdJob.job.mergeRequestIid,
        trigger.note,
        REVIEW_STARTED_REACTION,
        createdJob.job.id
      );
    }

    return createdJob;
  }

  public async classifyWebhookTrigger(
    payload: GitLabNoteHookPayload,
    tenant: TenantRecord
  ): Promise<WebhookReviewTrigger | null> {
    const client = this.createGitLabClient(tenant, `webhook-note-${payload.object_attributes.id}`);
    return classifyWebhookTrigger({
      payload,
      tenant,
      client
    });
  }

  public async processJob(jobId: string): Promise<{ requeueAfterMs?: number } | void> {
    const job = await this.storage.getInteractionJobById(jobId);
    if (!job) {
      this.logger.warn({ interactionJobId: jobId }, "interaction job not found");
      return;
    }

    const tenant = await this.tenantRegistry.getTenantById(job.tenantId);
    if (!tenant) {
      throw new Error(`Unknown tenant ${job.tenantId} for job ${job.id}`);
    }

    await this.storage.markJobInProgress(job.id);

    let interactionRunId: string | null = null;
    let runArtifacts: InteractionRunArtifacts | null = null;
    let workspaceToCleanup: Awaited<ReturnType<MergeRequestContextHydrator["hydrate"]>>["workspace"] | null = null;
    let providerContext: ReviewContext | null = null;
    let client: GitLabClient | null = null;
    let triggerNote: TriggerNoteReference | null = null;

    try {
      client = this.createGitLabClient(tenant, job.id);
      const parsedPayload = parseGitLabNoteHook(JSON.parse(job.payloadJson));

      const context = await this.hydrator.hydrate({
        tenant,
        job,
        client
      });
      workspaceToCleanup = context.workspace;
      triggerNote = locateTriggerNoteReference(context.discussions, job.noteId);
      const resolvedProviderConfig = await resolveReviewProviderConfig({
        storage: this.storage,
        tenant,
        mergeRequest: context.mergeRequest
      });
      const reviewProvider = this.reviewProviderFactory.createProvider(resolvedProviderConfig);
      const interactionRun = await this.storage.createInteractionRun({
        interactionJobId: job.id,
        tenantId: tenant.id,
        provider: reviewProvider.name,
        model: resolvedProviderConfig.reviewModel,
        modelProfileName: resolvedProviderConfig.modelProfileName,
        providerBaseUrl: resolvedProviderConfig.providerBaseUrl,
        providerType: resolvedProviderConfig.providerType,
        textGenerationModel: resolvedProviderConfig.textGenerationModel
      });
      interactionRunId = interactionRun.id;
      runArtifacts = new InteractionRunArtifacts(this.runLogDir, interactionRun.id);
      await runArtifacts.initialize();
      client = this.createGitLabClient(tenant, job.id, interactionRun.id, runArtifacts);

      await this.logRunEvent(runArtifacts, "info", "interaction run started", {
        interactionJobId: job.id,
        tenantId: tenant.id,
        mergeRequestIid: job.mergeRequestIid,
        modelProfileName: resolvedProviderConfig.modelProfileName,
        selectionSource: resolvedProviderConfig.selectionSource,
        reviewModel: resolvedProviderConfig.reviewModel,
        textGenerationModel: resolvedProviderConfig.textGenerationModel,
        providerBaseUrl: resolvedProviderConfig.providerBaseUrl,
        providerType: resolvedProviderConfig.providerType
      });

      await this.logRunEvent(runArtifacts, "info", "merge request context hydrated", {
        interactionJobId: job.id,
        mergeRequestIid: job.mergeRequestIid,
        changedFiles: context.changes.length
      });

      const mappings = await this.storage.listDiscussionMappings(tenant.id, context.mergeRequest.iid);
      const priorThreads = buildProviderThreads({
        tenant,
        discussions: context.discussions,
        mappings
      });
      await this.ensureTriggerNoteReaction(
        client,
        tenant,
        job.mergeRequestIid,
        triggerNote,
        REVIEW_STARTED_REACTION,
        job.id
      );
      const trigger = buildReviewTriggerContext({
        payload: parsedPayload,
        tenant,
        discussions: context.discussions,
        priorThreads
      });
      const previousInteraction = await this.storage.getLatestCompletedInteractionForMergeRequest(
        tenant.id,
        context.mergeRequest.iid,
        job.id
      );
      const priorFindings = await this.storage.listPriorReviewFindings(tenant.id, context.mergeRequest.iid, job.id);
       providerContext = buildScopedReviewContext({
         workspacePath: context.workspace.rootPath,
         mergeRequest: context.mergeRequest,
        changes: context.changes,
        notes: context.notes,
         discussions: context.discussions,
         instructionFiles: context.workspace.instructionFiles,
         projectMemory: context.projectMemory,
         trigger,
        priorThreads,
        priorFindings: priorFindings.map((finding) => ({
          findingId: finding.findingId,
          identityKey: finding.identityKey,
          status: finding.status,
          title: finding.title,
          body: finding.body,
          severity: finding.severity as ReviewContext["scope"]["priorFindings"][number]["severity"],
           category: finding.category as ReviewContext["scope"]["priorFindings"][number]["category"],
           anchor: finding.anchor,
           suggestion: finding.suggestion,
           reviewRunId: finding.interactionRunId,
           reviewedAt: finding.reviewedAt,
           headSha: finding.headSha
         })),
        previousReview: previousInteraction
          ? {
              reviewRunId: previousInteraction.interactionRunId,
              finishedAt: previousInteraction.finishedAt,
              headSha: previousInteraction.headSha,
              resultJson: previousInteraction.resultJson,
              changesJson: previousInteraction.snapshot.changesJson
            }
          : null,
        logging: {
          interactionRunId: interactionRun.id,
          interactionJobId: job.id,
          tenantId: tenant.id,
          runDirectory: runArtifacts.runDirectory
        }
      });

      await this.logRunEvent(runArtifacts, "info", "starting Copilot interaction", {
        interactionRunId: interactionRun.id,
        workspacePath: context.workspace.rootPath,
        changedFiles: context.changes.length,
        promptMode: providerContext.scope.mode,
        promptContextChangedFiles: providerContext.changes.length
      });

      const reviewResult = await reviewProvider.review(providerContext, {
        tenant: {
          id: tenant.id,
          baseUrl: tenant.baseUrl,
          projectId: tenant.projectId,
          apiToken: tenant.apiToken,
          memoryEnabled: context.projectMemory.enabled
        }
      });

      await this.storage.completeInteractionRun(interactionRun.id, JSON.stringify(reviewResult));
      await this.storage.replaceReviewFindings(
        interactionRun.id,
        reviewResult.findings.map((finding): CreateReviewFindingInput => {
          const identityKey = createFindingIdentityKey({
            title: finding.title,
            category: finding.category,
            path: finding.anchor?.path,
            startLine: finding.anchor?.startLine,
            endLine: finding.anchor?.endLine,
            side: finding.anchor?.side
          });
          return {
            interactionRunId: interactionRun.id,
            identityKey,
            severity: finding.severity,
            category: finding.category,
            title: finding.title,
            body: finding.body,
            anchorJson: finding.anchor ? JSON.stringify(finding.anchor) : null,
            suggestionJson: finding.suggestion ? JSON.stringify(finding.suggestion) : null,
            status: "open"
          };
        })
      );

      const reconcileSummary = await this.reconciler.reconcile({
        tenant,
        context,
        mappings,
        interactionRunId: interactionRun.id,
        reviewResult,
        client
      });

      await this.logRunEvent(runArtifacts, "info", "reconciled review result into GitLab", {
        interactionRunId: interactionRun.id,
        summary: reconcileSummary
      });

      await this.storage.markJobCompleted(job.id);
      await this.ensureTriggerNoteReaction(
        client,
        tenant,
        job.mergeRequestIid,
        triggerNote,
        REVIEW_COMPLETED_REACTION,
        job.id
      );
      this.logger.info(
        {
          interactionJobId: job.id,
          interactionRunId: interactionRun.id,
          summary: reconcileSummary
        },
        "interaction job completed"
      );
    } catch (error) {
      if (interactionRunId) {
        await this.storage.failInteractionRun(interactionRunId, getErrorMessage(error));
      }

      if (runArtifacts) {
        await this.logRunEvent(runArtifacts, "error", "interaction job failed", {
          interactionJobId: job.id,
          interactionRunId,
          error: serializeError(error)
        });
      }

      const nextRetryCount = job.retryCount + 1;
      if (!isNonRetryableReviewError(error) && nextRetryCount <= this.maxJobRetries) {
        await this.storage.markJobQueued(job.id, nextRetryCount, getErrorMessage(error));
        this.logger.warn(
          {
            err: error,
            interactionJobId: job.id,
            retryCount: nextRetryCount
          },
          "interaction job failed and will be retried"
        );
        return { requeueAfterMs: this.retryBackoffMs * nextRetryCount };
      }

      await this.storage.markJobFailed(job.id, nextRetryCount, getErrorMessage(error));
      if (client && triggerNote) {
        await this.ensureTriggerNoteReaction(
          client,
          tenant,
          job.mergeRequestIid,
          triggerNote,
          REVIEW_FAILED_REACTION,
          job.id
        );
      }
      throw error;
    } finally {
      if (interactionRunId && runArtifacts && providerContext) {
        await this.persistInteractionRunMetrics(interactionRunId, providerContext, runArtifacts);
      }

      if (workspaceToCleanup) {
        try {
          await this.workspaceMaterializer.cleanup(workspaceToCleanup);
        } catch (error) {
          if (runArtifacts) {
            await this.logRunEvent(runArtifacts, "warn", "workspace cleanup failed after interaction completion", {
              interactionJobId: job.id,
              cleanupRoot: workspaceToCleanup.cleanupRoot,
              error: serializeError(error)
            });
          }
          this.logger.warn(
            {
              err: error,
              interactionJobId: job.id,
              cleanupRoot: workspaceToCleanup.cleanupRoot
            },
            "workspace cleanup failed after interaction completion"
          );
        }
      }
    }
  }

  private createGitLabClient(
    tenant: TenantRecord,
    interactionJobId: string,
    interactionRunId?: string,
    runArtifacts?: InteractionRunArtifacts
  ): GitLabClient {
    return new GitLabClient({
      baseUrl: tenant.baseUrl,
      apiToken: tenant.apiToken,
      logger: this.logger.child({
        tenantId: tenant.id,
        interactionJobId,
        ...(interactionRunId ? { interactionRunId } : {})
      }),
      ...(runArtifacts
        ? {
            requestLogger: {
              log: (entry) => runArtifacts.appendGitLabHttpLog(entry)
            }
          }
        : {})
    });
  }

  private async ensureTriggerNoteReaction(
    client: GitLabClient,
    tenant: TenantRecord,
    mergeRequestIid: number,
    note: TriggerNoteReference,
    reactionName: string,
    interactionJobId: string
  ): Promise<void> {
    if (note.kind === "discussion-note") {
      return;
    }

    try {
      const existing = await client.listTriggerNoteAwardEmojis(tenant.projectId, mergeRequestIid, note);
      const hasReaction = existing.some((award) => award.name === reactionName && isBotUser(award.user, tenant));
      if (hasReaction) {
        return;
      }

      await client.createTriggerNoteAwardEmoji(tenant.projectId, mergeRequestIid, note, reactionName);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          tenantId: tenant.id,
          interactionJobId,
          mergeRequestIid,
          note,
          reactionName
        },
        "failed to synchronize trigger-note reaction"
      );
    }
  }

  private async logRunEvent(
    runArtifacts: InteractionRunArtifacts,
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data: Record<string, unknown>
  ): Promise<void> {
    this.logger[level](data, message);
    try {
      await runArtifacts.appendAppLog({
        timestamp: new Date().toISOString(),
        level,
        message,
        data
      });
    } catch (error) {
      this.logger.warn({ err: error, message }, "failed to persist run app log");
    }
  }

  private async persistInteractionRunMetrics(
    interactionRunId: string,
    context: ReviewContext,
    runArtifacts: InteractionRunArtifacts
  ): Promise<void> {
    try {
      const metrics = await readHarnessRunMetrics(runArtifacts.copilotSessionLogPath);
      if (!metrics) {
        return;
      }

      await this.storage.upsertInteractionRunMetrics({
        interactionRunId,
        triggerKind: context.trigger.kind,
        promptMode: context.scope.mode,
        promptChars: metrics.promptChars,
        promptContextChangedFiles: context.changes.length,
        promptContextPriorThreads: context.priorThreads.length,
        promptContextNotes: context.notes.length,
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
        repeatedViewPathsJson: JSON.stringify(metrics.repeatedViewPaths)
      });
    } catch (error) {
      this.logger.warn({ err: error, interactionRunId }, "failed to persist interaction run metrics");
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
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

function isNonRetryableReviewError(error: unknown): boolean {
  return error instanceof ModelProfileConfigurationError;
}
