import { join } from "node:path";

import type { Logger } from "pino";

import type { HarnessRunAttachments } from "../../harness/types.js";
import type {
  PlatformMaterializedWorkspace,
  PlatformReviewRoutingContext,
  PlatformReviewRuntime,
} from "../IPlatform.js";
import {
  buildProviderThreads,
} from "../../reconcile/discussion-reconciler.js";
import type {
  CodeReviewChange,
  CodeReviewDiscussion,
  CodeReviewItem,
  CodeReviewNote,
  ChatterBatchResult,
  ProviderThreadContext,
  ResponseTarget,
  ReviewContext,
  TriggerNoteReference,
} from "../../review/types.js";
import { buildScopedReviewContext } from "../../review/review-scope.js";
import type { InteractionRunArtifacts } from "../../review/run-artifacts.js";
import type {
  DiscussionMappingRecord,
  InteractionJobRecord,
  PreviousCompletedInteractionRecord,
  TenantRecord,
} from "../../storage/contract/current.js";
import type { StorageHelpers } from "../../storage/storage-helpers.js";
import { isBotUser } from "./bot-user.js";
import { GitLabClient } from "./client.js";
import { CodeReviewContextHydrator } from "./hydrator.js";
import {
  discoverGitLabImageAttachmentReferences,
  materializeGitLabImageAttachments,
} from "./image-attachments.js";
import {
  GitLabReviewDiscussionAdapter,
  toPlatformReviewThread,
} from "./review-discussion-adapter.js";
import { getGitLabTenantConfig } from "./tenant-config.js";
import type {
  GitLabDiscussion,
  GitLabMergeRequest,
  GitLabMergeRequestChange,
  GitLabNote,
  HydratedMergeRequestContext,
  LightweightMergeRequestContext,
  MaterializedWorkspace,
} from "./types.js";
import {
  buildGitLabReviewTriggerContext,
  locateTriggerNoteReference,
} from "./trigger.js";
import { WorkspaceMaterializer } from "./workspace.js";

interface GitLabReviewRuntimeOptions {
  storage: StorageHelpers;
  logger: Logger;
  tenant: TenantRecord;
  interactionJobId: string;
  workspaceRoot: string;
  memoryEnabled: boolean;
  interactionRunId?: string | undefined;
  runArtifacts?: InteractionRunArtifacts | undefined;
}

export class GitLabReviewRuntime implements PlatformReviewRuntime {
  private readonly storage: StorageHelpers;
  private readonly logger: Logger;
  private readonly tenant: TenantRecord;
  private readonly workspaceMaterializer: WorkspaceMaterializer;
  private readonly hydrator: CodeReviewContextHydrator;
  private readonly client: GitLabClient;

  public constructor(options: GitLabReviewRuntimeOptions) {
    this.storage = options.storage;
    this.logger = options.logger;
    this.tenant = options.tenant;
    this.workspaceMaterializer = new WorkspaceMaterializer({
      workspaceRoot: options.workspaceRoot,
      logger: options.logger,
    });
    this.hydrator = new CodeReviewContextHydrator({
      storage: options.storage,
      workspaceMaterializer: this.workspaceMaterializer,
      memoryEnabled: options.memoryEnabled,
      logger: options.logger,
    });
    this.client = this.createGitLabClient({
      logger: options.logger,
      tenant: options.tenant,
      interactionJobId: options.interactionJobId,
      interactionRunId: options.interactionRunId,
      runArtifacts: options.runArtifacts,
    });
  }

  public async loadRoutingContext(
    job: InteractionJobRecord,
  ): Promise<PlatformReviewRoutingContext> {
    const context = await this.hydrator.loadRoutingContext({
      tenant: this.tenant,
      job,
      client: this.client,
    });
    return this.wrapContext(context);
  }

  public async hydrate(input: {
    job: InteractionJobRecord;
    context?: PlatformReviewRoutingContext | undefined;
  }): Promise<PlatformReviewRoutingContext> {
    const context = await this.hydrator.hydrate({
      tenant: this.tenant,
      job: input.job,
      client: this.client,
      context:
        input.context?.platformContext as LightweightMergeRequestContext | undefined,
    });
    return this.wrapContext(context);
  }

