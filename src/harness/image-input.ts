import sharp, { type Sharp } from "sharp";

import type { ModelInfo } from "@github/copilot-sdk";

import type { HarnessRunAttachment, HarnessRunAttachments } from "./types.js";

const IMAGE_FILE_EXTENSION_PATTERN =
  /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i;
const IMAGE_SIZE_TARGET_RATIO = 0.9;
const MAX_IMAGE_PROCESSING_ATTEMPTS = 6;
const MIN_IMAGE_DIMENSION = 64;

type VisionLimits = NonNullable<ModelInfo["capabilities"]["limits"]["vision"]>;
type BlobAttachment = Extract<HarnessRunAttachment, { type: "blob" }>;

export interface PreparedImageAttachmentDetail {
  displayName: string;
  originalBytes: number;
  processedBytes: number;
  originalMimeType: string;
  processedMimeType: string;
}

export interface PreparedImageAttachments {
  attachments: HarnessRunAttachments;
  omitted: HarnessRunAttachment[];
  processed: PreparedImageAttachmentDetail[];
}

export async function prepareImageAttachmentsForModel(
  attachments: HarnessRunAttachments,
  limits: VisionLimits,
): Promise<PreparedImageAttachments> {
  const prepared: HarnessRunAttachments = [];
  const omitted: HarnessRunAttachment[] = [];
  const processed: PreparedImageAttachmentDetail[] = [];
  const maxImages = normalizeLimit(limits.max_prompt_images);
  const maxImageBytes = normalizeLimit(limits.max_prompt_image_size);
  const supportedMimeTypes = new Set(
    limits.supported_media_types.map((mimeType) => mimeType.toLowerCase()),
  );
  let imageCount = 0;

  for (const attachment of attachments) {
    if (!attachmentRequiresVision(attachment)) {
      prepared.push(attachment);
      continue;
    }

    imageCount += 1;
    if (maxImages !== null && imageCount > maxImages) {
      omitted.push(attachment);
      continue;
    }

    if (attachment.type !== "blob") {
      prepared.push(attachment);
      continue;
    }

    const originalMimeType = attachment.mimeType.toLowerCase();
    const originalData = Buffer.from(attachment.data, "base64");
    const mimeTypeSupported =
      supportedMimeTypes.size === 0 || supportedMimeTypes.has(originalMimeType);
    const sizeSupported =
      maxImageBytes === null || originalData.byteLength <= maxImageBytes;

    if (mimeTypeSupported && sizeSupported) {
      prepared.push(attachment);
      continue;
    }

    if (maxImageBytes === 0) {
      omitted.push(attachment);
      continue;
    }

    try {
      const transformed = await transformImageAttachment({
        attachment,
        originalData,
        supportedMimeTypes,
        maxImageBytes,
      });
      prepared.push(transformed.attachment);
      processed.push(transformed.detail);
    } catch {
      omitted.push(attachment);
    }
  }

  return { attachments: prepared, omitted, processed };
}

export function attachmentRequiresVision(
  attachment: HarnessRunAttachment,
): boolean {
  if (attachment.type === "blob") {
    return attachment.mimeType.toLowerCase().startsWith("image/");
  }

  if (attachment.type === "file") {
    return (
      IMAGE_FILE_EXTENSION_PATTERN.test(attachment.path) ||
      (typeof attachment.displayName === "string" &&
        IMAGE_FILE_EXTENSION_PATTERN.test(attachment.displayName))
    );
  }

  return false;
}

