import type { Logger } from "pino";

import type { ProjectMemoryBackend } from "../../memory/backend.js";
import {
  buildProviderDiscussions,
  type ReconcileSummary,
} from "../../reconcile/discussion-reconciler.js";
import { buildScopedReviewContext } from "../../review/review-scope.js";
import type {
  ChatterBatchResult,
  CodeReviewChange,
  CodeReviewComment,
  CodeReviewDiscussion,
  CodeReviewItem,
  ProviderDiscussionContext,
  ResponseTarget,
  ReviewAnchor,
  ReviewContext,
  ReviewResult,
  TriggerCommentReference,
} from "../../review/types.js";
import type { InteractionRunArtifacts } from "../../review/run-artifacts.js";
import type {
  DiscussionMappingRecord,
  InteractionJobRecord,
  PreviousCompletedInteractionRecord,
  TenantRecord,
} from "../../storage/contract/current.js";
import type { StorageHelpers } from "../../storage/storage-helpers.js";
import type {
  PlatformMaterializedWorkspace,
  PlatformReviewRoutingContext,
  PlatformReviewRuntime,
  ResolvedTenant,
} from "../IPlatform.js";
import type {
  PlatformReviewComment,
  PlatformReviewDiscussion,
} from "../review-adapter.js";
import {
  type GitHubClient,
  type GitHubPullRequest,
  type GitHubPullRequestFile,
  type GitHubReviewComment,
  type GitHubReviewThread,
} from "./client.js";
import { readyGitHubConnectionConfigSchema } from "./config.js";
import { GitHubRepositoryContextResolver } from "./repository-context.js";
import {
  buildGitHubIssueCommentDiscussions,
  buildGitHubReviewCommentFallbackDiscussions,
  GitHubReviewPublicationAdapter,
} from "./review-publication-adapter.js";
import type {
  GitHubPullRequestContext,
  HydratedGitHubPullRequestContext,
} from "./review-types.js";
import { buildGitHubCheckRunReviewTriggerContext } from "./trigger-lifecycle.js";
import { GitHubWorkspaceMaterializer } from "./workspace.js";
import {
  buildGitHubCommentReviewTriggerContext,
  getPersistedGitHubCommentReference,
  githubCommentTriggerSchema,
} from "./comment-trigger.js";

interface GitHubReviewRuntimeOptions {
  storage: StorageHelpers;
  logger: Logger;
  resolvedTenant: ResolvedTenant;
  workspaceRoot: string;
  client: GitHubClient;
  projectMemoryBackend: ProjectMemoryBackend;
}

export class GitHubPlatformReviewRuntime implements PlatformReviewRuntime {
  private readonly tenant: TenantRecord;
  private readonly workspaceMaterializer: GitHubWorkspaceMaterializer;
  private readonly botLogin: string;

  public constructor(private readonly options: GitHubReviewRuntimeOptions) {
    this.tenant = options.resolvedTenant.tenant;
    this.workspaceMaterializer = new GitHubWorkspaceMaterializer({
      workspaceRoot: options.workspaceRoot,
    });
    const config = readyGitHubConnectionConfigSchema.parse(
      JSON.parse(
        options.resolvedTenant.connection.platformConnectionConfigJson,
      ) as unknown,
    );
    this.botLogin = `${config.appSlug}[bot]`.toLowerCase();
  }

  public async loadRoutingContext(
    job: InteractionJobRecord,
  ): Promise<PlatformReviewRoutingContext> {
    return this.wrapContext(await this.loadContext(job));
  }

