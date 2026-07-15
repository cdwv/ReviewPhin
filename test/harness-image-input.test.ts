import { randomBytes } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { prepareImageAttachmentsForModel } from "../src/harness/image-input.js";

describe("prepareImageAttachmentsForModel", () => {
  it("keeps image blobs that already fit the selected model limits", async () => {
    const attachment = {
      type: "blob" as const,
      data: "AQID",
      mimeType: "image/png",
      displayName: "diagram.png",
    };

    const result = await prepareImageAttachmentsForModel([attachment], {
      supported_media_types: ["image/png"],
      max_prompt_images: 5,
      max_prompt_image_size: 3_145_728,
    });

    expect(result).toEqual({
      attachments: [attachment],
      omitted: [],
      processed: [],
    });
  });

  it("resizes an oversized PNG below the model byte limit", async () => {
    const width = 1_024;
    const height = 1_024;
    const source = await sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const maxImageBytes = 3 * 1_024 * 1_024;
    expect(source.byteLength).toBeGreaterThan(maxImageBytes);

    const result = await prepareImageAttachmentsForModel(
      [
        {
          type: "blob",
          data: source.toString("base64"),
          mimeType: "image/png",
          displayName: "trigger-comment-55-attachment",
        },
      ],
      {
        supported_media_types: ["image/jpeg", "image/png", "image/webp"],
        max_prompt_images: 5,
        max_prompt_image_size: maxImageBytes,
      },
    );

    expect(result.omitted).toEqual([]);
    expect(result.processed).toEqual([
      expect.objectContaining({
        displayName: "trigger-comment-55-attachment.png",
        originalBytes: source.byteLength,
        originalMimeType: "image/png",
        processedMimeType: "image/png",
      }),
    ]);
    const processed = result.attachments[0];
    expect(processed?.type).toBe("blob");
    if (processed?.type !== "blob") {
      throw new Error("Expected a blob attachment");
    }
    const processedData = Buffer.from(processed.data, "base64");
    expect(processedData.byteLength).toBeLessThanOrEqual(
      Math.floor(maxImageBytes * 0.9),
    );
    expect(processed.displayName).toBe("trigger-comment-55-attachment.png");
    expect((await sharp(processedData).metadata()).format).toBe("png");
  });

  it("re-encodes images into a MIME type supported by the model", async () => {
    const source = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: "#0088cc",
      },
    })
      .png()
      .toBuffer();

    const result = await prepareImageAttachmentsForModel(
      [
        {
          type: "blob",
          data: source.toString("base64"),
          mimeType: "image/png",
          displayName: "diagram.png",
        },
      ],
      {
        supported_media_types: ["image/jpeg"],
        max_prompt_images: 5,
        max_prompt_image_size: 1_000_000,
      },
    );

    const processed = result.attachments[0];
    expect(processed).toEqual(
      expect.objectContaining({
        type: "blob",
        mimeType: "image/jpeg",
        displayName: "diagram.jpg",
      }),
    );
    expect(result.omitted).toEqual([]);
  });

  it("omits images beyond the model count limit or that cannot be processed", async () => {
    const invalidOversizedImage = {
      type: "blob" as const,
      data: Buffer.alloc(32, 1).toString("base64"),
      mimeType: "image/png",
      displayName: "invalid.png",
    };
    const extraImage = {
      type: "blob" as const,
      data: "AQID",
      mimeType: "image/png",
      displayName: "extra.png",
    };

    const result = await prepareImageAttachmentsForModel(
      [invalidOversizedImage, extraImage],
      {
        supported_media_types: ["image/png"],
        max_prompt_images: 1,
        max_prompt_image_size: 8,
      },
    );

    expect(result.attachments).toEqual([]);
    expect(result.omitted).toEqual([invalidOversizedImage, extraImage]);
    expect(result.processed).toEqual([]);
  });
});
