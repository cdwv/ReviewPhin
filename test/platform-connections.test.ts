import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGitLabTenantInput } from "./helpers/gitlab-tenant.js";
import { openSqliteTestStorage } from "./helpers/storage.js";

describe("platform connections", () => {
  it("enforces global names and resolves by name or id", async () => {
    const storage = await createStorage();
    const connection = await storage.createPlatformConnection({
      name: "primary",
      platform: "gitlab",
      status: "ready",
      platformConnectionConfigJson: '{"apiToken":"secret"}',
    });

    expect(await storage.resolvePlatformConnection("primary")).toEqual(
      connection,
    );
    expect(await storage.resolvePlatformConnection(connection.id)).toEqual(
      connection,
    );
    await expect(
      storage.createPlatformConnection({
        name: "primary",
        platform: "other",
        status: "setup_required",
        platformConnectionConfigJson: "{}",
      }),
    ).rejects.toThrow('name "primary" already exists');

    await storage.close();
  });

  it("preserves an existing tenant assignment and blocks connection deletion", async () => {
    const storage = await createStorage();
    const first = await storage.createPlatformConnection({
      name: "first",
      platform: "gitlab",
      status: "ready",
      platformConnectionConfigJson: "{}",
    });
    const second = await storage.createPlatformConnection({
      name: "second",
      platform: "gitlab",
      status: "ready",
      platformConnectionConfigJson: "{}",
    });
    const input = createGitLabTenantInput({
      platformConnectionId: first.id,
    });
    await storage.upsertTenant(input);
    const updated = await storage.upsertTenant({
      ...input,
      platformConnectionId: second.id,
      platformConfigJson: '{"projectId":123,"webhookSecret":"updated"}',
    });

    expect(updated.platformConnectionId).toBe(first.id);
    await expect(storage.deletePlatformConnection(first.id)).rejects.toThrow(
      updated.key,
    );
    await expect(storage.deletePlatformConnection(second.id)).resolves.toEqual(
      second,
    );

    await storage.close();
  });
});

async function createStorage() {
  const databasePath = join(
    await mkdtemp(join(tmpdir(), "reviewphin-platform-connections-")),
    "storage.sqlite",
  );
  return openSqliteTestStorage(databasePath);
}