  public async hydrate(input: {
    job: InteractionJobRecord;
    context?: PlatformReviewRoutingContext | undefined;
  }): Promise<PlatformReviewRoutingContext> {
    const context = input.context
      ? this.unwrapContext(input.context)
      : await this.loadContext(input.job);
    const snapshot = await this.options.storage.createCodeReviewSnapshot({
      interactionJobId: input.job.id,
      tenantId: this.tenant.id,
      codeReviewId: input.job.codeReviewId,
      headSha: input.job.headSha,
      codeReviewJson: JSON.stringify(context.pullRequest),
      versionsJson: JSON.stringify([
        {
          baseSha: context.pullRequest.base.sha,
          headSha: context.pullRequest.head.sha,
        },
      ]),
      changesJson: JSON.stringify(context.files.map(toCodeReviewChange)),
      commentsJson: JSON.stringify(this.toCodeReviewComments(context)),
      discussionsJson: JSON.stringify(this.toCodeReviewDiscussions(context)),
      instructionsJson: "[]",
      projectMemoryJson: JSON.stringify(context.projectMemory),
      workspaceStrategy: context.workspace.strategy,
    });

    this.options.logger.info(
      {
        tenantId: this.tenant.id,
        interactionJobId: input.job.id,
        codeReviewId: input.job.codeReviewId,
        changedFiles: context.files.length,
        discussionCount: this.toCodeReviewDiscussions(context).length,
        commentCount: this.toCodeReviewComments(context).length,
        workspaceStrategy: context.workspace.strategy,
      },
      "hydrated GitHub pull request context",
    );

    return this.wrapContext({ ...context, snapshot });
  }

  public buildProviderDiscussions(input: {
    context: PlatformReviewRoutingContext;
    mappings: DiscussionMappingRecord[];
  }): ProviderDiscussionContext[] {
    return buildProviderDiscussions({
      discussions: this.toPlatformDiscussions(
        this.unwrapContext(input.context),
      ),
      mappings: input.mappings,
    });
  }

  public buildReviewTriggerContext(input: {
    job: InteractionJobRecord;
    payload: unknown;
    context: PlatformReviewRoutingContext;
    priorDiscussions: ProviderDiscussionContext[];
    mappings: DiscussionMappingRecord[];
  }): ReviewContext["trigger"] {
    if (
      githubCommentTriggerSchema.safeParse(JSON.parse(input.job.triggerJson))
        .success
    ) {
      return buildGitHubCommentReviewTriggerContext({
        job: input.job,
        priorDiscussions: input.priorDiscussions,
        fallbackDiscussions: this.buildFallbackTriggerDiscussions({
          context: input.context,
          mappings: input.mappings,
          triggerJson: input.job.triggerJson,
        }),
        locateComment: (commentId) =>
          this.locateTriggerCommentReference({
            context: input.context,
            commentId,
          }),
      });
    }
    return buildGitHubCheckRunReviewTriggerContext(input.job);
  }

