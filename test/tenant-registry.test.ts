import { describe, expect, it } from "vitest";

import type { GitLabNoteHookPayload } from "../src/gitlab/types.js";
import { TenantRegistry } from "../src/tenants/tenant-registry.js";

function createPayload(): GitLabNoteHookPayload {
  return {
    object_kind: "note",
    project: {
      id: 123,
      web_url: "https://gitlab.example.com/gitlab/group/project"
    },
    repository: {
      homepage: "https://gitlab.example.com/gitlab/group/project"
    },
    merge_request: {
      iid: 1,
      title: "MR",
      description: "",
      source_branch: "feature",
      target_branch: "main",
      last_commit: {
        id: "abc123"
      }
    },
    object_attributes: {
      id: 99,
      note: "/review",
      noteable_type: "MergeRequest",
      url: "https://gitlab.example.com/gitlab/group/project/-/merge_requests/1#note_99"
    }
  };
}

describe("TenantRegistry", () => {
  it("prefers the most specific baseUrl match for path-prefixed GitLab instances", async () => {
    const storage = {
      listTenants: async () => [],
      listTenantsByProjectId: async () => [
        {
          id: "tenant_root",
          key: "https://gitlab.example.com::123",
          baseUrl: "https://gitlab.example.com",
          projectId: 123,
          apiToken: "token-root",
          webhookSecret: "secret",
          botUserId: null,
          botUsername: null,
          modelProfileName: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        {
          id: "tenant_prefixed",
          key: "https://gitlab.example.com/gitlab::123",
          baseUrl: "https://gitlab.example.com/gitlab",
          projectId: 123,
          apiToken: "token-prefixed",
          webhookSecret: "secret",
          botUserId: null,
          botUsername: null,
          modelProfileName: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      getTenantById: async () => null
    };

    const registry = new TenantRegistry({
      storage: storage as never
    });

    const tenant = await registry.resolveWebhookTenant(createPayload(), "secret");
    expect(tenant?.id).toBe("tenant_prefixed");
  });
});
