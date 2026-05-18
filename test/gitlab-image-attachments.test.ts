import { describe, expect, it } from "vitest";

import {
  discoverGitLabImageAttachmentReferences,
  materializeGitLabImageAttachments,
} from "../src/gitlab/image-attachments.js";
import { GitLabApiError } from "../src/gitlab/client.js";

describe("discoverGitLabImageAttachmentReferences", () => {
  it("finds markdown and html image references and resolves relative GitLab upload urls", () => {
    expect(
      discoverGitLabImageAttachmentReferences({
        mergeRequest: {
          description:
            'MR body ![Architecture](../uploads/xyz789/diagram.png)\n<img src="/group/project/-/uploads/qwe123/mockup.webp" />',
          project_id: 1085,
          web_url:
            "https://gitlab.example.com/group/project/-/merge_requests/7",
        },
        triggerNote: {
          noteId: 55,
          body: '@review-bot check this ![Screenshot](../uploads/abc123/note-image.png) <img src="https://gitlab.example.com/group/project/-/uploads/abc123/note-image.png" />',
        },
      }),
    ).toEqual([
      {
        sourceKind: "trigger-note",
        noteId: 55,
        url: "https://gitlab.example.com/-/project/1085/uploads/abc123/note-image.png",
      },
      {
        sourceKind: "merge-request-description",
        noteId: null,
        url: "https://gitlab.example.com/-/project/1085/uploads/xyz789/diagram.png",
      },
      {
        sourceKind: "merge-request-description",
        noteId: null,
        url: "https://gitlab.example.com/-/project/1085/uploads/qwe123/mockup.webp",
      },
    ]);
  });

  it("resolves root-relative upload paths against project-scoped gitlab urls", () => {
    expect(
      discoverGitLabImageAttachmentReferences({
        mergeRequest: {
          description: "",
          project_id: 965,
          web_url: "https://gitlab.example.com/-/project/965/merge_requests/12",
        },
        triggerNote: {
          noteId: 77,
          body: "![image.png](/uploads/a4e409a5e0d64b46d62752f4e31aa61f/image.png){width=323 height=156}",
        },
      }),
    ).toEqual([
      {
        sourceKind: "trigger-note",
        noteId: 77,
        url: "https://gitlab.example.com/-/project/965/uploads/a4e409a5e0d64b46d62752f4e31aa61f/image.png",
      },
    ]);
  });

  it("canonicalizes relative upload paths from namespace-based merge request urls", () => {
    expect(
      discoverGitLabImageAttachmentReferences({
        mergeRequest: {
          description: "",
          project_id: 1109,
          web_url:
            "https://gitlab.example.com/devops/gitlab-agentic-webhooks/-/merge_requests/18",
        },
        triggerNote: {
          noteId: 75943,
          body: "![image](../uploads/fdb9b4ef02371c7e3271fec3c2b9c790/image.png)",
        },
      }),
    ).toEqual([
      {
        sourceKind: "trigger-note",
        noteId: 75943,
        url: "https://gitlab.example.com/-/project/1109/uploads/fdb9b4ef02371c7e3271fec3c2b9c790/image.png",
      },
    ]);
  });

  it("preserves the configured GitLab base path for project-scoped upload urls", () => {
    expect(
      discoverGitLabImageAttachmentReferences({
        gitLabBaseUrl: "https://gitlab.example.com/gitlab",
        mergeRequest: {
          description: "",
          project_id: 1109,
          web_url:
            "https://gitlab.example.com/gitlab/devops/gitlab-agentic-webhooks/-/merge_requests/18",
        },
        triggerNote: {
          noteId: 75943,
          body: "![image](/uploads/fdb9b4ef02371c7e3271fec3c2b9c790/image.png)",
        },
      }),
    ).toEqual([
      {
        sourceKind: "trigger-note",
        noteId: 75943,
        url: "https://gitlab.example.com/gitlab/-/project/1109/uploads/fdb9b4ef02371c7e3271fec3c2b9c790/image.png",
      },
    ]);
  });

  it("preserves successful image downloads and surfaces GitLab API failures", async () => {
    const result = await materializeGitLabImageAttachments({
      client: {
        downloadImage: async (url: string) => {
          if (url.endsWith("ok.png")) {
            return {
              data: "AQID",
              mimeType: "image/png",
              sizeBytes: 3,
            };
          }

          throw new GitLabApiError(
            `GitLab image request failed for ${url} with 503`,
            503,
            "upstream unavailable",
            url,
          );
        },
      },
      references: [
        {
          sourceKind: "trigger-note",
          noteId: 55,
          url: "https://gitlab.example.com/-/project/1085/uploads/ok/ok.png",
        },
        {
          sourceKind: "merge-request-description",
          noteId: null,
          url: "https://gitlab.example.com/-/project/1085/uploads/fail/broken.png",
        },
      ],
    });

    expect(result.attachments).toEqual([
      {
        type: "blob",
        data: "AQID",
        mimeType: "image/png",
        displayName: "trigger-note-55-ok.png",
      },
    ]);
    expect(result.breadcrumbs).toEqual([
      {
        sourceKind: "trigger-note",
        noteId: 55,
        displayName: "trigger-note-55-ok.png",
        contentType: "image/png",
      },
    ]);
    expect(result.issues).toEqual([
      {
        sourceKind: "merge-request-description",
        noteId: null,
        displayName: "merge-request-description-broken.png",
        status: 503,
        message:
          "GitLab image request failed for https://gitlab.example.com/-/project/1085/uploads/fail/broken.png with 503",
        url: "https://gitlab.example.com/-/project/1085/uploads/fail/broken.png",
      },
    ]);
  });
});
