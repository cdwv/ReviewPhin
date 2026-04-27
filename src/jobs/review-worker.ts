import type { Logger } from "pino";

import { isBotUser } from "../gitlab/bot-user.js";
import { GitLabClient } from "../gitlab/client.js";
import type { GitLabNoteHookPayload, TriggerNoteReference } from "../gitlab/types.js";
import { parseGitLabNoteHook } from "../gitlab/webhook.js";
import { extractWebhookHeadSha } from "../gitlab/webhook.js";
import type { MergeRequestContextHydrator } from "../gitlab/hydrator.js";
import type { WorkspaceMaterializer } from "../gitlab/workspace.js";
import { buildProviderThreads, type ReconcileSummary, DiscussionReconciler } from "../reconcile/discussion-reconciler.js";
import { readCopilotRunMetrics } from "../review/copilot-run-metrics.js";
import type { ReviewProvider } from "../review/provider.js";
import { ReviewRunArtifacts } from "../review/run-artifacts.js";
import { buildScopedReviewContext } from "../review/review-scope.js";
import { buildReviewTriggerContext, classifyWebhookTrigger, locateTriggerNoteReference } from "../review/trigger.js";
import type { ReviewContext, WebhookReviewTrigger } from "../review/types.js";
import type { CreateReviewFindingInput, ReviewJobRecord, Storage, TenantRecord } from "../storage/types.js";
import type { TenantRegistry } from "../tenants/tenant-registry.js";
import { createReviewJobDedupeKey, createFindingFingerprint, createFindingIdentityKey } from "../utils/ids.js";

const REVIEW_STARTED_REACTION = "eyes";
const REVIEW_COMPLETED_REACTION = "white_check_mark";