  public buildProviderThreads(input: {
    context: PlatformReviewRoutingContext;
    mappings: DiscussionMappingRecord[];
  }) {
    const context = this.unwrapContext(input.context);
    return buildProviderThreads({
      discussions: context.discussions.map((discussion) =>
        toPlatformReviewThread(discussion, this.tenant),
      ),
      mappings: input.mappings,
    });
  }

  public buildReviewTriggerContext(input: {
    payload: unknown;
    context: PlatformReviewRoutingContext;
    priorThreads: ProviderThreadContext[];
  }): ReviewContext["trigger"] {
    const context = this.unwrapContext(input.context);
    return buildGitLabReviewTriggerContext({
      payload: input.payload as never,
      tenant: this.tenant,
      discussions: context.discussions,
      priorThreads: input.priorThreads,
    });
  }

  public locateTriggerNoteReference(input: {
    context: PlatformReviewRoutingContext;
    noteId: number;
  }): TriggerNoteReference {
    return locateTriggerNoteReference(
      this.unwrapContext(input.context).discussions,
      input.noteId,
    );
  }

  public buildPromptContext(input: {
    attachments: ReviewContext["attachments"];
    attachmentIssues: ReviewContext["attachmentIssues"];
    interactionRunId: string;
    tenant: TenantRecord;
    job: InteractionJobRecord;
    runArtifacts: InteractionRunArtifacts;
    trigger: ReviewContext["trigger"];
    context: PlatformReviewRoutingContext;
    mappings: DiscussionMappingRecord[];
    priorFindings: Awaited<ReturnType<StorageHelpers["listPriorReviewFindings"]>>;
    previousInteraction: PreviousCompletedInteractionRecord | null;
  }): ReviewContext {
    const context = this.unwrapContext(input.context);
    return buildScopedReviewContext({
      attachments: input.attachments,
      attachmentIssues: input.attachmentIssues,
      workspacePath: context.workspace.rootPath,
      codeReview: toCodeReviewItem(context.mergeRequest),
      changes: context.changes.map(toCodeReviewChange),
      notes: context.notes.map(toCodeReviewNote),
      discussions: context.discussions.map((discussion) =>
        toCodeReviewDiscussion(discussion, this.tenant),
      ),
      instructionFiles: context.workspace.instructionFiles,
      projectMemory: context.projectMemory,
      trigger: input.trigger,
      priorThreads: buildProviderThreads({
        discussions: context.discussions.map((discussion) =>
          toPlatformReviewThread(discussion, this.tenant),
        ),
        mappings: input.mappings,
      }),
      priorFindings: input.priorFindings.map((finding) => ({
        findingId: finding.findingId,
        identityKey: finding.identityKey,
        status: finding.status,
        title: finding.title,
        body: finding.body,
        severity:
          finding.severity as ReviewContext["scope"]["priorFindings"][number]["severity"],
        category:
          finding.category as ReviewContext["scope"]["priorFindings"][number]["category"],
        anchor: finding.anchor,
        suggestion: finding.suggestion,
        reviewRunId: finding.interactionRunId,
        reviewedAt: finding.reviewedAt,
        headSha: finding.headSha,
      })),
      previousReview: input.previousInteraction
        ? {
            reviewRunId: input.previousInteraction.interactionRunId,
            finishedAt: input.previousInteraction.finishedAt,
            headSha: input.previousInteraction.headSha,
            resultJson: input.previousInteraction.resultJson,
            changesJson: input.previousInteraction.snapshot.changesJson,
          }
        : null,
      logging: {
        interactionRunId: input.interactionRunId,
        interactionJobId: input.job.id,
        tenantId: input.tenant.id,
        runDirectory: input.runArtifacts.runDirectory,
      },
    });
  }

