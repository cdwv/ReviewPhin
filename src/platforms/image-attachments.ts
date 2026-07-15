import type {
  HarnessRunAttachment,
  HarnessRunAttachments,
} from "../harness/types.js";
import type {
  ReviewAttachment,
  ReviewAttachmentIssue,
  ReviewAttachmentSourceKind,
} from "../review/types.js";

export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_IMAGE_ATTACHMENTS_PER_RUN = 10;
export const DEFAULT_MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;
export const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export interface ImageResponseValidationFailure {
  contentType: string | null;
  reason: "empty" | "too-large";
  sizeBytes: number | null;
}

export interface PlatformImageAttachmentReference {
  commentId: number | null;
  sourceKind: ReviewAttachmentSourceKind;
  url: string;
}

export interface PlatformDownloadedImage {
  data: string;
  mimeType: string;
  sizeBytes: number;
}

export interface PlatformImageAttachmentSkip {
  message: string;
  commentId: number | null;
  sourceKind: ReviewAttachmentSourceKind;
  url: string;
}

export interface PlatformImageAttachmentMaterializationResult {
  attachments: HarnessRunAttachments;
  breadcrumbs: ReviewAttachment[];
  issues: ReviewAttachmentIssue[];
  skipped: PlatformImageAttachmentSkip[];
}

export function extractImageReferencesFromText<TReference>(
  text: string,
  resolveReference: (url: string) => TReference | null,
): TReference[] {
  const references: TReference[] = [];
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
      if (!rawUrl) {
        continue;
      }
      const normalizedUrl = rawUrl.trim().replace(/^<|>$/g, "");
      if (normalizedUrl.length === 0) {
        continue;
      }
      const reference = resolveReference(normalizedUrl);
      if (reference) {
        references.push(reference);
      }
    }
  }

  return references;
}

export function dedupeImageAttachmentReferences<
  TReference extends PlatformImageAttachmentReference,
>(references: ReadonlyArray<TReference>): TReference[] {
  const uniqueReferences = new Map<string, TReference>();
  for (const reference of references) {
    if (!uniqueReferences.has(reference.url)) {
      uniqueReferences.set(reference.url, reference);
    }
  }
  return [...uniqueReferences.values()];
}

export async function materializePlatformImageAttachments(input: {
  references: ReadonlyArray<PlatformImageAttachmentReference>;
  downloadImage: (
    url: string,
    maxBytes: number,
  ) => Promise<PlatformDownloadedImage>;
  classifyError: (
    error: unknown,
  ) =>
    | { kind: "issue"; message: string; status: number }
    | { kind: "skip"; message: string }
    | null;
  redactUrl?: ((url: string) => string) | undefined;
  maxAttachments?: number | undefined;
  maxBytesPerAttachment?: number | undefined;
  maxTotalBytes?: number | undefined;
}): Promise<PlatformImageAttachmentMaterializationResult> {
  const attachments: HarnessRunAttachments = [];
  const breadcrumbs: ReviewAttachment[] = [];
  const issues: ReviewAttachmentIssue[] = [];
  const skipped: PlatformImageAttachmentSkip[] = [];
  const maxAttachments =
    input.maxAttachments ?? DEFAULT_MAX_IMAGE_ATTACHMENTS_PER_RUN;
  const maxBytesPerAttachment =
    input.maxBytesPerAttachment ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxTotalBytes = input.maxTotalBytes ?? DEFAULT_MAX_TOTAL_IMAGE_BYTES;
  let totalBytes = 0;

  for (const [index, reference] of input.references.entries()) {
    if (index >= maxAttachments) {
      recordLimitSkip({
        reference,
        index,
        message: `Image was not downloaded because a review run accepts at most ${maxAttachments} referenced images`,
        issues,
        skipped,
        redactUrl: input.redactUrl,
      });
      continue;
    }
    const remainingBytes = maxTotalBytes - totalBytes;
    if (remainingBytes <= 0) {
      recordLimitSkip({
        reference,
        index,
        message: `Image was not downloaded because the review run reached its ${maxTotalBytes} byte image budget`,
        issues,
        skipped,
        redactUrl: input.redactUrl,
      });
      continue;
    }
    try {
      const downloadLimit = Math.min(maxBytesPerAttachment, remainingBytes);
      const downloaded = await input.downloadImage(
        reference.url,
        downloadLimit,
      );
      if (downloaded.sizeBytes > remainingBytes) {
        recordLimitSkip({
          reference,
          index,
          message: `Image was not included because it exceeds the review run's remaining ${remainingBytes} byte image budget`,
          issues,
          skipped,
          redactUrl: input.redactUrl,
        });
        continue;
      }
      const attachment = buildBlobAttachment(reference, downloaded, index);
      attachments.push(attachment);
      totalBytes += downloaded.sizeBytes;
      breadcrumbs.push({
        contentType: downloaded.mimeType,
        displayName:
          attachment.displayName ?? inferAttachmentLabel(reference, index),
        commentId: reference.commentId,
        sourceKind: reference.sourceKind,
      });
    } catch (error) {
      const disposition = input.classifyError(error);
      if (!disposition) {
        throw error;
      }
      const url = input.redactUrl?.(reference.url) ?? reference.url;
      if (disposition.kind === "skip") {
        skipped.push({
          message: disposition.message,
          commentId: reference.commentId,
          sourceKind: reference.sourceKind,
          url,
        });
      } else {
        issues.push({
          displayName: inferAttachmentLabel(reference, index),
          message: disposition.message,
          commentId: reference.commentId,
          sourceKind: reference.sourceKind,
          status: disposition.status,
          url,
        });
      }
    }
  }

  return { attachments, breadcrumbs, issues, skipped };
}

