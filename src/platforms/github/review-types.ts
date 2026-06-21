import type { ProjectMemoryContext } from "../../memory/types.js";
import type {
  CodeReviewSnapshotRecord,
  InteractionJobRecord,
  TenantRecord,
} from "../../storage/contract/current.js";
import type { PlatformMaterializedWorkspace } from "../IPlatform.js";
import type {
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubPullRequestFile,
  GitHubPullRequestReview,
  GitHubReviewComment,
  GitHubReviewThread,
} from "./client.js";

export interface GitHubPullRequestContext {
  tenant: TenantRecord;
  job: InteractionJobRecord;
  repositoryFullName: string;
  pullRequest: GitHubPullRequest;
  files: GitHubPullRequestFile[];
  issueComments: GitHubIssueComment[];
  reviews: GitHubPullRequestReview[];
  reviewComments: GitHubReviewComment[];
  reviewThreads: GitHubReviewThread[];
  workspace: PlatformMaterializedWorkspace;
  projectMemory: ProjectMemoryContext;
}

export interface HydratedGitHubPullRequestContext extends GitHubPullRequestContext {
  snapshot: CodeReviewSnapshotRecord;
}