  public locateTriggerCommentReference(input: {
    context: PlatformReviewRoutingContext;
    commentId: number;
  }): TriggerCommentReference {
    const context = this.unwrapContext(input.context);
    if (
      context.issueComments.some((comment) => comment.id === input.commentId)
    ) {
      return { kind: "code-review-comment", commentId: input.commentId };
    }
    const thread = context.reviewThreads.find((entry) =>
      entry.comments.nodes.some(
        (comment) => comment.databaseId === input.commentId,
      ),
    );
    if (thread) {
      return {
        kind: "discussion-comment",
        discussionId: thread.id,
        commentId: input.commentId,
      };
    }
    const reviewComment = context.reviewComments.find(
      (comment) => comment.id === input.commentId,
    );
    if (reviewComment) {
      return {
        kind: "discussion-comment",
        discussionId: `review-comment:${reviewComment.in_reply_to_id ?? reviewComment.id}`,
        commentId: input.commentId,
      };
    }
    throw new Error(
      `GitHub comment ${input.commentId} was not found on pull request ${context.pullRequest.number}`,
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
    priorFindings: Awaited<
      ReturnType<StorageHelpers["listPriorReviewFindings"]>
    >;
    previousInteraction: PreviousCompletedInteractionRecord | null;
  }): ReviewContext {
    const context = this.unwrapContext(input.context);
    const hydratedPriorDiscussions = this.buildProviderDiscussions({
      context: input.context,
      mappings: input.mappings,
    });
    const priorDiscussions = mergeProviderDiscussions(
      hydratedPriorDiscussions,
      this.buildFallbackTriggerDiscussions({
        context: input.context,
        mappings: input.mappings,
        triggerJson: input.job.triggerJson,
      }),
    );
    return buildScopedReviewContext({
      attachments: input.attachments,
      attachmentIssues: input.attachmentIssues,
      workspacePath: context.workspace.rootPath,
      codeReview: toCodeReviewItem(context.pullRequest),
      changes: context.files.map(toCodeReviewChange),
      comments: this.toCodeReviewComments(context),
      discussions: this.toCodeReviewDiscussions(context),
      projectMemory: context.projectMemory,
      trigger: input.trigger,
      priorDiscussions,
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
    const discussions = new Map(
      this.toPlatformDiscussions(this.unwrapContext(input.context)).map(
        (discussion) => [discussion.id, discussion],
      ),
    );
    const result = [...input.mappings];
    for (const [index, mapping] of input.mappings.entries()) {
      const discussion = discussions.get(mapping.platformDiscussionId);
      if (!discussion) {
        continue;
      }
      const status = discussion.resolved ? "resolved" : "open";
      if (mapping.status === status) {
        continue;
      }
      result[index] = await this.options.storage.upsertDiscussionMapping({
        id: mapping.id,
        tenantId: mapping.tenantId,
        codeReviewId: mapping.codeReviewId,
        identityKey: mapping.identityKey,
        findingFingerprint: mapping.findingFingerprint,
        title: mapping.title,
        severity: mapping.severity,
        category: mapping.category,
        body: mapping.body,
        platformDiscussionId: mapping.platformDiscussionId,
        platformCommentId: mapping.platformCommentId,
        anchorJson: mapping.anchorJson,
        positionJson: mapping.positionJson,
        botDiscussion: mapping.botDiscussion,
        botComment: mapping.botComment,
        commentAuthorId: mapping.commentAuthorId,
        commentAuthorUsername: mapping.commentAuthorUsername,
        status,
        lastInteractionRunId: mapping.lastInteractionRunId,
      });
      await this.options.storage.updateReviewFindingStatus(
        input.tenant.id,
        input.codeReviewId,
        mapping.identityKey,
        status,
        { currentStatuses: ["open", "resolved"] },
      );
    }
    return result;
  }

  public createReviewPublicationAdapter(input: {
    context: PlatformReviewRoutingContext;
  }) {
    const context = this.unwrapContext(input.context);
    return new GitHubReviewPublicationAdapter({
      client: this.options.client,
      repositoryFullName: context.repositoryFullName,
      pullRequestNumber: context.pullRequest.number,
      headSha: context.pullRequest.head.sha,
      files: context.files,
      issueComments: context.issueComments,
      reviews: context.reviews,
      reviewComments: context.reviewComments,
      reviewThreads: context.reviewThreads,
      botLogin: this.botLogin,
    });
  }

  public async resolveTriggerCommentReference(input: {
    codeReviewId: number;
    commentId: number;
    triggerJson?: string | undefined;
  }): Promise<TriggerCommentReference> {
    if (input.triggerJson) {
      const persistedReference = getPersistedGitHubCommentReference(
        input.triggerJson,
      );
      if (persistedReference?.commentId === input.commentId) {
        return persistedReference;
      }
    }
    const { tenantConfig } = await new GitHubRepositoryContextResolver({
      storage: this.options.storage,
      client: this.options.client,
      logger: this.options.logger,
    }).resolve(this.tenant);
    const [issueComments, reviewComments, reviewThreads] = await Promise.all([
      this.options.client.listIssueComments(
        tenantConfig.repositoryFullName,
        input.codeReviewId,
      ),
      this.options.client.listReviewComments(
        tenantConfig.repositoryFullName,
        input.codeReviewId,
      ),
      this.options.client.listReviewThreads(
        tenantConfig.repositoryFullName,
        input.codeReviewId,
      ),
    ]);
    if (issueComments.some((comment) => comment.id === input.commentId)) {
      return { kind: "code-review-comment", commentId: input.commentId };
    }
    const thread = reviewThreads.find((entry) =>
      entry.comments.nodes.some(
        (comment) => comment.databaseId === input.commentId,
      ),
    );
    if (thread) {
      return {
        kind: "discussion-comment",
        discussionId: thread.id,
        commentId: input.commentId,
      };
    }
    const reviewComment = reviewComments.find(
      (comment) => comment.id === input.commentId,
    );
    if (reviewComment) {
      return {
        kind: "discussion-comment",
        discussionId: `review-comment:${reviewComment.in_reply_to_id ?? reviewComment.id}`,
        commentId: input.commentId,
      };
    }
    throw new Error(
      `GitHub comment ${input.commentId} was not found on pull request ${input.codeReviewId}`,
    );
  }

  public async materializeAttachments(): Promise<{
    attachments: [];
    breadcrumbs: [];
    issues: [];
  }> {
    return { attachments: [], breadcrumbs: [], issues: [] };
  }

  public async publishChatterReplies(input: {
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
  > {
    const { tenantConfig } = await new GitHubRepositoryContextResolver({
      storage: this.options.storage,
      client: this.options.client,
      logger: this.options.logger,
    }).resolve(this.tenant);
    const plannedKeys = new Set(input.plannedTargets.map(responseTargetKey));
    const reviewThreads = input.plannedTargets.some(
      (target) =>
        target.kind !== "code-review-comment" &&
        !target.discussionId?.startsWith("issue-comment:"),
    )
      ? await this.options.client.listReviewThreads(
          tenantConfig.repositoryFullName,
          input.codeReviewId,
        )
      : [];
    const outcomes: Array<{
      target: ResponseTarget;
      status: "published" | "failed";
      commentId?: number | undefined;
      error?: string | undefined;
    }> = [];
    for (const reply of input.result.replies) {
      const target = input.plannedTargets.find(
        (candidate) =>
          responseTargetKey(candidate) === responseTargetKey(reply.target),
      );
      if (!target || !plannedKeys.has(responseTargetKey(target))) {
        continue;
      }
      input.guard.assertOwned();
      try {
        const published =
          target.kind === "code-review-comment" ||
          target.discussionId?.startsWith("issue-comment:")
            ? await this.options.client.createIssueComment({
                repositoryFullName: tenantConfig.repositoryFullName,
                issueNumber: input.codeReviewId,
                body: reply.replyBody,
              })
            : await this.options.client.replyToReviewComment({
                repositoryFullName: tenantConfig.repositoryFullName,
                pullRequestNumber: input.codeReviewId,
                commentId:
                  reviewThreads
                    .find((thread) => thread.id === target.discussionId)
                    ?.comments.nodes.at(0)?.databaseId ??
                  parseReviewCommentDiscussionId(target.discussionId ?? "") ??
                  target.commentId,
                body: reply.replyBody,
              });
        outcomes.push({
          target,
          status: "published" as const,
          commentId: published.id,
        });
      } catch (error) {
        outcomes.push({
          target,
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      input.guard.assertOwned();
    }
    return outcomes;
  }

  public buildTriggerOutcome(input: {
    reviewResult: ReviewResult | null;
    reconcileSummary: ReconcileSummary | null;
  }) {
    if (!input.reviewResult) {
      return undefined;
    }
    return {
      summary:
        input.reviewResult.overview.overallAssessment ??
        input.reviewResult.overview.summary,
      ...(input.reconcileSummary?.links.length
        ? { links: input.reconcileSummary.links }
        : {}),
    };
  }

  public cleanupWorkspace(
    workspace: PlatformMaterializedWorkspace,
  ): Promise<void> {
    return this.workspaceMaterializer.cleanup(workspace);
  }

  private async loadContext(
    job: InteractionJobRecord,
  ): Promise<GitHubPullRequestContext> {
    const { tenantConfig } = await new GitHubRepositoryContextResolver({
      storage: this.options.storage,
      client: this.options.client,
      logger: this.options.logger,
    }).resolve(this.tenant);
    const [
      pullRequest,
      files,
      issueComments,
      reviews,
      reviewComments,
      reviewThreads,
    ] = await Promise.all([
      this.options.client.getPullRequest(
        tenantConfig.repositoryFullName,
        job.codeReviewId,
      ),
      this.options.client.listPullRequestFiles(
        tenantConfig.repositoryFullName,
        job.codeReviewId,
      ),
      this.options.client.listIssueComments(
        tenantConfig.repositoryFullName,
        job.codeReviewId,
      ),
      this.options.client.listPullRequestReviews(
        tenantConfig.repositoryFullName,
        job.codeReviewId,
      ),
      this.options.client.listReviewComments(
        tenantConfig.repositoryFullName,
        job.codeReviewId,
      ),
      this.options.client.listReviewThreads(
        tenantConfig.repositoryFullName,
        job.codeReviewId,
      ),
    ]);
    if (pullRequest.head.sha !== job.headSha) {
      throw new Error(
        `GitHub pull request ${job.codeReviewId} head ${pullRequest.head.sha} does not match review job head ${job.headSha}`,
      );
    }

    const workspace = await this.workspaceMaterializer.materialize({
      client: this.options.client,
      jobId: job.id,
      repositoryFullName: tenantConfig.repositoryFullName,
      headSha: job.headSha,
    });
    return {
      tenant: this.tenant,
      job,
      repositoryFullName: tenantConfig.repositoryFullName,
      pullRequest,
      files,
      issueComments,
      reviews,
      reviewComments,
      reviewThreads,
      workspace,
      projectMemory: await this.loadProjectMemorySafely(job),
    };
  }

  private async loadProjectMemorySafely(
    job: InteractionJobRecord,
  ): Promise<ReviewContext["projectMemory"]> {
    const capability = await this.options.projectMemoryBackend.getCapability();
    if (!capability.available) {
      this.options.logger.warn(
        {
          tenantId: this.tenant.id,
          interactionJobId: job.id,
          reason: capability.reason,
        },
        "GitHub project memory is unavailable",
      );
      return {
        enabled: false,
        page: null,
        entries: [],
      };
    }

    try {
      return await this.options.projectMemoryBackend.load();
    } catch (error) {
      this.options.logger.warn(
        {
          err: error,
          tenantId: this.tenant.id,
          interactionJobId: job.id,
        },
        "GitHub project memory could not be loaded",
      );
      return {
        enabled: false,
        page: null,
        entries: [],
      };
    }
  }

  private wrapContext(
    context: GitHubPullRequestContext | HydratedGitHubPullRequestContext,
  ): PlatformReviewRoutingContext {
    const comments = this.toCodeReviewComments(context);
    const discussions = this.toCodeReviewDiscussions(context);
    return {
      codeReviewId: context.pullRequest.number,
      summaryContext: {
        codeReview: toCodeReviewItem(context.pullRequest),
        changes: context.files.map(toCodeReviewChange),
      },
      workspace: context.workspace,
      projectMemory: context.projectMemory,
      changedFileCount: context.files.length,
      commentCount: comments.length,
      discussionCount: discussions.length,
      platformContext: context,
    };
  }

  private unwrapContext(
    context: PlatformReviewRoutingContext,
  ): GitHubPullRequestContext | HydratedGitHubPullRequestContext {
    return context.platformContext as
      | GitHubPullRequestContext
      | HydratedGitHubPullRequestContext;
  }

  private toCodeReviewComments(
    context: GitHubPullRequestContext,
  ): CodeReviewComment[] {
    return [
      ...context.issueComments.map((comment) => ({
        id: comment.id,
        body: comment.body ?? "",
        authorUsername: comment.user?.login ?? null,
        resolvable: false,
        resolved: false,
      })),
      ...context.reviews
        .filter((review) => Boolean(review.body))
        .map((review) => ({
          id: review.id,
          body: review.body ?? "",
          authorUsername: review.user?.login ?? null,
          resolvable: false,
          resolved: false,
        })),
    ];
  }

  private toCodeReviewDiscussions(
    context: GitHubPullRequestContext,
  ): CodeReviewDiscussion[] {
    return this.toPlatformDiscussions(context).map((discussion) => ({
      id: discussion.id,
      resolved: discussion.resolved,
      comments: discussion.comments.map((comment) => ({
        id: Number(comment.id),
        body: comment.body,
        authorUsername: comment.authorUsername,
        resolvable: discussion.resolvable && comment.resolvable,
        resolved: discussion.resolved || comment.resolved,
        anchor: comment.anchor,
        positionJson: comment.positionJson,
        isBot: comment.isBot,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      })),
    }));
  }

  private toPlatformDiscussions(
    context: GitHubPullRequestContext,
  ): PlatformReviewDiscussion[] {
    const commentById = new Map(
      context.reviewComments.map((comment) => [comment.id, comment]),
    );
    const reviewDiscussions = context.reviewThreads
      .map((thread) => {
        const comments = thread.comments.nodes
          .map((node) => commentById.get(node.databaseId))
          .filter((comment): comment is GitHubReviewComment => Boolean(comment))
          .map((comment) =>
            toPlatformReviewComment(
              comment,
              this.botLogin,
              thread.isResolved,
              canMutateReviewThreadResolution(thread),
            ),
          );
        return comments.length
          ? {
              id: thread.id,
              comments,
              resolvable: canMutateReviewThreadResolution(thread),
              resolved: thread.isResolved,
            }
          : null;
      })
      .filter(
        (discussion): discussion is PlatformReviewDiscussion =>
          discussion !== null,
      );
    const issueDiscussions = buildGitHubIssueCommentDiscussions(
      context.issueComments,
      this.botLogin,
    );
    const fallbackReviewDiscussions =
      buildGitHubReviewCommentFallbackDiscussions(
        context.reviewComments,
        context.reviewThreads,
        this.botLogin,
      );
    return [
      ...reviewDiscussions,
      ...fallbackReviewDiscussions,
      ...issueDiscussions,
    ];
  }

  private buildFallbackTriggerDiscussions(input: {
    context: PlatformReviewRoutingContext;
    mappings: DiscussionMappingRecord[];
    triggerJson: string;
  }): ProviderDiscussionContext[] {
    const persistedReference = getPersistedGitHubCommentReference(
      input.triggerJson,
    );
    if (
      persistedReference?.kind !== "discussion-comment" ||
      !persistedReference.discussionId.startsWith("review-comment:")
    ) {
      return [];
    }
    const rootCommentId = parseReviewCommentDiscussionId(
      persistedReference.discussionId,
    );
    if (rootCommentId === null) {
      return [];
    }
    const context = this.unwrapContext(input.context);
    const rootComment = context.reviewComments.find(
      (comment) => comment.id === rootCommentId,
    );
    const mapping = input.mappings.find(
      (candidate) =>
        candidate.platformCommentId === rootCommentId ||
        candidate.platformDiscussionId === persistedReference.discussionId,
    );
    if (!rootComment || !mapping) {
      return [];
    }
    const humanReplies = context.reviewComments
      .filter(
        (comment) =>
          (comment.in_reply_to_id ?? comment.id) === rootCommentId &&
          comment.id !== rootCommentId &&
          !isGitHubBot(comment.user?.login ?? null, this.botLogin),
      )
      .map((comment) => ({
        platformCommentId: comment.id,
        authorUsername: comment.user?.login ?? "(unknown)",
        body: comment.body,
      }));
    return [
      {
        discussionId: mapping.id,
        platformDiscussionId: mapping.platformDiscussionId,
        platformCommentId: rootCommentId,
        title: mapping.title,
        body: mapping.body,
        anchor: mapping.anchorJson
          ? (JSON.parse(mapping.anchorJson) as ReviewAnchor)
          : toReviewAnchor(rootComment),
        resolvable: false,
        resolved: mapping.status === "resolved",
        humanReplies,
      },
    ];
  }
}

function toCodeReviewItem(pullRequest: GitHubPullRequest): CodeReviewItem {
  return {
    id: pullRequest.number,
    title: pullRequest.title,
    description: pullRequest.body ?? "",
    webUrl: pullRequest.html_url,
    authorUsername: pullRequest.user?.login ?? null,
    sourceBranch: pullRequest.head.ref,
    targetBranch: pullRequest.base.ref,
  };
}

function toCodeReviewChange(file: GitHubPullRequestFile): CodeReviewChange {
  return {
    oldPath: file.previous_filename ?? file.filename,
    newPath: file.filename,
    ...(file.patch ? { diff: file.patch } : {}),
    newFile: file.status === "added" || file.status === "copied",
    renamedFile: file.status === "renamed",
    deletedFile: file.status === "removed",
  };
}

function toPlatformReviewComment(
  comment: GitHubReviewComment,
  botLogin: string,
  resolved: boolean,
  resolvable: boolean,
): PlatformReviewComment {
  return {
    id: String(comment.id),
    body: comment.body,
    authorId: comment.user ? String(comment.user.id) : null,
    authorUsername: comment.user?.login ?? null,
    isBot: isGitHubBot(comment.user?.login ?? null, botLogin),
    resolvable,
    resolved,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    anchor: toReviewAnchor(comment),
    positionJson: JSON.stringify({
      path: comment.path,
      line: comment.line ?? null,
      originalLine: comment.original_line ?? null,
      side: comment.side ?? null,
      startLine: comment.start_line ?? null,
      originalStartLine: comment.original_start_line ?? null,
      startSide: comment.start_side ?? null,
      commitId: comment.commit_id,
      originalCommitId: comment.original_commit_id,
      diffHunk: comment.diff_hunk,
    }),
    url: comment.html_url,
  };
}

function toReviewAnchor(comment: GitHubReviewComment): ReviewAnchor | null {
  const side = comment.side ?? comment.start_side;
  const endLine =
    side === "LEFT"
      ? (comment.original_line ?? comment.line)
      : (comment.line ?? comment.original_line);
  const startLine =
    side === "LEFT"
      ? (comment.original_start_line ?? comment.start_line ?? endLine)
      : (comment.start_line ?? comment.original_start_line ?? endLine);
  if (!side || !startLine || !endLine) {
    return null;
  }
  return {
    path: comment.path,
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
    side: side === "LEFT" ? "old" : "new",
  };
}

function isGitHubBot(login: string | null, botLogin: string): boolean {
  return login?.toLowerCase() === botLogin;
}

function canMutateReviewThreadResolution(thread: GitHubReviewThread): boolean {
  return isNativeReviewThreadId(thread.id);
}

function isNativeReviewThreadId(threadId: string): boolean {
  return threadId.startsWith("PRRT_");
}

function parseReviewCommentDiscussionId(discussionId: string): number | null {
  const match = /^review-comment:(\d+)$/.exec(discussionId);
  return match ? Number(match[1]) : null;
}

function mergeProviderDiscussions(
  primary: ProviderDiscussionContext[],
  fallback: ProviderDiscussionContext[],
): ProviderDiscussionContext[] {
  const discussionKeys = new Set(
    primary.flatMap((discussion) => [
      `discussion:${discussion.discussionId}`,
      `platform:${discussion.platformDiscussionId}`,
      `comment:${discussion.platformCommentId}`,
    ]),
  );
  return [
    ...primary,
    ...fallback.filter(
      (discussion) =>
        !discussionKeys.has(`discussion:${discussion.discussionId}`) &&
        !discussionKeys.has(`platform:${discussion.platformDiscussionId}`) &&
        !discussionKeys.has(`comment:${discussion.platformCommentId}`),
    ),
  ];
}

function responseTargetKey(
  target: Pick<ResponseTarget, "kind" | "commentId" | "discussionId">,
): string {
  return `${target.kind}::${target.commentId}::${target.discussionId ?? ""}`;
}
