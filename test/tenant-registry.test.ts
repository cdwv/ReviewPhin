import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logger.js";
import GitLabPlatform from "../src/platforms/gitlab/platform.js";
import type { GitLabNoteHookPayload } from "../src/platforms/gitlab/types.js";
import { TenantRegistry } from "../src/tenants/tenant-registry.js";
import { createGitLabTenantRecord } from "./helpers/gitlab-tenant.js";

function createPayload(): GitLabNoteHookPayload {
  return {
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
  };
}

function createStorageForTenants(...tenants: ReturnType<typeof createGitLabTenantRecord>[]) {
  return {
    stores: {
      tenants: {
        find: async (filters?: {
          key?: { eq?: string };
          platform?: { eq?: string };
        }) =>
          tenants.find(
            (tenant) =>
              tenant.key === filters?.key?.eq &&
              tenant.platform === filters?.platform?.eq,
          ) ?? null,
        get: async () => null,
      },
    },
  };
}

describe("TenantRegistry", () => {
  it("prefers the most specific baseUrl match for path-prefixed GitLab instances", async () => {
    const storage = createStorageForTenants(
      createGitLabTenantRecord({
        id: "tenant_root",
        apiToken: "token-root",
      }),
      createGitLabTenantRecord({
        id: "tenant_prefixed",
        baseUrl: "https://gitlab.example.com/gitlab",
        apiToken: "token-prefixed",
        botUserId: 1000,
        botUsername: "review-bot-prefixed",
      }),
    );

    const registry = new TenantRegistry({
      storage: storage as never,
    });
    const platform = new GitLabPlatform(createLogger("silent"));

    const tenant = await registry.resolveWebhookTenant(
      platform,
      createPayload(),
      {
        headers: {
          "x-gitlab-token": "secret",
        },
        body: createPayload(),
      },
    );
    expect(tenant?.id).toBe("tenant_prefixed");
  });

  it("resolves a tenant from repository.homepage when project.web_url is missing", async () => {
    const storage = createStorageForTenants(
      createGitLabTenantRecord({
        id: "tenant-prefixed",
        baseUrl: "https://gitlab.example.com/gitlab",
      }),
    );
    const registry = new TenantRegistry({
      storage: storage as never,
    });
    const platform = new GitLabPlatform(createLogger("silent"));
    const payload = createPayload();
    delete payload.project.web_url;

    const tenant = await registry.resolveWebhookTenant(platform, payload, {
      headers: {
        "x-gitlab-token": "secret",
      },
      body: payload,
    });

    expect(tenant?.id).toBe("tenant-prefixed");
  });
});