  public async syncDiscussionFindingStatuses(input: {
    tenant: TenantRecord;
    codeReviewId: number;
    context: PlatformReviewRoutingContext;
    mappings: DiscussionMappingRecord[];
  }): Promise<DiscussionMappingRecord[]> {
    const context = this.unwrapContext(input.context);
    const discussionById = new Map(
      context.discussions.map((discussion) => [discussion.id, discussion] as const),
    );
    const syncedMappings = [...input.mappings];
    let synchronizedCount = 0;

    for (const [index, mapping] of input.mappings.entries()) {
      const discussion = discussionById.get(mapping.platformThreadId);
      if (!discussion) {
        continue;
      }

      const liveStatus = discussion.notes.some((note) => note.resolved === true)
        ? "resolved"
        : "open";
      if (mapping.status === liveStatus) {
        continue;
      }

      syncedMappings[index] = await this.storage.upsertDiscussionMapping({
        id: mapping.id,
        tenantId: mapping.tenantId,
        codeReviewId: mapping.codeReviewId,
        identityKey: mapping.identityKey,
        findingFingerprint: mapping.findingFingerprint,
        title: mapping.title,
        severity: mapping.severity,
        category: mapping.category,
        body: mapping.body,
        platformThreadId: mapping.platformThreadId,
        platformCommentId: mapping.platformCommentId,
        anchorJson: mapping.anchorJson,
        positionJson: mapping.positionJson,
        botDiscussion: mapping.botDiscussion,
        botNote: mapping.botNote,
        noteAuthorId: mapping.noteAuthorId,
        noteAuthorUsername: mapping.noteAuthorUsername,
        status: liveStatus,
        lastInteractionRunId: mapping.lastInteractionRunId,
      });

      const findingStatusUpdated = await this.storage.updateReviewFindingStatus(
        input.tenant.id,
        input.codeReviewId,
        mapping.identityKey,
        liveStatus,
        {
          currentStatuses: ["open", "resolved"],
        },
      );
      if (!findingStatusUpdated) {
        this.logger.warn(
          {
            tenantId: input.tenant.id,
            codeReviewId: input.codeReviewId,
            discussionId: mapping.platformThreadId,
            identityKey: mapping.identityKey,
            findingStatus: liveStatus,
          },
          "failed to synchronize persisted review finding status from live discussion",
        );
      }

      synchronizedCount += 1;
    }

    if (synchronizedCount > 0) {
      this.logger.info(
        {
          tenantId: input.tenant.id,
          codeReviewId: input.codeReviewId,
          synchronizedCount,
        },
        "synchronized persisted discussion findings from live discussions",
      );
    }

    return syncedMappings;
  }

  public createReviewDiscussionAdapter(input: {
    context: PlatformReviewRoutingContext;
    interactionRunId: string;
  }) {
    return new GitLabReviewDiscussionAdapter({
      tenant: this.tenant,
      context: this.unwrapContext(input.context),
      client: this.client,
      logger: this.logger,
      interactionRunId: input.interactionRunId,
    });
  }

  public async resolveTriggerNoteReference(input: {
    codeReviewId: number;
    noteId: number;
  }): Promise<TriggerNoteReference> {
    const tenantConfig = getGitLabTenantConfig(this.tenant);
    const [notes, discussions] = await Promise.all([
      this.client.listCodeReviewNotes(tenantConfig.projectId, input.codeReviewId, {
        noCache: true,
      }),
      this.client.listCodeReviewDiscussions(
        tenantConfig.projectId,
        input.codeReviewId,
        { noCache: true },
      ),
    ]);

    const noteExists =
      notes.some((note) => note.id === input.noteId) ||
      discussions.some((discussion) =>
        discussion.notes.some((note) => note.id === input.noteId),
      );
    if (!noteExists) {
      throw new Error(
        `Trigger note ${input.noteId} no longer exists on merge request ${input.codeReviewId}`,
      );
    }

    return locateTriggerNoteReference(discussions, input.noteId);
  }