function recordLimitSkip(input: {
  reference: PlatformImageAttachmentReference;
  index: number;
  message: string;
  issues: ReviewAttachmentIssue[];
  skipped: PlatformImageAttachmentSkip[];
  redactUrl?: ((url: string) => string) | undefined;
}): void {
  const url = input.redactUrl?.(input.reference.url) ?? input.reference.url;
  input.skipped.push({
    message: input.message,
    commentId: input.reference.commentId,
    sourceKind: input.reference.sourceKind,
    url,
  });
  input.issues.push({
    displayName: inferAttachmentLabel(input.reference, input.index),
    message: input.message,
    commentId: input.reference.commentId,
    sourceKind: input.reference.sourceKind,
    status: 413,
    url,
  });
}

export function normalizeImageMimeType(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const [mimeType] = value.split(";", 1);
  const normalized = mimeType?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

export function parseImageContentLength(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function readLimitedImageResponse(
  response: Response,
  maxBytes: number,
  context: { contentType: string },
  createError: (failure: ImageResponseValidationFailure) => Error,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw createError({
        contentType: context.contentType,
        reason: "empty",
        sizeBytes: 0,
      });
    }
    if (buffer.byteLength > maxBytes) {
      throw createError({
        contentType: context.contentType,
        reason: "too-large",
        sizeBytes: buffer.byteLength,
      });
    }
    return buffer;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw createError({
        contentType: context.contentType,
        reason: "too-large",
        sizeBytes: totalBytes,
      });
    }
    chunks.push(Buffer.from(value));
  }
  if (totalBytes === 0) {
    throw createError({
      contentType: context.contentType,
      reason: "empty",
      sizeBytes: 0,
    });
  }
  return Buffer.concat(chunks, totalBytes);
}

function buildBlobAttachment(
  reference: PlatformImageAttachmentReference,
  downloaded: PlatformDownloadedImage,
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
  reference: PlatformImageAttachmentReference,
  index: number,
): string {
  const fileName = inferFileName(reference.url);
  const prefix =
    reference.sourceKind === "trigger-comment"
      ? `trigger-comment-${reference.commentId ?? "unknown"}`
      : "code-review-description";
  return `${prefix}-${fileName ?? `image-${index + 1}`}`;
}

function inferFileName(url: string): string | null {
  try {
    const parsed = new URL(url);
    const fileName = parsed.pathname.split("/").filter(Boolean).at(-1);
    return fileName
      ? decodeURIComponent(fileName).replace(/[\\/:*?"<>|]+/g, "-")
      : null;
  } catch {
    return null;
  }
}
