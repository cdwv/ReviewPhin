import type {
  PlatformMaterializedWorkspace,
  PlatformReviewRoutingContext,
} from "../../src/platforms/IPlatform.js";

type GitLabLikeCodeReview = {
  iid: number;
  title: string;
  description?: string | null | undefined;
  web_url: string;
  author: {
    username: string | null;
  };
  source_branch: string;
  target_branch: string;
};

type GitLabLikeChange = {
  old_path: string;
  new_path: string;
  diff?: string | undefined;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
};

export function wrapGitLabPlatformContext<
  T extends {
    mergeRequest: GitLabLikeCodeReview;
    changes: GitLabLikeChange[];
    notes: ReadonlyArray<unknown>;
    discussions: ReadonlyArray<unknown>;
    workspace: PlatformMaterializedWorkspace;
    projectMemory: PlatformReviewRoutingContext["projectMemory"];
  },
>(context: T): PlatformReviewRoutingContext {
  return {
    codeReviewId: context.mergeRequest.iid,
    summaryContext: {
      codeReview: {
        id: context.mergeRequest.iid,
        title: context.mergeRequest.title,
        description: context.mergeRequest.description ?? "",
        webUrl: context.mergeRequest.web_url,
        authorUsername: context.mergeRequest.author.username,
        sourceBranch: context.mergeRequest.source_branch,
        targetBranch: context.mergeRequest.target_branch,
      },
      changes: context.changes.map((change) => ({
        oldPath: change.old_path,
        newPath: change.new_path,
        diff: change.diff,
        newFile: change.new_file,
        renamedFile: change.renamed_file,
        deletedFile: change.deleted_file,
      })),
    },
    workspace: context.workspace,
    projectMemory: context.projectMemory,
    changedFileCount: context.changes.length,
    commentCount: context.notes.length,
    discussionCount: context.discussions.length,
    platformContext: context,
  };
}
