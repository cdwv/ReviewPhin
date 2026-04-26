import type { Logger } from "pino";

import { isBotUser } from "../gitlab/bot-user.js";
import { GitLabClient } from "../gitlab/client.js";
import type { GitLabNoteHookPayload } from "../gitlab/types.js";
import { parseGitLabNoteHook } from "../gitlab/webhook.js";
import { extractWebhookHeadSha } from "../gitlab/webhook.js";
import type { MergeRequestContextHydrator } from "../gitlab/hydrator.js";
import type { WorkspaceMaterializer } from "../gitlab/workspace.js";
import { buildProviderThreads, type ReconcileSummary, DiscussionReconciler } from "../reconcile/discussion-reconciler.js";
import type { ReviewProvider } from "../review/provider.js";
import { buildReviewTriggerContext, isFollowUpInstructionWebhook } from "../review/trigger.js";
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
    this.maxJobRetries = options.maxJobRetries;
    this.retryBackoffMs = options.retryBackoffMs;
  }

  public async createReviewJobFromWebhook(payload: GitLabNoteHookPayload, tenant: TenantRecord): Promise<{
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
        headSha
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
        createdJob.job.noteId,
        REVIEW_STARTED_REACTION,
        createdJob.job.id
      );
    }

    return createdJob;
  }

  public async shouldHandleFollowUpWebhook(payload: GitLabNoteHookPayload, tenant: TenantRecord): Promise<boolean> {
    const client = this.createGitLabClient(tenant, `webhook-note-${payload.object_attributes.id}`);
    return isFollowUpInstructionWebhook({
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
    let workspaceToCleanup: Awaited<ReturnType<MergeRequestContextHydrator["hydrate"]>>["workspace"] | null = null;

    try {
      const client = this.createGitLabClient(tenant, job.id);
      await this.ensureTriggerNoteReaction(
        client,
        tenant,
        job.mergeRequestIid,
        job.noteId,
        REVIEW_STARTED_REACTION,
        job.id
      );

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
      const trigger = buildReviewTriggerContext({
        payload: parseGitLabNoteHook(JSON.parse(job.payloadJson)),
        priorThreads
      });
      const reviewRun = await this.storage.createReviewRun({
        reviewJobId: job.id,
        tenantId: tenant.id,
        provider: this.reviewProvider.name,
        model: this.reviewProvider.name === "copilot-sdk" ? null : null
      });
      reviewRunId = reviewRun.id;

      const reviewResult = await this.reviewProvider.review({
        workspacePath: context.workspace.rootPath,
        mergeRequest: context.mergeRequest,
        changes: context.changes,
        notes: context.notes,
        discussions: context.discussions,
        instructionFiles: context.workspace.instructionFiles,
        trigger,
        logging: {
          reviewRunId: reviewRun.id,
          jobId: job.id,
          tenantId: tenant.id
        },
        priorThreads
      });

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

      await this.storage.markJobCompleted(job.id);
      await this.ensureTriggerNoteReaction(
        client,
        tenant,
        job.mergeRequestIid,
        job.noteId,
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
      if (workspaceToCleanup) {
        try {
          await this.workspaceMaterializer.cleanup(workspaceToCleanup);
        } catch (error) {
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

  private createGitLabClient(tenant: TenantRecord, jobId: string): GitLabClient {
    return new GitLabClient({
      baseUrl: tenant.baseUrl,
      apiToken: tenant.apiToken,
      logger: this.logger.child({ tenantId: tenant.id, jobId })
    });
  }

  private async ensureTriggerNoteReaction(
    client: GitLabClient,
    tenant: TenantRecord,
    mergeRequestIid: number,
    noteId: number,
    reactionName: string,
    jobId: string
  ): Promise<void> {
    try {
      const existing = await client.listMergeRequestNoteAwardEmojis(tenant.projectId, mergeRequestIid, noteId);
      const hasReaction = existing.some((award) => award.name === reactionName && isBotUser(award.user, tenant));
      if (hasReaction) {
        return;
      }

      await client.createMergeRequestNoteAwardEmoji(tenant.projectId, mergeRequestIid, noteId, reactionName);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          tenantId: tenant.id,
          jobId,
          mergeRequestIid,
          noteId,
          reactionName
        },
        "failed to synchronize review reaction"
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