async function transformImageAttachment(input: {
  attachment: BlobAttachment;
  originalData: Buffer;
  supportedMimeTypes: ReadonlySet<string>;
  maxImageBytes: number | null;
}): Promise<{
  attachment: BlobAttachment;
  detail: PreparedImageAttachmentDetail;
}> {
  const metadata = await sharp(input.originalData, {
    animated: false,
    failOn: "error",
    limitInputPixels: 100_000_000,
  }).metadata();
  const outputMimeType = selectOutputMimeType({
    originalMimeType: input.attachment.mimeType,
    supportedMimeTypes: input.supportedMimeTypes,
    hasAlpha: metadata.hasAlpha ?? false,
  });
  if (!outputMimeType) {
    throw new Error("No supported image output format is available");
  }

  const targetBytes =
    input.maxImageBytes === null
      ? null
      : Math.max(1, Math.floor(input.maxImageBytes * IMAGE_SIZE_TARGET_RATIO));
  let scale = 1;
  let processedData: Buffer | null = null;

  for (let attempt = 0; attempt < MAX_IMAGE_PROCESSING_ATTEMPTS; attempt += 1) {
    const pipeline = createImagePipeline(input.originalData, {
      width: metadata.width,
      height: metadata.height,
      scale,
    });
    processedData = await encodeImage(pipeline, outputMimeType);
    if (targetBytes === null || processedData.byteLength <= targetBytes) {
      break;
    }

    if (!metadata.width || !metadata.height) {
      processedData = null;
      break;
    }

    const reduction = Math.min(
      0.85,
      Math.sqrt(targetBytes / processedData.byteLength) * 0.95,
    );
    scale *= reduction;
    if (
      Math.floor(metadata.width * scale) < MIN_IMAGE_DIMENSION ||
      Math.floor(metadata.height * scale) < MIN_IMAGE_DIMENSION
    ) {
      processedData = null;
      break;
    }
  }

  if (
    !processedData ||
    (input.maxImageBytes !== null &&
      processedData.byteLength > input.maxImageBytes)
  ) {
    throw new Error("Image could not be processed within the model byte limit");
  }

  const displayName = withMimeTypeExtension(
    input.attachment.displayName,
    outputMimeType,
  );
  return {
    attachment: {
      ...input.attachment,
      data: processedData.toString("base64"),
      mimeType: outputMimeType,
      ...(displayName ? { displayName } : {}),
    },
    detail: {
      displayName: displayName ?? "image attachment",
      originalBytes: input.originalData.byteLength,
      processedBytes: processedData.byteLength,
      originalMimeType: input.attachment.mimeType,
      processedMimeType: outputMimeType,
    },
  };
}

function createImagePipeline(
  data: Buffer,
  input: {
    width?: number | undefined;
    height?: number | undefined;
    scale: number;
  },
): Sharp {
  let pipeline = sharp(data, {
    animated: false,
    failOn: "error",
    limitInputPixels: 100_000_000,
  }).rotate();

  if (input.scale < 1 && input.width && input.height) {
    pipeline = pipeline.resize({
      width: Math.max(
        MIN_IMAGE_DIMENSION,
        Math.floor(input.width * input.scale),
      ),
      height: Math.max(
        MIN_IMAGE_DIMENSION,
        Math.floor(input.height * input.scale),
      ),
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  return pipeline;
}

async function encodeImage(pipeline: Sharp, mimeType: string): Promise<Buffer> {
  switch (mimeType) {
    case "image/jpeg":
      return pipeline
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
    case "image/png":
      return pipeline.png({ compressionLevel: 9, effort: 3 }).toBuffer();
    case "image/webp":
      return pipeline.webp({ quality: 85, effort: 6 }).toBuffer();
    case "image/gif":
      return pipeline.gif({ effort: 7 }).toBuffer();
    default:
      throw new Error(`Unsupported image output MIME type: ${mimeType}`);
  }
}

function selectOutputMimeType(input: {
  originalMimeType: string;
  supportedMimeTypes: ReadonlySet<string>;
  hasAlpha: boolean;
}): string | null {
  const originalMimeType = input.originalMimeType.toLowerCase();
  const canUse = (mimeType: string): boolean =>
    input.supportedMimeTypes.size === 0 ||
    input.supportedMimeTypes.has(mimeType);
  const candidates = input.hasAlpha
    ? ["image/webp", "image/png", "image/jpeg", "image/gif"]
    : ["image/webp", "image/jpeg", "image/png", "image/gif"];

  if (
    ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
      originalMimeType,
    ) &&
    canUse(originalMimeType)
  ) {
    return originalMimeType;
  }

  return candidates.find(canUse) ?? null;
}

function withMimeTypeExtension(
  displayName: string | undefined,
  mimeType: string,
): string | undefined {
  if (!displayName) {
    return undefined;
  }

  const extension =
    mimeType === "image/jpeg"
      ? ".jpg"
      : mimeType === "image/png"
        ? ".png"
        : mimeType === "image/webp"
          ? ".webp"
          : mimeType === "image/gif"
            ? ".gif"
            : null;
  if (!extension) {
    return displayName;
  }

  return IMAGE_FILE_EXTENSION_PATTERN.test(displayName)
    ? displayName.replace(IMAGE_FILE_EXTENSION_PATTERN, extension)
    : `${displayName}${extension}`;
}

function normalizeLimit(value: number): number | null {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}
