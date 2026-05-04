import { describe, expect, it, vi } from "vitest";

import { ProjectMemoryConsolidator } from "../src/memory/consolidator.js";
import { ProjectMemoryService } from "../src/memory/service.js";

interface MemoryServiceTestLogger {
  warn: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
}

describe("ProjectMemoryService", () => {
  it("writes the new memory entry through the backend without leaking policy into the harness", async () => {
    const load = vi.fn(async () => ({
      enabled: true,
      page: null,
      entries: []
    }));
    const saveEntries = vi.fn(async () => ({
      enabled: true,
      page: null,
      entries: [{ text: "Remember this." }]
    }));
    const service = createService({
      backend: {
        load,
        saveEntries
      }
    });

    const result = await service.addEntry({
      memory: "Remember this.",
      rationale: "Durable policy",
      supersedes: []
    });

    expect(result.action).toBe("created");
    expect(load).toHaveBeenCalledOnce();
    expect(saveEntries).toHaveBeenCalledWith([{ text: "Remember this." }], {
      baseEntries: []
    });
  });

  it("retries the initial durable write against refreshed memory after a concurrent change", async () => {
    const saveEntries = vi
      .fn()
      .mockResolvedValueOnce({
        enabled: true,
        page: {
          title: "Reviewphin memory",
          slug: "reviewphin-memory",
          format: "markdown",
          content: ""
        },
        entries: [{ text: "Use Vitest for tests." }]
      })
      .mockResolvedValueOnce({
        enabled: true,
        page: {
          title: "Reviewphin memory",
          slug: "reviewphin-memory",
          format: "markdown",
          content: ""
        },
        entries: [{ text: "Use Vitest for tests." }, { text: "Remember this." }]
      });
    const service = createService({
      backend: {
        load: vi.fn(async () => ({
          enabled: true,
          page: {
            title: "Reviewphin memory",
            slug: "reviewphin-memory",
            format: "markdown",
            content: ""
          },
          entries: [{ text: "Use Jest for tests." }]
        })),
        saveEntries
      }
    });

    const result = await service.addEntry({
      memory: "Remember this.",
      rationale: "Durable policy",
      supersedes: []
    });

    expect(saveEntries).toHaveBeenNthCalledWith(
      1,
      [{ text: "Use Jest for tests." }, { text: "Remember this." }],
      {
        baseEntries: [{ text: "Use Jest for tests." }]
      }
    );
    expect(saveEntries).toHaveBeenNthCalledWith(
      2,
      [{ text: "Use Vitest for tests." }, { text: "Remember this." }],
      {
        baseEntries: [{ text: "Use Vitest for tests." }]
      }
    );
    expect(result.memory.entries).toEqual([{ text: "Use Vitest for tests." }, { text: "Remember this." }]);
  });

  it("serializes concurrent writes for the same tenant so additions are not lost", async () => {
    const enteredFirstSave = createDeferred();
    const releaseFirstSave = createDeferred();
    const sharedState = {
      page: {
        title: "Reviewphin memory",
        slug: "reviewphin-memory",
        format: "markdown" as const,
        content: ""
      },
      entries: [] as Array<{ text: string }>
    };
    let saveCallCount = 0;
    const backend = {
      load: vi.fn(async () => ({
        enabled: true,
        page: sharedState.page,
        entries: sharedState.entries.map((entry) => ({ ...entry }))
      })),
      saveEntries: vi.fn(async (entries) => {
        const callIndex = saveCallCount;
        saveCallCount += 1;
        if (callIndex === 0) {
          enteredFirstSave.resolve();
          await releaseFirstSave.promise;
        }

        sharedState.entries = entries.map((entry: { text: string }) => ({ ...entry }));
        return {
          enabled: true,
          page: sharedState.page,
          entries: sharedState.entries.map((entry) => ({ ...entry }))
        };
      })
    };
    const serviceA = createService({
      tenant: {
        id: "tenant-shared",
        baseUrl: "https://gitlab.example.com",
        projectId: 1085,
        apiToken: "token",
        memoryEnabled: true
      },
      backend
    });
    const serviceB = createService({
      tenant: {
        id: "tenant-shared",
        baseUrl: "https://gitlab.example.com",
        projectId: 1085,
        apiToken: "token",
        memoryEnabled: true
      },
      backend
    });

    const firstWrite = serviceA.addEntry({
      memory: "Remember A.",
      rationale: "Durable policy",
      supersedes: []
    });
    await enteredFirstSave.promise;

    const secondWrite = serviceB.addEntry({
      memory: "Remember B.",
      rationale: "Durable policy",
      supersedes: []
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(backend.load).toHaveBeenCalledTimes(1);

    releaseFirstSave.resolve();
    const [, secondResult] = await Promise.all([firstWrite, secondWrite]);

    expect(backend.load).toHaveBeenCalledTimes(2);
    expect(backend.saveEntries).toHaveBeenNthCalledWith(
      1,
      [{ text: "Remember A." }],
      {
        baseEntries: []
      }
    );
    expect(backend.saveEntries).toHaveBeenNthCalledWith(
      2,
      [{ text: "Remember A." }, { text: "Remember B." }],
      {
        baseEntries: [{ text: "Remember A." }]
      }
    );
    expect(secondResult.memory.entries).toEqual([{ text: "Remember A." }, { text: "Remember B." }]);
  });

  it("keeps the durable write when inline consolidation fails", async () => {
    const saveEntries = vi.fn(async () => ({
      enabled: true,
      page: {
        title: "Reviewphin memory",
        slug: "reviewphin-memory",
        format: "markdown",
        content: ""
      },
      entries: [
        { text: "A".repeat(4_800) },
        { text: "Remember this." }
      ]
    }));
    const logger = createLogger();
    const service = createService({
      logger,
      backend: {
        load: vi.fn(async () => ({
          enabled: true,
          page: {
            title: "Reviewphin memory",
            slug: "reviewphin-memory",
            format: "markdown",
            content: ""
          },
          entries: [{ text: "A".repeat(4_800) }]
        })),
        saveEntries
      },
      consolidator: {
        coalesce: vi.fn(async () => {
          throw new Error("boom");
        })
      } as never
    });

    const result = await service.addEntry({
      memory: "Remember this.",
      rationale: "Durable policy",
      supersedes: []
    });

    expect(result.changed).toBe(true);
    expect(saveEntries).toHaveBeenCalledTimes(1);
    expect(saveEntries).toHaveBeenCalledWith(
      [{ text: "A".repeat(4_800) }, { text: "Remember this." }],
      {
        baseEntries: [{ text: "A".repeat(4_800) }]
      }
    );
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("saves the consolidated entries inline when the memory grows past the threshold", async () => {
    const saveEntries = vi
      .fn()
      .mockResolvedValueOnce({
        enabled: true,
        page: {
          title: "Reviewphin memory",
          slug: "reviewphin-memory",
          format: "markdown",
          content: ""
        },
        entries: [
          { text: "A".repeat(4_800) },
          { text: "Remember this." }
        ]
      })
      .mockResolvedValueOnce({
        enabled: true,
        page: {
          title: "Reviewphin memory",
          slug: "reviewphin-memory",
          format: "markdown",
          content: ""
        },
        entries: [{ text: "Condensed memory." }]
      });
    const coalesce = vi.fn(async () => [{ text: "Condensed memory." }]);
    const service = createService({
      backend: {
        load: vi.fn(async () => ({
          enabled: true,
          page: {
            title: "Reviewphin memory",
            slug: "reviewphin-memory",
            format: "markdown",
            content: ""
          },
          entries: [{ text: "A".repeat(4_800) }]
        })),
        saveEntries
      },
      consolidator: {
        coalesce
      } as never
    });

    const result = await service.addEntry({
      memory: "Remember this.",
      rationale: "Durable policy",
      supersedes: []
    });

    expect(coalesce).toHaveBeenCalledOnce();
    expect(saveEntries).toHaveBeenNthCalledWith(
      1,
      [{ text: "A".repeat(4_800) }, { text: "Remember this." }],
      {
        baseEntries: [{ text: "A".repeat(4_800) }]
      }
    );
    expect(saveEntries).toHaveBeenNthCalledWith(2, [{ text: "Condensed memory." }], {
      baseEntries: [
        { text: "A".repeat(4_800) },
        { text: "Remember this." }
      ]
    });
    expect(result.memory.entries).toEqual([{ text: "Condensed memory." }]);
  });
});

function createService(input?: {
  logger?: ReturnType<typeof createLogger>;
  tenant?: {
    id: string;
    baseUrl: string;
    projectId: number;
    apiToken: string;
    memoryEnabled: boolean;
  };
  backend?: {
    load: ReturnType<typeof vi.fn>;
    saveEntries: ReturnType<typeof vi.fn>;
  };
  consolidator?: ProjectMemoryConsolidator;
}) {
  return new ProjectMemoryService({
    logger: (input?.logger ?? createLogger()) as never,
    backend: (input?.backend ?? {
      load: vi.fn(async () => ({
        enabled: true,
        page: null,
        entries: []
      })),
      saveEntries: vi.fn(async (entries) => ({
        enabled: true,
        page: null,
        entries
      }))
    }) as never,
    consolidator: input?.consolidator ?? ({
      coalesce: vi.fn(async (coalesceInput) => coalesceInput.coalesceInput.entries)
    } as never),
    modelConfig: {
      modelProfileName: "default",
      selectionSource: "default",
      reviewModel: "gpt-5.4",
      textGenerationModel: "gpt-5.4-mini",
      authToken: null,
      provider: undefined,
      providerBaseUrl: null,
      providerType: null
    },
    tenant: input?.tenant ?? {
      id: "tenant_1",
      baseUrl: "https://gitlab.example.com",
      projectId: 1085,
      apiToken: "token",
      memoryEnabled: true
    },
    logging: {
      interactionRunId: "run_1",
      interactionJobId: "job_1",
      tenantId: "tenant_1"
    },
    maxPromptMemoryChars: 5_000
  });
}

function createLogger() {
  return {
    warn: vi.fn(),
    child: vi.fn()
  } satisfies MemoryServiceTestLogger;
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return {
    promise,
    resolve
  };
}
