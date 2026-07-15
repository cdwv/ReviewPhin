import type { HarnessRunAttachments } from "../../harness/types.js";
import type {
  ReviewAttachment,
  ReviewAttachmentIssue,
} from "../../review/types.js";
import {
  dedupeImageAttachmentReferences,
  extractImageReferencesFromText as extractCommonImageReferencesFromText,
  materializePlatformImageAttachments,
  type PlatformImageAttachmentSkip,
} from "../image-attachments.js";
import {
  GitLabApiError,
  type GitLabClient,
  GitLabImageDownloadError,
} from "./client.js";
import type { GitLabMergeRequest } from "./types.js";

export type GitLabImageAttachmentSourceKind =
  "trigger-comment" | "code-review-description";

export interface GitLabImageAttachmentReference {
  commentId: number | null;
  sourceKind: GitLabImageAttachmentSourceKind;
  url: string;
}

export type GitLabImageAttachmentSkip = PlatformImageAttachmentSkip;

export interface GitLabImageAttachmentMaterializationResult {
  attachments: HarnessRunAttachments;
  breadcrumbs: ReviewAttachment[];
  issues: ReviewAttachmentIssue[];
  skipped: GitLabImageAttachmentSkip[];
}

export function discoverGitLabImageAttachmentReferences(input: {
  gitLabBaseUrl?: string;
  mergeRequest: Pick<
    GitLabMergeRequest,
    "description" | "project_id" | "web_url"
  >;
  triggerNote: {
    body: string;
    commentId: number;
  };
}): GitLabImageAttachmentReference[] {
  const references = [
    ...extractImageReferencesFromText(input.triggerNote.body, {
      gitLabBaseUrl:
        input.gitLabBaseUrl ?? new URL(input.mergeRequest.web_url).origin,
      projectUrl: input.mergeRequest.web_url,
      projectId: input.mergeRequest.project_id,
      commentId: input.triggerNote.commentId,
      sourceKind: "trigger-comment",
    }),
    ...extractImageReferencesFromText(input.mergeRequest.description ?? "", {
      gitLabBaseUrl:
        input.gitLabBaseUrl ?? new URL(input.mergeRequest.web_url).origin,
      projectUrl: input.mergeRequest.web_url,
      projectId: input.mergeRequest.project_id,
      commentId: null,
      sourceKind: "code-review-description",
    }),
  ];

  return dedupeImageAttachmentReferences(references);
}

export async function materializeGitLabImageAttachments(input: {
  client: Pick<GitLabClient, "downloadImage">;
  references: ReadonlyArray<GitLabImageAttachmentReference>;
}): Promise<GitLabImageAttachmentMaterializationResult> {
  return materializePlatformImageAttachments({
    references: input.references,
    downloadImage: (url) => input.client.downloadImage(url),
    classifyError: (error) => {
      if (isSkippableAttachmentError(error)) {
        return { kind: "skip", message: error.message };
      }
      if (error instanceof GitLabApiError) {
        return {
          kind: "issue",
          message: error.message,
          status: error.status,
        };
      }
      return null;
    },
  });
}

function extractImageReferencesFromText(
  text: string,
  context: {
    gitLabBaseUrl: string;
    projectUrl: string;
    projectId: number;
    commentId: number | null;
    sourceKind: GitLabImageAttachmentSourceKind;
  },
): GitLabImageAttachmentReference[] {
  return extractCommonImageReferencesFromText(text, (rawUrl) => {
    const resolvedUrl = resolveAttachmentUrl(
      rawUrl,
      context.projectUrl,
      context.gitLabBaseUrl,
      context.projectId,
    );
    return resolvedUrl
      ? {
          commentId: context.commentId,
          sourceKind: context.sourceKind,
          url: resolvedUrl,
        }
      : null;
  });
}

function resolveAttachmentUrl(
  rawUrl: string,
  projectUrl: string,
  gitLabBaseUrl: string,
  projectId: number,
): string | null {
  try {
    const uploadPath = extractGitLabUploadPath(rawUrl, projectUrl);
    if (uploadPath) {
      const projectScopedUploadUrl = buildProjectScopedUploadUrl(
        gitLabBaseUrl,
        projectId,
        uploadPath,
      );
      if (projectScopedUploadUrl) {
        return projectScopedUploadUrl;
      }
    }

    const resolved = new URL(rawUrl, projectUrl);
    return /^https?:$/i.test(resolved.protocol) ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function buildProjectScopedUploadUrl(
  gitLabBaseUrl: string,
  projectId: number,
  uploadPath: string,
): string | null {
  const parsedBaseUrl = new URL(gitLabBaseUrl);
  const scopedUploadUrl = new URL(parsedBaseUrl.origin);
  const basePath = stripTrailingSlashes(parsedBaseUrl.pathname);
  scopedUploadUrl.pathname =
    `${basePath}/-/project/${encodeURIComponent(String(projectId))}${uploadPath}`.replace(
      /\/{2,}/g,
      "/",
    );
  return scopedUploadUrl.toString();
}

function extractGitLabUploadPath(
  rawUrl: string,
  baseUrl: string,
): string | null {
  if (rawUrl.startsWith("/uploads/")) {
    return rawUrl;
  }

  const resolved = new URL(rawUrl, baseUrl);
  if (!/^https?:$/i.test(resolved.protocol)) {
    return null;
  }

  const uploadIndex = resolved.pathname.indexOf("/uploads/");
  if (uploadIndex < 0) {
    return null;
  }

  return resolved.pathname.slice(uploadIndex);
}

function stripTrailingSlashes(value: string): string {
  if (value === "/") {
    return "";
  }

  return value.replace(/\/+$/, "");
}

function isSkippableAttachmentError(
  error: unknown,
): error is GitLabApiError | GitLabImageDownloadError {
  return (
    error instanceof GitLabImageDownloadError ||
    (error instanceof GitLabApiError &&
      error.status === 404 &&
      error.requestUrl.includes("/uploads/"))
  );
}
