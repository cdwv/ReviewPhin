import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listAll } from "../src/storage/storage-helpers.js";
import { initializeStorageRuntime } from "../src/storage/runtime.js";
import {
  createGitLabConnectionRecord,
  createGitLabTenantInput,
} from "./helpers/gitlab-tenant.js";

describe("storage runtime", () => {
  it("loads the built-in sqlite provider and prepares storage", async () => {
    const databasePath = join(
      await mkdtemp(join(tmpdir(), "reviewphin-storage-runtime-")),
      "storage.sqlite",
    );
    const runtime = await initializeStorageRuntime({
      env: {
        ...process.env,
        SQLITE_DATABASE_PATH: databasePath,
      },
    });

    try {
      await runtime.storage.stores.platformConnections.upsert(
        createGitLabConnectionRecord(),
      );
      await runtime.storage.upsertTenant(createGitLabTenantInput());

      expect(await listAll(runtime.storage.stores.tenants)).toHaveLength(1);
      expect(runtime.preparation.appliedMigrationIds).toEqual([
        "sqlite:0001_v0_baseline",
        "sqlite:0002_v1_platform_tenants",
        "sqlite:0003_v1_review_entity_ids",
        "sqlite:0004_v1_tenant_scoped_reviews",
        "sqlite:0005_v1_code_review_snapshots",
        "sqlite:0006_v1_drop_legacy_tenant_columns",
        "sqlite:0007_v1_generic_storage_column_names",
        "sqlite:0008_v2_platform_connections",
        "sqlite:0009_v3_provider_triggers",
        "sqlite:0010_v4_project_memories",
        "sqlite:0011_v5_job_claims_and_reasoning_effort",
        "sqlite:0012_v6_session_metrics",
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
