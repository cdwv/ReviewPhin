import { describe, expect, it, vi } from "vitest";

import { createGitHubProjectMemoryBackend } from "../src/platforms/github/project-memory-backend.js";
import type { ProjectMemoryRecord } from "../src/storage/contract/index.js";

describe("GitHub project memory", () => {
  it("uses configured storage when memory is enabled", async () => {
    const store = createProjectMemoryStore();
    const backend = createGitHubProjectMemoryBackend({
      stores: { projectMemories: store },
      tenantId: "tenant-1",
      enabled: true,
    });

    await expect(backend.getCapability()).resolves.toEqual({
      implemented: true,
      available: true,
    });

    await backend.saveEntries([
      { text: "Use Vitest for focused tests." },
      { text: "Use Vitest for focused tests." },
    ]);

    await expect(backend.load()).resolves.toMatchObject({
      enabled: true,
      page: null,
      entries: [{ text: "Use Vitest for focused tests." }],
    });
    await expect(store.get("tenant-1")).resolves.toMatchObject({
      id: "tenant-1",
      tenantId: "tenant-1",
    });
  });

  it("returns a disabled backend when memory is disabled", async () => {
    const store = createProjectMemoryStore();
    const backend = createGitHubProjectMemoryBackend({
      stores: { projectMemories: store },
      tenantId: "tenant-1",
      enabled: false,
    });

    await expect(backend.getCapability()).resolves.toEqual({
      implemented: true,
      available: false,
      reason: "Project memory is disabled by operator policy",
    });
    await expect(backend.load()).resolves.toEqual({
      enabled: false,
      page: null,
      entries: [],
    });
  });
});

function createProjectMemoryStore() {
  const records = new Map<string, ProjectMemoryRecord>();
  return {
    get: vi.fn(async (id: string) => records.get(id) ?? null),
    getMany: vi.fn(async (ids: string[]) =>
      ids.flatMap((id) => records.get(id) ?? []),
    ),
    find: vi.fn(async () => null),
    list: vi.fn(async () => [...records.values()]),
    upsert: vi.fn(async (record: ProjectMemoryRecord) => {
      records.set(record.id, record);
    }),
    upsertMany: vi.fn(async (entries: ProjectMemoryRecord[]) => {
      for (const record of entries) {
        records.set(record.id, record);
      }
    }),
    replace: vi.fn(async (record: ProjectMemoryRecord) => {
      records.set(record.id, record);
    }),
    replaceMany: vi.fn(async () => {}),
    update: vi.fn(async ({ id, value }) => {
      records.set(id, value);
    }),
    updateMany: vi.fn(async () => {}),
    patch: vi.fn(async ({ id, value }) => {
      const current = records.get(id);
      if (current) {
        records.set(id, { ...current, ...value });
      }
    }),
    patchMany: vi.fn(async () => {}),
    delete: vi.fn(async (id: string) => {
      records.delete(id);
    }),
    deleteMany: vi.fn(async (ids: string[]) => {
      for (const id of ids) {
        records.delete(id);
      }
    }),
  };
}
