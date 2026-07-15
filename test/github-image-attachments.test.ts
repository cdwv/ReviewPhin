import { describe, expect, it, vi } from "vitest";

import {
  discoverGitHubImageAttachmentReferences,
  materializeGitHubImageAttachments,
} from "../src/platforms/github/image-attachments.js";
import { GitHubImageDownloadError } from "../src/platforms/github/client.js";

describe("discoverGitHubImageAttachmentReferences", () => {
  it("finds markdown and HTML images in the trigger comment and pull request description", () => {
    const duplicate =
      "https://github.com/user-attachments/assets/11111111-1111-1111-1111-111111111111";
    expect(
      discoverGitHubImageAttachmentReferences({
        pullRequest: {
          body: `<img src="https://user-images.githubusercontent.com/1/diagram.png" /> ![duplicate](${duplicate})`,
          html_url: "https://github.com/octo-org/reviewphin/pull/42",
        },
        triggerComment: {
          body: `@reviewphin inspect ![screenshot](${duplicate}) <img src='https://private-user-images.githubusercontent.com/2/mockup.webp?jwt=secret' />`,
          commentId: 55,
        },
      }),
    ).toEqual([
      {
        sourceKind: "trigger-comment",
        commentId: 55,
        url: duplicate,
      },
      {
        sourceKind: "trigger-comment",
        commentId: 55,
        url: "https://private-user-images.githubusercontent.com/2/mockup.webp?jwt=secret",
      },
      {
        sourceKind: "code-review-description",
        commentId: null,
        url: "https://user-images.githubusercontent.com/1/diagram.png",
      },
    ]);
  });

  it("keeps external image references so the secure downloader can report them as unavailable", () => {
    expect(
      discoverGitHubImageAttachmentReferences({
        pullRequest: {
          body: "",
          html_url: "https://github.com/octo-org/reviewphin/pull/42",
        },
        triggerComment: {
          body: "![external](https://example.com/private.png)",
          commentId: 55,
        },
      }),
    ).toEqual([
      {
        sourceKind: "trigger-comment",
        commentId: 55,
        url: "https://example.com/private.png",
      },
    ]);
  });
});

describe("materializeGitHubImageAttachments", () => {
  it("preserves successful images and reports failures without secret URL query parameters", async () => {
    const downloadImage = vi.fn(async (url: string) => {
      if (url.includes("success")) {
        return {
          data: "AQID",
          mimeType: "image/png",
          sizeBytes: 3,
        };
      }
      throw new GitHubImageDownloadError({
        message: "GitHub image request failed with status 403",
        status: 403,
        url,
      });
    });

    const result = await materializeGitHubImageAttachments({
      client: { downloadImage },
      references: [
        {
          sourceKind: "trigger-comment",
          commentId: 55,
          url: "https://user-images.githubusercontent.com/1/success.png",
        },
        {
          sourceKind: "code-review-description",
          commentId: null,
          url: "https://private-user-images.githubusercontent.com/2/failure.png?jwt=secret",
        },
      ],
    });

    expect(result.attachments).toEqual([
      {
        type: "blob",
        data: "AQID",
        mimeType: "image/png",
        displayName: "trigger-comment-55-success.png",
      },
    ]);
    expect(result.breadcrumbs).toEqual([
      {
        sourceKind: "trigger-comment",
        commentId: 55,
        displayName: "trigger-comment-55-success.png",
        contentType: "image/png",
      },
    ]);
    expect(result.issues).toEqual([
      {
        sourceKind: "code-review-description",
        commentId: null,
        displayName: "code-review-description-failure.png",
        status: 403,
        message: "GitHub image request failed with status 403",
        url: "https://private-user-images.githubusercontent.com/2/failure.png",
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("caps the number and aggregate size of images in one review run", async () => {
    const downloadImage = vi.fn(async () => ({
      data: "AQID",
      mimeType: "image/png",
      sizeBytes: 3,
    }));
    const references = Array.from({ length: 4 }, (_, index) => ({
      sourceKind: "trigger-comment" as const,
      commentId: 55,
      url: `https://user-images.githubusercontent.com/1/image-${index}.png`,
    }));

    const countLimited = await materializeGitHubImageAttachments({
      client: { downloadImage },
      references,
      maxAttachments: 2,
    });
    expect(downloadImage).toHaveBeenCalledTimes(2);
    expect(countLimited.attachments).toHaveLength(2);
    expect(countLimited.skipped).toHaveLength(2);
    expect(countLimited.issues).toEqual([
      expect.objectContaining({ status: 413, displayName: expect.any(String) }),
      expect.objectContaining({ status: 413, displayName: expect.any(String) }),
    ]);

    downloadImage.mockClear();
    const byteLimited = await materializeGitHubImageAttachments({
      client: { downloadImage },
      references: references.slice(0, 2),
      maxTotalBytes: 5,
    });
    expect(downloadImage).toHaveBeenNthCalledWith(1, references[0]!.url, {
      maxBytes: 5,
    });
    expect(downloadImage).toHaveBeenNthCalledWith(2, references[1]!.url, {
      maxBytes: 2,
    });
    expect(byteLimited.attachments).toHaveLength(1);
    expect(byteLimited.skipped).toHaveLength(1);
    expect(byteLimited.issues).toEqual([
      expect.objectContaining({ status: 413, displayName: expect.any(String) }),
    ]);
  });
});
