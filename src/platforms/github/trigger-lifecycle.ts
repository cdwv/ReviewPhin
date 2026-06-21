import { z } from "zod";

import type {
  PlatformTriggerLifecycle,
  PlatformTriggerOutcome,
} from "../IPlatform.js";
import type { InteractionJobRecord } from "../../storage/contract/current.js";
import type { ManualReviewTriggerContext } from "../../review/types.js";
import type { GitHubClient, GitHubReaction } from "./client.js";
import type { GitHubTenantConfig } from "./tenant-config.js";
import { githubCommentTriggerSchema } from "./comment-trigger.js";

export const githubCheckRunTriggerSchema = z.object({
  kind: z.literal("github-check-run"),
  deliveryId: z.string().min(1),
  checkRunId: z.number().int().positive(),
  actionIdentifier: z.literal("run_review"),
  repositoryId: z.number().int().positive(),
});

export function buildGitHubCheckRunReviewTriggerContext(
  job: InteractionJobRecord,
): ManualReviewTriggerContext {
  const trigger = githubCheckRunTriggerSchema.parse(
    JSON.parse(job.triggerJson),
  );
  return {
    kind: "manual-review",
    provider: "github",
    source: "check-run-requested-action",
    metadata: {
      deliveryId: trigger.deliveryId,
      checkRunId: trigger.checkRunId,
      actionIdentifier: trigger.actionIdentifier,
      repositoryId: trigger.repositoryId,
    },
  };
}

export class GitHubCheckRunTriggerLifecycle implements PlatformTriggerLifecycle {
  private readonly trigger: z.infer<typeof githubCheckRunTriggerSchema>;

  public constructor(
    private readonly client: GitHubClient,
    private readonly tenant: GitHubTenantConfig,
    job: InteractionJobRecord,
  ) {
    this.trigger = githubCheckRunTriggerSchema.parse(
      JSON.parse(job.triggerJson),
    );
    if (this.trigger.repositoryId !== tenant.repositoryId) {
      throw new Error(
        `GitHub trigger repository ${this.trigger.repositoryId} does not match tenant repository ${tenant.repositoryId}`,
      );
    }
  }

  public queued(): Promise<void> {
    return this.update({
      status: "queued",
      summary: "ReviewPhin accepted the review request and queued the job.",
    });
  }

  public inProgress(): Promise<void> {
    return this.update({
      status: "in_progress",
      summary: "ReviewPhin is reviewing this pull request.",
    });
  }

  public completed(outcome?: PlatformTriggerOutcome): Promise<void> {
    return this.update({
      status: "completed",
      conclusion: "success",
      summary: formatCompletedSummary(outcome),
    });
  }

  public retry(error: string): Promise<void> {
    return this.update({
      status: "queued",
      summary: `The review attempt failed and will be retried.\n\n${error}`,
    });
  }

  public failed(error: string): Promise<void> {
    return this.update({
      status: "completed",
      conclusion: "failure",
      summary: `ReviewPhin could not complete the requested review.\n\n${error}`,
    });
  }

  private update(
    state: Parameters<GitHubClient["updateCheckRun"]>[0]["state"],
  ): Promise<void> {
    return this.client.updateCheckRun({
      repositoryFullName: this.tenant.repositoryFullName,
      checkRunId: this.trigger.checkRunId,
      state,
    });
  }
}

const STARTED_REACTION = "eyes";
const COMPLETED_REACTION = "hooray";
const FAILED_REACTION = "confused";

export class GitHubCommentTriggerLifecycle implements PlatformTriggerLifecycle {
  private readonly trigger: z.infer<typeof githubCommentTriggerSchema>;

  public constructor(
    private readonly client: GitHubClient,
    private readonly tenant: GitHubTenantConfig,
    job: InteractionJobRecord,
    private readonly botLogin: string,
  ) {
    this.trigger = githubCommentTriggerSchema.parse(
      JSON.parse(job.triggerJson),
    );
    if (this.trigger.repositoryId !== tenant.repositoryId) {
      throw new Error(
        `GitHub trigger repository ${this.trigger.repositoryId} does not match tenant repository ${tenant.repositoryId}`,
      );
    }
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

  private async ensureReaction(
    content: GitHubReaction["content"],
  ): Promise<void> {
    if (this.trigger.eventName !== "issue_comment") {
      return;
    }

    const existing = await this.client.listIssueCommentReactions(
      this.tenant.repositoryFullName,
      this.trigger.commentId,
    );
    if (
      existing.some(
        (reaction) =>
          reaction.content === content &&
          reaction.user?.login?.toLowerCase() === this.botLogin,
      )
    ) {
      return;
    }

    await this.client.createIssueCommentReaction({
      repositoryFullName: this.tenant.repositoryFullName,
      commentId: this.trigger.commentId,
      content,
    });
  }
}

function formatCompletedSummary(
  outcome: PlatformTriggerOutcome | undefined,
): string {
  if (!outcome) {
    return "ReviewPhin completed the requested review.";
  }

  const links =
    outcome.links?.map((link) => `- [${link.label}](${link.url})`) ?? [];
  return [outcome.summary, ...(links.length > 0 ? ["", ...links] : [])].join(
    "\n",
  );
}
