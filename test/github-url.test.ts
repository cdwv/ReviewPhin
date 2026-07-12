import { describe, expect, it } from "vitest";

import { parseGitHubCommentUrl } from "../src/platforms/github/url.js";

describe("GitHub comment URL helpers", () => {
  it("parses canonical issue and review comment urls", () => {
    expect(
      parseGitHubCommentUrl(
        "https://github.com/octo/repo/pull/17#issuecomment-42",
      ),
    ).toEqual({
      url: "https://github.com/octo/repo/pull/17#issuecomment-42",
      kind: "issue-comment",
      owner: "octo",
      repository: "repo",
      codeReviewId: 17,
      commentId: 42,
    });
    expect(
      parseGitHubCommentUrl(
        "https://github.com/octo/repo/pull/17#discussion_r99",
      ),
    ).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        codeReviewId: 17,
        commentId: 99,
      }),
    );
  });

  it("rejects non-canonical GitHub urls", () => {
    for (const value of [
      "http://github.com/octo/repo/pull/17#issuecomment-42",
      "https://github.com/octo/repo/issues/17#issuecomment-42",
      "https://github.com/octo/repo/pull/17",
      "https://github.com/octo/repo/pull/17?diff=split#discussion_r99",
    ]) {
      expect(() => parseGitHubCommentUrl(value)).toThrow(
        /Unsupported GitHub comment URL/,
      );
    }
  });
});
