import { describe, expect, it } from "vitest";

import {
  buildGitLabApiUrl,
  normalizeGitLabBaseUrl,
  urlMatchesGitLabBase,
} from "../src/platforms/gitlab/url.js";
import {
  parseGitLabNoteHook,
  webhookMatchesGitLabBase,
} from "../src/platforms/gitlab/webhook.js";

describe("GitLab URL helpers", () => {
  it("preserves path-prefixed GitLab instances when building api urls", () => {
    expect(
      normalizeGitLabBaseUrl("https://gitlab.example.com/gitlab/api/v4"),
    ).toBe("https://gitlab.example.com/gitlab");
    expect(
      buildGitLabApiUrl(
        "https://gitlab.example.com/gitlab/",
        "/projects/1085/merge_requests/1",
      ).toString(),
    ).toBe(
      "https://gitlab.example.com/gitlab/api/v4/projects/1085/merge_requests/1",
    );
  });

  it("matches webhook urls against a path-prefixed tenant base url", () => {
    expect(
      urlMatchesGitLabBase(
        "https://gitlab.example.com/gitlab/group/project/-/merge_requests/1#note_1",
        "https://gitlab.example.com/gitlab",
      ),
    ).toBe(true);
  });

  it("matches webhook payload urls against a path-prefixed tenant base url", () => {
    expect(
      webhookMatchesGitLabBase(
        {
          object_kind: "note",
          project: {
            id: 123,
            web_url: "https://gitlab.example.com/gitlab/group/project",
            path_with_namespace: "group/project",
          },
          repository: {
            homepage: "https://gitlab.example.com/gitlab/group/project",
          },
          merge_request: {
            iid: 1,
            title: "MR",
            description: "",
            source_branch: "feature",
            target_branch: "main",
            last_commit: {
              id: "abc123",
            },
          },
          object_attributes: {
            id: 99,
            note: "/review",
            noteable_type: "MergeRequest",
            url: "https://gitlab.example.com/gitlab/group/project/-/merge_requests/1#note_99",
          },
        },
        "https://gitlab.example.com/gitlab",
      ),
    ).toBe(true);
  });

  it("rejects note hook payloads that omit path_with_namespace", () => {
    expect(() =>
      parseGitLabNoteHook({
        object_kind: "note",
        project: {
          id: 123,
          web_url: "https://gitlab.example.com/gitlab/group/project",
        },
        repository: {
          homepage: "https://gitlab.example.com/gitlab/group/project",
        },
        merge_request: {
          iid: 1,
          title: "MR",
          description: "",
          source_branch: "feature",
          target_branch: "main",
          last_commit: {
            id: "abc123",
          },
        },
        object_attributes: {
          id: 99,
          note: "/review",
          noteable_type: "MergeRequest",
          url: "https://gitlab.example.com/gitlab/group/project/-/merge_requests/1#note_99",
        },
      }),
    ).toThrow();
  });
});
