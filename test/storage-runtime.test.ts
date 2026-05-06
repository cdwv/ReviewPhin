import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listAll } from "../src/storage/storage-helpers.js";
import { initializeStorageRuntime } from "../src/storage/runtime.js";

describe("storage runtime", () => {
  it("loads the built-in sqlite provider and prepares storage", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "gitlab-agentic-webhooks-storage-runtime-")),
      "storage.sqlite",
    );
    const runtime = await initializeStorageRuntime({
      env: {
        ...process.env,
        SQLITE_DATABASE_PATH: databasePath,
      },
    });

    try {
      await runtime.storage.upsertTenant({
        baseUrl: "https://gitlab.example.com",
        projectId: 123,
        apiToken: "token",
        webhookSecret: "secret",
        botUserId: 999,
        botUsername: "review-bot",
      });

      expect(await listAll(runtime.storage.stores.tenants)).toHaveLength(1);
      expect(runtime.preparation.appliedMigrationIds).toEqual([
        "sqlite:0001_v0_baseline",
      ]);
    } finally {
      await runtime.provider.close();
    }
  });

  it("rejects incompatible provider contracts", async () => {
    const providerModule = join(
      process.cwd(),
      "test",
      "fixtures",
      "storage",
      "incompatible-provider.ts",
    );

    await expect(
      initializeStorageRuntime({
        providerModule,
        env: process.env,
      }),
    ).rejects.toThrow("supports storage-v999");
  });

  it("fails startup when provider preparation fails", async () => {
    const providerModule = join(
      process.cwd(),
      "test",
      "fixtures",
      "storage",
      "failing-provider.ts",
    );

    await expect(
      initializeStorageRuntime({
        providerModule,
        env: process.env,
      }),
    ).rejects.toThrow("fixture prepare failed");
  });
});
