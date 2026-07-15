import type { HarnessRunAttachments } from "../../harness/types.js";
import type {
  ReviewAttachment,
  ReviewAttachmentIssue,
} from "../../review/types.js";
import {
  dedupeImageAttachmentReferences,
  extractImageReferencesFromText,
  materializePlatformImageAttachments,
  type PlatformImageAttachmentSkip,
} from "../image-attachments.js";
import {
  type GitHubClient,
  GitHubImageDownloadError,
  redactGitHubImageUrl,
} from "./client.js";
import type { GitHubPullRequest } from "./client.js";

export interface GitHubImageAttachmentReference {
  commentId: number | null;
  sourceKind: "trigger-comment" | "code-review-description";
  url: string;
}

export interface GitHubImageAttachmentMaterializationResult {
  attachments: HarnessRunAttachments;
  breadcrumbs: ReviewAttachment[];
  issues: ReviewAttachmentIssue[];
  skipped: PlatformImageAttachmentSkip[];
}

export function discoverGitHubImageAttachmentReferences(input: {
  pullRequest: Pick<GitHubPullRequest, "body" | "html_url">;
  triggerComment?:
    | {
        body: string;
        commentId: number;
      }
    | undefined;
}): GitHubImageAttachmentReference[] {
  const references = [
    ...(input.triggerComment
      ? extractReferences(input.triggerComment.body, {
          baseUrl: input.pullRequest.html_url,
          commentId: input.triggerComment.commentId,
          sourceKind: "trigger-comment",
        })
      : []),
    ...extractReferences(input.pullRequest.body ?? "", {
      baseUrl: input.pullRequest.html_url,
      commentId: null,
      sourceKind: "code-review-description",
    }),
  ];
  return dedupeImageAttachmentReferences(references);
}

export function materializeGitHubImageAttachments(input: {
  client: Pick<GitHubClient, "downloadImage">;
  references: ReadonlyArray<GitHubImageAttachmentReference>;
}): Promise<GitHubImageAttachmentMaterializationResult> {
  return materializePlatformImageAttachments({
    references: input.references,
    downloadImage: (url) => input.client.downloadImage(url),
    classifyError: (error) =>
      error instanceof GitHubImageDownloadError
        ? {
            kind: "issue",
            message: error.message,
            status: error.status,
          }
        : null,
    redactUrl: redactGitHubImageUrl,
  });
}

function extractReferences(
  text: string,
  context: {
    baseUrl: string;
    commentId: number | null;
    sourceKind: GitHubImageAttachmentReference["sourceKind"];
  },
): GitHubImageAttachmentReference[] {
  return extractImageReferencesFromText(text, (rawUrl) => {
    try {
      const url = new URL(rawUrl, context.baseUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return null;
      }
      return {
        commentId: context.commentId,
        sourceKind: context.sourceKind,
        url: url.toString(),
      };
    } catch {
      return null;
    }
  });
}