interface ReviewWorkerOptions {
  storage: Storage;
  tenantRegistry: TenantRegistry;
  hydrator: MergeRequestContextHydrator;
  workspaceMaterializer: WorkspaceMaterializer;
  reviewProvider: ReviewProvider;
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
  private readonly reviewProvider: ReviewProvider;
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
    this.reviewProvider = options.reviewProvider;
    this.reconciler = options.reconciler;
    this.logger = options.logger;
    this.runLogDir = options.runLogDir;
    this.maxJobRetries = options.maxJobRetries;
    this.retryBackoffMs = options.retryBackoffMs;
  }

  public async createReviewJobFromWebhook(
    payload: GitLabNoteHookPayload,
    tenant: TenantRecord,
    trigger: WebhookReviewTrigger
  ): Promise<{
    job: ReviewJobRecord;
    created: boolean;
  }> {
    const headSha = extractWebhookHeadSha(payload);
    const createdJob = await this.storage.createOrGetReviewJob({
      tenantId: tenant.id,
      dedupeKey: createReviewJobDedupeKey({
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
    const job = await this.storage.getReviewJobById(jobId);
    if (!job) {
      this.logger.warn({ jobId }, "review job not found");
      return;
    }

    const tenant = await this.tenantRegistry.getTenantById(job.tenantId);
    if (!tenant) {
      throw new Error(`Unknown tenant ${job.tenantId} for job ${job.id}`);
    }

    await this.storage.markJobInProgress(job.id);

    let reviewRunId: string | null = null;
    let runArtifacts: ReviewRunArtifacts | null = null;
    let workspaceToCleanup: Awaited<ReturnType<MergeRequestContextHydrator["hydrate"]>>["workspace"] | null = null;
    let providerContext: ReviewContext | null = null;

    try {
      const reviewRun = await this.storage.createReviewRun({
        reviewJobId: job.id,
        tenantId: tenant.id,
        provider: this.reviewProvider.name,
        model: this.reviewProvider.name === "copilot-sdk" ? null : null
      });
      reviewRunId = reviewRun.id;
      runArtifacts = new ReviewRunArtifacts(this.runLogDir, reviewRun.id);
      await runArtifacts.initialize();

      await this.logRunEvent(runArtifacts, "info", "review run started", {
        jobId: job.id,
        tenantId: tenant.id,
        mergeRequestIid: job.mergeRequestIid
      });

      const client = this.createGitLabClient(tenant, job.id, reviewRun.id, runArtifacts);
      const parsedPayload = parseGitLabNoteHook(JSON.parse(job.payloadJson));

      await this.logRunEvent(runArtifacts, "info", "hydrating merge request context", {
        jobId: job.id,
        mergeRequestIid: job.mergeRequestIid
      });

      const context = await this.hydrator.hydrate({
        tenant,
        job,
        client
      });
      workspaceToCleanup = context.workspace;

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
        locateTriggerNoteReference(context.discussions, job.noteId),
        REVIEW_STARTED_REACTION,
        job.id
      );
      const trigger = buildReviewTriggerContext({
        payload: parsedPayload,
        tenant,
        priorThreads
      });
      const previousReview = await this.storage.getLatestCompletedReviewForMergeRequest(
        tenant.id,
        context.mergeRequest.iid,
        job.id
      );
      providerContext = buildScopedReviewContext({
        workspacePath: context.workspace.rootPath,
        mergeRequest: context.mergeRequest,
        changes: context.changes,
        notes: context.notes,
        discussions: context.discussions,
        instructionFiles: context.workspace.instructionFiles,
        trigger,
        priorThreads,
        previousReview: previousReview
          ? {
              reviewRunId: previousReview.reviewRunId,
              finishedAt: previousReview.finishedAt,
              headSha: previousReview.headSha,
              resultJson: previousReview.resultJson,
              changesJson: previousReview.snapshot.changesJson
            }
          : null,
        logging: {
          reviewRunId: reviewRun.id,
          jobId: job.id,
          tenantId: tenant.id,
          runDirectory: runArtifacts.runDirectory
        }
      });

      await this.logRunEvent(runArtifacts, "info", "starting Copilot review", {
        reviewRunId: reviewRun.id,
        workspacePath: context.workspace.rootPath,
        changedFiles: context.changes.length,
        promptMode: providerContext.scope.mode,
        promptContextChangedFiles: providerContext.changes.length
      });

      const reviewResult = await this.reviewProvider.review(providerContext);

      await this.storage.completeReviewRun(reviewRun.id, JSON.stringify(reviewResult));
      await this.storage.replaceReviewFindings(
        reviewRun.id,
        reviewResult.findings.map((finding): CreateReviewFindingInput => {
          const body = `**${finding.title.trim()}**\n\n${finding.body.trim()}`;
          const identityKey = createFindingIdentityKey({
            title: finding.title,
            category: finding.category,
            path: finding.anchor?.path,
            startLine: finding.anchor?.startLine,
            endLine: finding.anchor?.endLine,
            side: finding.anchor?.side
          });
          return {
            reviewRunId: reviewRun.id,
            identityKey,
            fingerprint: createFindingFingerprint({
              identityKey,
              body,
              suggestionReplacement: finding.suggestion?.replacement
            }),
            severity: finding.severity,
            category: finding.category,
            title: finding.title,
            body: finding.body,
            filePath: finding.anchor?.path ?? null,
            startLine: finding.anchor?.startLine ?? null,
            endLine: finding.anchor?.endLine ?? null,
            side: finding.anchor?.side ?? null,
            suggestionJson: finding.suggestion ? JSON.stringify(finding.suggestion) : null,
            rawJson: JSON.stringify(finding)
          };
        })
      );

      const reconcileSummary = await this.reconciler.reconcile({
        tenant,
        context,
        mappings,
        reviewRunId: reviewRun.id,
        reviewResult,
        client
      });

      await this.logRunEvent(runArtifacts, "info", "reconciled review result into GitLab", {
        reviewRunId: reviewRun.id,
        summary: reconcileSummary
      });

      await this.storage.markJobCompleted(job.id);
      await this.ensureTriggerNoteReaction(
        client,
        tenant,
        job.mergeRequestIid,
        locateTriggerNoteReference(context.discussions, job.noteId),
        REVIEW_COMPLETED_REACTION,
        job.id
      );
      this.logger.info(
        {
          jobId: job.id,
          reviewRunId: reviewRun.id,
          summary: reconcileSummary
        },
        "review job completed"
      );
    } catch (error) {
      if (reviewRunId) {
        await this.storage.failReviewRun(reviewRunId, getErrorMessage(error));
      }

      if (runArtifacts) {
        await this.logRunEvent(runArtifacts, "error", "review job failed", {
          jobId: job.id,
          reviewRunId,
          error: serializeError(error)
        });
      }

      const nextRetryCount = job.retryCount + 1;
      if (nextRetryCount <= this.maxJobRetries) {
        await this.storage.markJobQueued(job.id, nextRetryCount, getErrorMessage(error));
        this.logger.warn(
          {
            err: error,
            jobId: job.id,
            retryCount: nextRetryCount
          },
          "review job failed and will be retried"
        );
        return { requeueAfterMs: this.retryBackoffMs * nextRetryCount };
      }

      await this.storage.markJobFailed(job.id, nextRetryCount, getErrorMessage(error));
      throw error;
    } finally {
      if (reviewRunId && runArtifacts && providerContext) {
        await this.persistReviewRunMetrics(reviewRunId, providerContext, runArtifacts);
      }

      if (workspaceToCleanup) {
        try {
          await this.workspaceMaterializer.cleanup(workspaceToCleanup);
        } catch (error) {
          if (runArtifacts) {
            await this.logRunEvent(runArtifacts, "warn", "workspace cleanup failed after review completion", {
              jobId: job.id,
              cleanupRoot: workspaceToCleanup.cleanupRoot,
              error: serializeError(error)
            });
          }
          this.logger.warn(
            {
              err: error,
              jobId: job.id,
              cleanupRoot: workspaceToCleanup.cleanupRoot
            },
            "workspace cleanup failed after review completion"
          );
        }
      }
    }
  }

  private createGitLabClient(
    tenant: TenantRecord,
    jobId: string,
    reviewRunId?: string,
    runArtifacts?: ReviewRunArtifacts
  ): GitLabClient {
    return new GitLabClient({
      baseUrl: tenant.baseUrl,
      apiToken: tenant.apiToken,
      logger: this.logger.child({
        tenantId: tenant.id,
        jobId,
        ...(reviewRunId ? { reviewRunId } : {})
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
    jobId: string
  ): Promise<void> {
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
          jobId,
          mergeRequestIid,
          note,
          reactionName
        },
        "failed to synchronize review reaction"
      );
    }
  }

  private async logRunEvent(
    runArtifacts: ReviewRunArtifacts,
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

  private async persistReviewRunMetrics(
    reviewRunId: string,
    context: ReviewContext,
    runArtifacts: ReviewRunArtifacts
  ): Promise<void> {
    try {
      const metrics = await readCopilotRunMetrics(runArtifacts.copilotSessionLogPath);
      if (!metrics) {
        return;
      }

      await this.storage.upsertReviewRunMetrics({
        reviewRunId,
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
      this.logger.warn({ err: error, reviewRunId }, "failed to persist review run metrics");
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
