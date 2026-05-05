import type { Logger } from "pino";
import { join } from "node:path";

import { isBotUser } from "../gitlab/bot-user.js";
import { GitLabClient } from "../gitlab/client.js";
import type { GitLabNoteHookPayload, MaterializedWorkspace, TriggerNoteReference } from "../gitlab/types.js";
import { parseGitLabNoteHook } from "../gitlab/webhook.js";
import { extractWebhookHeadSha } from "../gitlab/webhook.js";
import type { MergeRequestContextHydrator } from "../gitlab/hydrator.js";
import type { WorkspaceMaterializer } from "../gitlab/workspace.js";
import { buildProviderThreads, type ReconcileSummary, DiscussionReconciler } from "../reconcile/discussion-reconciler.js";
import { HarnessChatterRunnerFactory } from "../review/harness-chatter.js";
import { buildInteractionPlan } from "../review/interaction-plan.js";
import { readHarnessRunMetrics } from "../harness/run-metrics.js";
import { ModelProfileConfigurationError, resolveReviewProviderConfig } from "../review/model-profiles.js";
import type { ReviewProviderFactory } from "../review/provider.js";
import { InteractionRunArtifacts } from "../review/run-artifacts.js";
import { buildScopedReviewContext } from "../review/review-scope.js";
import { buildReviewTriggerContext, classifyWebhookTrigger, locateTriggerNoteReference } from "../review/trigger.js";
import type { ChatterBatchResult, ResponseTarget, ReviewContext, ReviewResult, WebhookReviewTrigger } from "../review/types.js";
import type {
  CreateReviewFindingInput,
  DiscussionMappingRecord,
  InteractionJobRecord,
  PreviousCompletedInteractionRecord,
  Storage,
  TenantRecord
} from "../storage/types.js";
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
  chatterRunnerFactory: HarnessChatterRunnerFactory;
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
  private readonly chatterRunnerFactory: HarnessChatterRunnerFactory;
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
    this.chatterRunnerFactory = options.chatterRunnerFactory;
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
    const workspacesToCleanup: MaterializedWorkspace[] = [];
    let metricsContext: {
      sessionLogPath: string;
      triggerKind: string | null;
      promptMode: string | null;
      promptContextChangedFiles: number;
      promptContextPriorThreads: number;
      promptContextNotes: number;
    } | null = null;
    let client: GitLabClient | null = null;
    let triggerNote: TriggerNoteReference | null = null;

    try {
      client = this.createGitLabClient(tenant, job.id);
      const parsedPayload = parseGitLabNoteHook(JSON.parse(job.payloadJson));
      let routingContext = await this.hydrator.loadRoutingContext({
        tenant,
        job,
        client
      });
      workspacesToCleanup.push(routingContext.workspace);
      triggerNote = locateTriggerNoteReference(routingContext.discussions, job.noteId);

      const resolvedProviderConfig = await resolveReviewProviderConfig({
        storage: this.storage,
        tenant,
        mergeRequest: routingContext.mergeRequest
      });
      const reviewProvider = this.reviewProviderFactory.createProvider(resolvedProviderConfig);
      const chatterRunner = this.chatterRunnerFactory.createRunner(resolvedProviderConfig);
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

      await this.logRunEvent(runArtifacts, "info", "lightweight routing context loaded", {
        interactionJobId: job.id,
        mergeRequestIid: job.mergeRequestIid,
        changedFiles: routingContext.changes.length,
        noteCount: routingContext.notes.length,
        discussionCount: routingContext.discussions.length,
        workspaceStrategy: routingContext.workspace.strategy
      });

      const mappings = await this.storage.listDiscussionMappings(tenant.id, routingContext.mergeRequest.iid);
      const priorThreads = buildProviderThreads({
        tenant,
        discussions: routingContext.discussions,
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
        discussions: routingContext.discussions,
        priorThreads
      });
      const previousInteraction = await this.storage.getLatestCompletedInteractionForMergeRequest(
        tenant.id,
        routingContext.mergeRequest.iid,
        job.id
      );
      const priorFindings = await this.storage.listPriorReviewFindings(tenant.id, routingContext.mergeRequest.iid, job.id);
      let chatterContext = this.buildPromptContext({
        interactionRunId: interactionRun.id,
        tenant,
        job,
        runArtifacts,
        trigger,
        context: routingContext,
        mappings,
        priorFindings,
        previousInteraction
      });
      const interactionPlan = buildInteractionPlan({
        trigger,
        previousReviewExists: previousInteraction !== null,
        priorFindings
      });

      await runArtifacts.writeJsonArtifact(join("orchestration", "plan.json"), interactionPlan);
      await this.logRunEvent(runArtifacts, "info", "interaction plan created", {
        interactionRunId: interactionRun.id,
        triggerKind: trigger.kind,
        reviewNeeded: interactionPlan.reviewNeeded,
        replyNeeded: interactionPlan.replyNeeded,
        memoryCandidate: interactionPlan.memoryCandidate,
        responseTargetCount: interactionPlan.responseTargets.length,
        rerunReason: interactionPlan.rerunReason
      });

      const harnessTenantContext = {
        id: tenant.id,
        baseUrl: tenant.baseUrl,
        projectId: tenant.projectId,
        apiToken: tenant.apiToken,
        memoryEnabled: routingContext.projectMemory.enabled
      };

      if (interactionPlan.memoryCandidate) {
        const memoryResult = await chatterRunner.run(
          {
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
              runDirectory: runArtifacts.runDirectory
            }
          },
          {
            tenant: harnessTenantContext
          }
        );
        await runArtifacts.writeJsonArtifact(join("orchestration", "memory-result.json"), memoryResult);
        metricsContext = {
          sessionLogPath: runArtifacts.getCopilotSessionLogPath(chatterRunner.sessionPaths.memory),
          triggerKind: trigger.kind,
          promptMode: "memory",
          promptContextChangedFiles: chatterContext.changes.length,
          promptContextPriorThreads: chatterContext.priorThreads.length,
          promptContextNotes: chatterContext.notes.length
        };

        routingContext = await this.hydrator.loadRoutingContext({
          tenant,
          job,
          client
        });
        workspacesToCleanup.push(routingContext.workspace);
        chatterContext = this.buildPromptContext({
          interactionRunId: interactionRun.id,
          tenant,
          job,
          runArtifacts,
          trigger,
          context: routingContext,
          mappings,
          priorFindings,
          previousInteraction
        });
      }

      let reviewResult: ReviewResult | null = null;
      let reviewContext: ReviewContext | null = null;
      let reconcileSummary: ReconcileSummary | null = null;

      if (interactionPlan.reviewNeeded) {
        const hydratedContext = await this.hydrator.hydrate({
          tenant,
          job,
          client,
          context: routingContext
        });
        workspacesToCleanup.push(hydratedContext.workspace);
        reviewContext = this.buildPromptContext({
          interactionRunId: interactionRun.id,
          tenant,
          job,
          runArtifacts,
          trigger,
          context: hydratedContext,
          mappings,
          priorFindings,
          previousInteraction
        });

        await this.logRunEvent(runArtifacts, "info", "starting reviewer session", {
          interactionRunId: interactionRun.id,
          workspacePath: hydratedContext.workspace.rootPath,
          changedFiles: hydratedContext.changes.length,
          promptMode: reviewContext.scope.mode,
          triggerKind: reviewContext.trigger.kind,
          promptContextChangedFiles: reviewContext.changes.length
        });

        reviewResult = await reviewProvider.review(reviewContext, {
          tenant: {
            ...harnessTenantContext,
            memoryEnabled: hydratedContext.projectMemory.enabled
          }
        });
        await runArtifacts.writeJsonArtifact(join("orchestration", "review-result.json"), reviewResult);

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

        reconcileSummary = await this.reconciler.reconcile({
          tenant,
          context: hydratedContext,
          mappings,
          interactionRunId: interactionRun.id,
          reviewResult,
          client
        });

        metricsContext = {
          sessionLogPath: runArtifacts.getCopilotSessionLogPath(["copilot", "reviewer"]),
          triggerKind: reviewContext.trigger.kind,
          promptMode: reviewContext.scope.mode,
          promptContextChangedFiles: reviewContext.changes.length,
          promptContextPriorThreads: reviewContext.priorThreads.length,
          promptContextNotes: reviewContext.notes.length
        };

        await this.logRunEvent(runArtifacts, "info", "reconciled review result into GitLab", {
          interactionRunId: interactionRun.id,
          summary: reconcileSummary
        });
      }

      if (interactionPlan.replyNeeded) {
        const replyResult = await chatterRunner.run(
          {
            trigger,
            responseTargets: interactionPlan.responseTargets,
            projectMemory: reviewContext?.projectMemory ?? chatterContext.projectMemory,
            replyStyle: interactionPlan.replyStyle,
            phase: "reply",
            reviewContext: reviewContext ?? chatterContext,
            reviewerReplyHandoff: reviewResult?.replyHandoff ?? null,
            reviewResult,
            logging: {
              interactionRunId: interactionRun.id,
              interactionJobId: job.id,
              tenantId: tenant.id,
              runDirectory: runArtifacts.runDirectory
            }
          },
          {
            tenant: {
              ...harnessTenantContext,
              memoryEnabled: reviewContext?.projectMemory.enabled ?? routingContext.projectMemory.enabled
            }
          }
        );
        await runArtifacts.writeJsonArtifact(join("orchestration", "reply-result.json"), replyResult);

        const publishOutcomes = await this.publishChatterReplies({
          tenant,
          mergeRequestIid: routingContext.mergeRequest.iid,
          client,
          result: replyResult,
          plannedTargets: interactionPlan.responseTargets
        });
        await runArtifacts.writeJsonArtifact(join("orchestration", "reply-publish-outcomes.json"), publishOutcomes);
        const failedPublishOutcomes = publishOutcomes.filter((outcome) => outcome.status === "failed");
        if (failedPublishOutcomes.length > 0) {
          await this.logRunEvent(runArtifacts, "warn", "some chatter replies failed to publish", {
            interactionRunId: interactionRun.id,
            failedReplyCount: failedPublishOutcomes.length,
            publishedReplyCount: publishOutcomes.length - failedPublishOutcomes.length,
            publishOutcomes
          });
        }

        metricsContext = {
          sessionLogPath: runArtifacts.getCopilotSessionLogPath(chatterRunner.sessionPaths.reply),
          triggerKind: trigger.kind,
          promptMode: "reply",
          promptContextChangedFiles: reviewContext?.changes.length ?? chatterContext.changes.length,
          promptContextPriorThreads: reviewContext?.priorThreads.length ?? chatterContext.priorThreads.length,
          promptContextNotes: reviewContext?.notes.length ?? chatterContext.notes.length
        };
      }

      await this.storage.completeInteractionRun(interactionRun.id, reviewResult ? JSON.stringify(reviewResult) : null);
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
      if (interactionRunId && runArtifacts && metricsContext) {
        await this.persistInteractionRunMetrics({
          interactionRunId,
          ...metricsContext
        });
      }

      for (const workspace of Array.from(new Map(workspacesToCleanup.map((entry) => [entry.cleanupRoot, entry])).values()).reverse()) {
        try {
          await this.workspaceMaterializer.cleanup(workspace);
        } catch (error) {
          if (runArtifacts) {
            await this.logRunEvent(runArtifacts, "warn", "workspace cleanup failed after interaction completion", {
              interactionJobId: job.id,
              cleanupRoot: workspace.cleanupRoot,
              error: serializeError(error)
            });
          }
          this.logger.warn(
            {
              err: error,
              interactionJobId: job.id,
              cleanupRoot: workspace.cleanupRoot
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

  private buildPromptContext(input: {
    interactionRunId: string;
    tenant: TenantRecord;
    job: InteractionJobRecord;
    runArtifacts: InteractionRunArtifacts;
    trigger: ReviewContext["trigger"];
    context: Pick<
      Awaited<ReturnType<MergeRequestContextHydrator["hydrate"]>>,
      "workspace" | "mergeRequest" | "changes" | "notes" | "discussions" | "projectMemory"
    >;
    mappings: DiscussionMappingRecord[];
    priorFindings: Awaited<ReturnType<Storage["listPriorReviewFindings"]>>;
    previousInteraction: PreviousCompletedInteractionRecord | null;
  }): ReviewContext {
    return buildScopedReviewContext({
      workspacePath: input.context.workspace.rootPath,
      mergeRequest: input.context.mergeRequest,
      changes: input.context.changes,
      notes: input.context.notes,
      discussions: input.context.discussions,
      instructionFiles: input.context.workspace.instructionFiles,
      projectMemory: input.context.projectMemory,
      trigger: input.trigger,
      priorThreads: buildProviderThreads({
        tenant: input.tenant,
        discussions: input.context.discussions,
        mappings: input.mappings
      }),
      priorFindings: input.priorFindings.map((finding) => ({
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
      previousReview: input.previousInteraction
        ? {
            reviewRunId: input.previousInteraction.interactionRunId,
            finishedAt: input.previousInteraction.finishedAt,
            headSha: input.previousInteraction.headSha,
            resultJson: input.previousInteraction.resultJson,
            changesJson: input.previousInteraction.snapshot.changesJson
          }
        : null,
      logging: {
        interactionRunId: input.interactionRunId,
        interactionJobId: input.job.id,
        tenantId: input.tenant.id,
        runDirectory: input.runArtifacts.runDirectory
      }
    });
  }

  private async publishChatterReplies(input: {
    tenant: TenantRecord;
    mergeRequestIid: number;
    client: GitLabClient;
    result: ChatterBatchResult;
    plannedTargets: ResponseTarget[];
  }): Promise<
    Array<{
      target: ResponseTarget;
      status: "published" | "failed";
      noteId?: number | undefined;
      error?: string | undefined;
    }>
  > {
    const plannedTargetKeySet = new Set(input.plannedTargets.map((target) => this.responseTargetKey(target)));
    const outcomes: Array<{
      target: ResponseTarget;
      status: "published" | "failed";
      noteId?: number | undefined;
      error?: string | undefined;
    }> = [];
    for (const reply of input.result.replies) {
      const matchingTarget =
        input.plannedTargets.find((target) => this.responseTargetKey(target) === this.responseTargetKey(reply.target)) ?? null;
      if (!matchingTarget || !plannedTargetKeySet.has(this.responseTargetKey(matchingTarget))) {
        continue;
      }

      try {
        const published =
          matchingTarget.discussionId
            ? await input.client.replyToDiscussion(
                input.tenant.projectId,
                input.mergeRequestIid,
                matchingTarget.discussionId,
                reply.replyBody
              )
            : await input.client.createMergeRequestNote(input.tenant.projectId, input.mergeRequestIid, reply.replyBody);
        outcomes.push({
          target: matchingTarget,
          status: "published",
          noteId: published.id
        });
      } catch (error) {
        outcomes.push({
          target: matchingTarget,
          status: "failed",
          error: getErrorMessage(error)
        });
      }
    }

    return outcomes;
  }

  private responseTargetKey(target: Pick<ResponseTarget, "kind" | "noteId" | "discussionId">): string {
    return `${target.kind}::${target.noteId}::${target.discussionId ?? ""}`;
  }

  private async persistInteractionRunMetrics(
    input: {
      interactionRunId: string;
      sessionLogPath: string;
      triggerKind: string | null;
      promptMode: string | null;
      promptContextChangedFiles: number;
      promptContextPriorThreads: number;
      promptContextNotes: number;
    }
  ): Promise<void> {
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
        promptContextPriorThreads: input.promptContextPriorThreads,
        promptContextNotes: input.promptContextNotes,
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
      this.logger.warn({ err: error, interactionRunId: input.interactionRunId }, "failed to persist interaction run metrics");
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
