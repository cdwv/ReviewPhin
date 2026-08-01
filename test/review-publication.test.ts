import { describe, expect, it } from "vitest";

import {
  getReviewPublicationMode,
  scopeReviewDedupeKeyToPublicationMode,
  setReviewPublicationMode,
} from "../src/review/publication.js";

describe("review publication mode", () => {
  it("treats triggers written before publication modes as publishing", () => {
    expect(getReviewPublicationMode('{"kind":"gitlab-comment"}')).toBe(
      "publish",
    );
    expect(getReviewPublicationMode(undefined)).toBe("publish");
  });

  it("adds the mode without changing native trigger fields", () => {
    const triggerJson = setReviewPublicationMode(
      JSON.stringify({ kind: "github-comment", commentId: 42 }),
      "no-publish",
    );

    expect(JSON.parse(triggerJson)).toEqual({
      kind: "github-comment",
      commentId: 42,
      publicationMode: "no-publish",
    });
    expect(getReviewPublicationMode(triggerJson)).toBe("no-publish");
  });

  it("keeps publishing dedupe keys stable and isolates local tests", () => {
    expect(scopeReviewDedupeKeyToPublicationMode("dedupe", "publish")).toBe(
      "dedupe",
    );
    const first = scopeReviewDedupeKeyToPublicationMode("dedupe", "no-publish");
    expect(first).not.toBe("dedupe");
    expect(first).toBe(
      scopeReviewDedupeKeyToPublicationMode("dedupe", "no-publish"),
    );
  });
});
