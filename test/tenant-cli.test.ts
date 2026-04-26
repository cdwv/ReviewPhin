import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { createLogger } from "../src/logger.js";
import { SqliteStorage } from "../src/storage/sqlite-storage.js";
import { TenantRegistry } from "../src/tenants/tenant-registry.js";

function createPayload() {
  return {
    object_kind: "note" as const,
    project: {
      id: 123,
      web_url: "https://gitlab.example.com/group/project"
    },
    repository: {
      homepage: "https://gitlab.example.com/group/project"
    },
    merge_request: {
      iid: 7,
      title: "Add worker",
      description: "Adds the worker",
      source_branch: "feature",
      target_branch: "main",
      last_commit: {
        id: "abc123"
      }
    },
    object_attributes: {
      id: 55,
      note: "please /review this",
      noteable_type: "MergeRequest" as const,
      url: "https://gitlab.example.com/group/project/-/merge_requests/7#note_55"
    }
  };
}

describe("tenant CLI", () => {
  it("adds a tenant to SQLite and makes it resolvable without env registration", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-"));
    const databasePath = join(workspace, "tenants.sqlite");

    const exitCode = await runCli([
      "tenant",
      "add",
      "--database-path",
      databasePath,
      "--base-url",
      "https://gitlab.example.com",
      "--project-id",
      "123",
      "--api-token",
      "glpat-xxxxxxxx",
      "--webhook-secret",
      "replace-me",
      "--bot-user-id",
      "999",
      "--bot-username",
      "review-bot"
    ]);

    expect(exitCode).toBe(0);

    const storage = new SqliteStorage({ databasePath });
    await storage.initialize();

    const tenants = await storage.listTenants();
    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({
      baseUrl: "https://gitlab.example.com",
      projectId: 123,
      botUserId: 999,
      botUsername: "review-bot"
    });

    const registry = new TenantRegistry({
      storage
    });
    await registry.initialize();

    const tenant = await registry.resolveWebhookTenant(createPayload(), "replace-me");
    expect(tenant).not.toBeNull();
    expect(tenant?.projectId).toBe(123);

    const logger = createLogger("silent");
    logger.info({ tenantId: tenant?.id }, "tenant resolved");
  });
});
