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
});