  public async ensureTriggerNoteReaction(input: {
    codeReviewId: number;
    note: TriggerNoteReference;
    reactionName: string;
    interactionJobId: string;
  }): Promise<void> {
    if (input.note.kind === "discussion-note") {
      return;
    }

    try {
      const tenantConfig = getGitLabTenantConfig(this.tenant);
      const existing = await this.client.listTriggerNoteAwardEmojis(
        tenantConfig.projectId,
        input.codeReviewId,
        input.note,
      );
      const hasReaction = existing.some(
        (award) => award.name === input.reactionName && isBotUser(award.user, this.tenant),
      );
      if (hasReaction) {
        return;
      }

      await this.client.createTriggerNoteAwardEmoji(
        tenantConfig.projectId,
        input.codeReviewId,
        input.note,
        input.reactionName,
      );
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          tenantId: this.tenant.id,
          interactionJobId: input.interactionJobId,
          codeReviewId: input.codeReviewId,
          note: input.note,
          reactionName: input.reactionName,
        },
        "failed to synchronize trigger-note reaction",
      );
    }
  }

  public async materializeAttachments(input: {
    context: PlatformReviewRoutingContext;
    trigger: ReviewContext["trigger"];
    runArtifacts: InteractionRunArtifacts;
  }): Promise<{
    attachments: HarnessRunAttachments;
    breadcrumbs: ReviewContext["attachments"];
    issues: ReviewContext["attachmentIssues"];
  }> {
    const context = this.unwrapContext(input.context);
    const references = discoverGitLabImageAttachmentReferences({
      gitLabBaseUrl: getGitLabTenantConfig(this.tenant).baseUrl,
      mergeRequest: context.mergeRequest,
      triggerNote: {
        body: input.trigger.body,
        noteId: input.trigger.noteId,
      },
    });
    if (references.length === 0) {
      return {
        attachments: [],
        breadcrumbs: [],
        issues: [],
      };
    }

    const materialized = await materializeGitLabImageAttachments({
      client: this.client,
      references,
    });
    await input.runArtifacts.writeJsonArtifact(
      join("orchestration", "image-attachments.json"),
      {
        attachmentCount: materialized.attachments.length,
        attachments: materialized.breadcrumbs,
        issues: materialized.issues,
        skipped: materialized.skipped,
      },
    );
    if (materialized.issues.length > 0) {
      await input.runArtifacts.appendAppLog({
        timestamp: new Date().toISOString(),
        level: "warn",
        message:
          "gitlab image attachment downloads failed for some referenced images; continuing with partial image context",
        data: {
          issueCount: materialized.issues.length,
          attachmentCount: materialized.attachments.length,
          triggerNoteId: input.trigger.noteId,
          issues: materialized.issues,
        },
      });
      this.logger.warn(
        {
          tenantId: this.tenant.id,
          triggerNoteId: input.trigger.noteId,
          issueCount: materialized.issues.length,
        },
        "gitlab image attachment downloads failed for some referenced images; continuing with partial image context",
      );
    }

    return {
      attachments: materialized.attachments,
      breadcrumbs: materialized.breadcrumbs,
      issues: materialized.issues,
    };
  }

  public async publishChatterReplies(input: {
    codeReviewId: number;
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
    const plannedTargetKeySet = new Set(
      input.plannedTargets.map((target) => this.responseTargetKey(target)),
    );
    const outcomes: Array<{
      target: ResponseTarget;
      status: "published" | "failed";
      noteId?: number | undefined;
      error?: string | undefined;
    }> = [];
    const tenantConfig = getGitLabTenantConfig(this.tenant);

    for (const reply of input.result.replies) {
      const matchingTarget =
        input.plannedTargets.find(
          (target) =>
            this.responseTargetKey(target) ===
            this.responseTargetKey(reply.target),
        ) ?? null;
      if (
        !matchingTarget ||
        !plannedTargetKeySet.has(this.responseTargetKey(matchingTarget))
      ) {
        continue;
      }

      try {
        const published = matchingTarget.discussionId
          ? await this.client.replyToDiscussion(
              tenantConfig.projectId,
              input.codeReviewId,
              matchingTarget.discussionId,
              reply.replyBody,
            )
          : await this.client.createCodeReviewNote(
              tenantConfig.projectId,
              input.codeReviewId,
              reply.replyBody,
            );
        outcomes.push({
          target: matchingTarget,
          status: "published",
          noteId: published.id,
        });
      } catch (error) {
        outcomes.push({
          target: matchingTarget,
          status: "failed",
          error: getErrorMessage(error),
        });
      }
    }

    return outcomes;
  }

  public async cleanupWorkspace(
    workspace: PlatformMaterializedWorkspace,
  ): Promise<void> {
    await this.workspaceMaterializer.cleanup(workspace as MaterializedWorkspace);
  }

  private wrapContext(
    context: LightweightMergeRequestContext | HydratedMergeRequestContext,
  ): PlatformReviewRoutingContext {
    return {
      codeReviewId: context.mergeRequest.iid,
      summaryContext: {
        codeReview: toCodeReviewItem(context.mergeRequest),
        changes: context.changes.map(toCodeReviewChange),
      },
      workspace: context.workspace,
      projectMemory: context.projectMemory,
      changedFileCount: context.changes.length,
      noteCount: context.notes.length,
      discussionCount: context.discussions.length,
      platformContext: context,
    };
  }

  private unwrapContext(
    context: PlatformReviewRoutingContext,
  ): LightweightMergeRequestContext | HydratedMergeRequestContext {
    return context.platformContext as
      | LightweightMergeRequestContext
      | HydratedMergeRequestContext;
  }

  private createGitLabClient(input: {
    logger: Logger;
    tenant: TenantRecord;
    interactionJobId: string;
    interactionRunId?: string | undefined;
    runArtifacts?: InteractionRunArtifacts | undefined;
  }): GitLabClient {
    const tenantConfig = getGitLabTenantConfig(input.tenant);
    const runArtifacts = input.runArtifacts;
    return new GitLabClient({
      baseUrl: tenantConfig.baseUrl,
      apiToken: tenantConfig.apiToken,
      logger: input.logger.child({
        tenantId: input.tenant.id,
        interactionJobId: input.interactionJobId,
        ...(input.interactionRunId
          ? { interactionRunId: input.interactionRunId }
          : {}),
      }),
      ...(input.runArtifacts
        ? {
            requestLogger: {
              log: (entry: unknown) =>
                runArtifacts!.appendPlatformHttpLog(entry as never),
            },
          }
        : {}),
    });
  }

  private responseTargetKey(
    target: Pick<ResponseTarget, "kind" | "noteId" | "discussionId">,
  ): string {
    return `${target.kind}::${target.noteId}::${target.discussionId ?? ""}`;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

function toCodeReviewItem(mergeRequest: GitLabMergeRequest): CodeReviewItem {
  return {
    id: mergeRequest.iid,
    title: mergeRequest.title,
    description: mergeRequest.description ?? "",
    webUrl: mergeRequest.web_url,
    authorUsername: mergeRequest.author.username,
    sourceBranch: mergeRequest.source_branch,
    targetBranch: mergeRequest.target_branch,
  };
}

function toCodeReviewChange(change: GitLabMergeRequestChange): CodeReviewChange {
  return {
    oldPath: change.old_path,
    newPath: change.new_path,
    diff: change.diff,
    newFile: change.new_file,
    renamedFile: change.renamed_file,
    deletedFile: change.deleted_file,
  };
}

function toCodeReviewNote(note: GitLabNote): CodeReviewNote {
  return {
    id: note.id,
    body: note.body,
    authorUsername: note.author.username,
    resolvable: note.resolvable === true,
    resolved: note.resolved === true,
  };
}

function toCodeReviewDiscussion(
  discussion: GitLabDiscussion,
  tenant: TenantRecord,
): CodeReviewDiscussion {
  return {
    id: discussion.id,
    resolved: discussion.notes.some((note) => note.resolved === true),
    comments: discussion.notes.map((note) => ({
      id: note.id,
      body: note.body,
      authorUsername: note.author.username,
      resolvable: note.resolvable === true,
      resolved: note.resolved === true,
      anchor: note.position
        ? note.position.new_line
          ? {
              path: note.position.new_path,
              oldPath: note.position.old_path,
              startLine: note.position.new_line,
              endLine: note.position.new_line,
              side: "new" as const,
            }
          : note.position.old_line
            ? {
                path: note.position.old_path,
                oldPath: note.position.old_path,
                startLine: note.position.old_line,
                endLine: note.position.old_line,
                side: "old" as const,
              }
            : null
        : null,
      positionJson: note.position ? JSON.stringify(note.position) : null,
      isBot: isBotUser(note.author, tenant),
      createdAt: note.created_at ?? null,
      updatedAt: note.updated_at ?? null,
    })),
  };
}
