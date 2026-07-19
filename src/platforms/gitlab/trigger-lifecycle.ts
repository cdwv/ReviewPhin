import type { Logger } from "pino";
import { z } from "zod";

import type {
  PlatformTriggerLifecycle,
  ResolvedTenant,
} from "../IPlatform.js";
import type {
  InteractionJobRecord,
} from "../../storage/contract/current.js";
import type { TriggerCommentReference } from "../../review/types.js";
import { GitLabClient } from "./client.js";
import { isBotUser } from "./bot-user.js";
import {
  getGitLabConnectionConfig,
  getGitLabTenantConfig,
} from "./tenant-config.js";
import { locateTriggerCommentReference } from "./trigger.js";

const triggerReferenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("code-review-comment"),
    commentId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("discussion-comment"),
    discussionId: z.string().min(1),
    commentId: z.number().int().positive(),
  }),
]);

const gitLabTriggerSchema = z.union([
  z.object({
    kind: z.literal("gitlab-comment"),
    comment: triggerReferenceSchema,
  }),
  z.object({
    kind: z.literal("comment"),
    commentId: z.number().int().positive(),
  }),
]);

const STARTED_REACTION = "eyes";
const COMPLETED_REACTION = "white_check_mark";
const FAILED_REACTION = "confounded";

export class GitLabTriggerLifecycle implements PlatformTriggerLifecycle {
  private readonly client: GitLabClient;
  private readonly logger: Logger;

  public constructor(
    private readonly resolvedTenant: ResolvedTenant,
    private readonly job: InteractionJobRecord,
    logger: Logger,
  ) {
    const config = getGitLabConnectionConfig(resolvedTenant.connection);
    this.logger = logger.child({
      tenantId: resolvedTenant.tenant.id,
      interactionJobId: job.id,
    });
    this.client = new GitLabClient({
      baseUrl: config.baseUrl,
      apiToken: config.apiToken,
      logger: this.logger,
    });
  }

  public queued(): Promise<void> {
    return this.ensureReaction(STARTED_REACTION);
  }

  public inProgress(): Promise<void> {
    return this.ensureReaction(STARTED_REACTION);
  }

  public completed(): Promise<void> {
    return this.ensureReaction(COMPLETED_REACTION);
  }

  public retry(): Promise<void> {
    return Promise.resolve();
  }

  public failed(): Promise<void> {
    return this.ensureReaction(FAILED_REACTION);
  }

  private async ensureReaction(reactionName: string): Promise<void> {
    const comment = await this.resolveComment();
    const tenantConfig = getGitLabTenantConfig(this.resolvedTenant.tenant);
    const existing = await this.client.listTriggerNoteAwardEmojis(
      tenantConfig.projectId,
      this.job.codeReviewId,
      comment,
    );
    const connectionConfig = getGitLabConnectionConfig(
      this.resolvedTenant.connection,
    );
    if (
      existing.some(
        (award) =>
          award.name === reactionName &&
          isBotUser(award.user, connectionConfig.botUserId),
      )
    ) {
      return;
    }

    await this.client.createTriggerNoteAwardEmoji(
      tenantConfig.projectId,
      this.job.codeReviewId,
      comment,
      reactionName,
    );
  }

  private async resolveComment(): Promise<TriggerCommentReference> {
    const trigger = gitLabTriggerSchema.parse(JSON.parse(this.job.triggerJson));
    if (trigger.kind === "gitlab-comment") {
      return trigger.comment;
    }

    const tenantConfig = getGitLabTenantConfig(this.resolvedTenant.tenant);
    const discussions = await this.client.listCodeReviewDiscussions(
      tenantConfig.projectId,
      this.job.codeReviewId,
      { noCache: true },
    );
    return locateTriggerCommentReference(discussions, trigger.commentId);
  }
}
