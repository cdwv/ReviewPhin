import type {
  HarnessRunAttachment,
  HarnessRunAttachments,
} from "../../harness/types.js";
import type {
  ReviewAttachment,
  ReviewAttachmentIssue,
  ReviewAttachmentSourceKind,
} from "../../review/types.js";
import {
  GitLabApiError,
  type GitLabClient,
  type GitLabDownloadedImage,
  GitLabImageDownloadError,
} from "./client.js";
import type { GitLabMergeRequest } from "./types.js";

export type GitLabImageAttachmentSourceKind =
  | "trigger-note"
  | "code-review-description";

export interface GitLabImageAttachmentReference {
  noteId: number | null;
  sourceKind: GitLabImageAttachmentSourceKind;
  url: string;
}

export interface GitLabImageAttachmentSkip {
  message: string;
  noteId: number | null;
  sourceKind: GitLabImageAttachmentSourceKind;
  url: string;
}

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
    noteId: number;
  };
}): GitLabImageAttachmentReference[] {
  const references = [
    ...extractImageReferencesFromText(input.triggerNote.body, {
      gitLabBaseUrl:
        input.gitLabBaseUrl ?? new URL(input.mergeRequest.web_url).origin,
      projectUrl: input.mergeRequest.web_url,
      projectId: input.mergeRequest.project_id,
      noteId: input.triggerNote.noteId,
      sourceKind: "trigger-note",
    }),
    ...extractImageReferencesFromText(input.mergeRequest.description ?? "", {
      gitLabBaseUrl:
        input.gitLabBaseUrl ?? new URL(input.mergeRequest.web_url).origin,
      projectUrl: input.mergeRequest.web_url,
      projectId: input.mergeRequest.project_id,
        noteId: null,
        sourceKind: "code-review-description",
      }),
  ];

  return dedupeAttachmentReferences(references);
}

export async function materializeGitLabImageAttachments(input: {
  client: Pick<GitLabClient, "downloadImage">;
  references: ReadonlyArray<GitLabImageAttachmentReference>;
}): Promise<GitLabImageAttachmentMaterializationResult> {
  const attachments: HarnessRunAttachments = [];
  const breadcrumbs: ReviewAttachment[] = [];
  const issues: ReviewAttachmentIssue[] = [];
  const skipped: GitLabImageAttachmentSkip[] = [];

  for (const [index, reference] of input.references.entries()) {
    try {
      const downloaded = await input.client.downloadImage(reference.url);
      const attachment = buildBlobAttachment(reference, downloaded, index);
      attachments.push(attachment);
      breadcrumbs.push({
        contentType: downloaded.mimeType,
        displayName:
          attachment.displayName ?? inferAttachmentLabel(reference, index),
        noteId: reference.noteId,
        sourceKind: reference.sourceKind,
      });
    } catch (error) {
      if (isSkippableAttachmentError(error)) {
        skipped.push({
          message: error.message,
          noteId: reference.noteId,
          sourceKind: reference.sourceKind,
          url: reference.url,
        });
        continue;
      }

      if (error instanceof GitLabApiError) {
        issues.push({
          displayName: inferAttachmentLabel(reference, index),
          message: error.message,
          noteId: reference.noteId,
          sourceKind: reference.sourceKind,
          status: error.status,
          url: reference.url,
        });
        continue;
      }

      throw error;
    }
  }

  return {
    attachments,
    breadcrumbs,
    issues,
    skipped,
  };
}

function extractImageReferencesFromText(
  text: string,
  context: {
    gitLabBaseUrl: string;
    projectUrl: string;
    projectId: number;
    noteId: number | null;
      sourceKind: ReviewAttachmentSourceKind;
  },
): GitLabImageAttachmentReference[] {
  const references: GitLabImageAttachmentReference[] = [];
  const patterns = [
    /!\[[^\]]*]\((?<url><[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g,
    /<img\b[^>]*\bsrc\s*=\s*(?:"(?<double>[^"]+)"|'(?<single>[^']+)'|(?<bare>[^\s>]+))/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const rawUrl =
        match.groups?.url ??
        match.groups?.double ??
        match.groups?.single ??
        match.groups?.bare;
      const resolvedUrl = resolveAttachmentUrl(
        rawUrl,
        context.projectUrl,
        context.gitLabBaseUrl,
        context.projectId,
      );
      if (!resolvedUrl) {
        continue;
      }

      references.push({
        noteId: context.noteId,
        sourceKind: context.sourceKind,
        url: resolvedUrl,
      });
    }
  }

  return references;
}

function resolveAttachmentUrl(
  rawUrl: string | undefined,
  projectUrl: string,
  gitLabBaseUrl: string,
  projectId: number,
): string | null {
  if (!rawUrl) {
    return null;
  }

  const normalizedRawUrl = rawUrl.trim().replace(/^<|>$/g, "");
  if (normalizedRawUrl.length === 0) {
    return null;
  }

  try {
    const uploadPath = extractGitLabUploadPath(normalizedRawUrl, projectUrl);
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

    const resolved = new URL(normalizedRawUrl, projectUrl);
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

function dedupeAttachmentReferences(
  references: ReadonlyArray<GitLabImageAttachmentReference>,
): GitLabImageAttachmentReference[] {
  const uniqueReferences = new Map<string, GitLabImageAttachmentReference>();

  for (const reference of references) {
    const key = [
      reference.sourceKind,
      reference.noteId ?? "mr-description",
      reference.url,
    ].join("::");
    if (!uniqueReferences.has(key)) {
      uniqueReferences.set(key, reference);
    }
  }

  return [...uniqueReferences.values()];
}

function buildBlobAttachment(
  reference: GitLabImageAttachmentReference,
  downloaded: GitLabDownloadedImage,
  index: number,
): Extract<HarnessRunAttachment, { type: "blob" }> {
  return {
    type: "blob",
    data: downloaded.data,
    mimeType: downloaded.mimeType,
    displayName: inferAttachmentLabel(reference, index),
  };
}

function inferAttachmentLabel(
  reference: GitLabImageAttachmentReference,
  index: number,
): string {
  const fileName = inferFileName(reference.url);
  const prefix =
    reference.sourceKind === "trigger-note"
      ? `trigger-note-${reference.noteId ?? "unknown"}`
      : "code-review-description";
  return `${prefix}-${fileName ?? `image-${index + 1}`}`;
}

function inferFileName(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const fileName = segments.at(-1);
    if (!fileName) {
      return null;
    }

    return decodeURIComponent(fileName).replace(/[\\/:*?"<>|]+/g, "-");
  } catch {
    return null;
  }
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
