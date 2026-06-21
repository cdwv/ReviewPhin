import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import ensureV002CtdsExist, {
  V002_CTDS,
} from "../src/storage/adapters/flotiq/migrations/v002.js";
import ensureV003CtdsExist, {
  V003_CTDS,
} from "../src/storage/adapters/flotiq/migrations/v003.js";

type FieldMeta = {
  helpText: string;
  hidden?: boolean;
  isTitlePart?: boolean;
  options?: string[];
  readonly?: boolean;
};

describe("Flotiq v002 CTD metadata", () => {
  it("protects immutable identities and tight relations", () => {
    expect(fieldMeta("platform_connection", "name")).toMatchObject({
      isTitlePart: true,
      readonly: true,
    });
    expect(fieldMeta("platform_connection", "platform")).toMatchObject({
      readonly: true,
    });
    expect(fieldMeta("tenant", "platformConnectionId")).toMatchObject({
      readonly: true,
    });
    expect(fieldMeta("interaction_job", "dedupeKey")).toMatchObject({
      readonly: true,
    });
  });

  it("keeps JSON and repairable runtime data editable and visible", () => {
    expect(
      fieldMeta("platform_connection", "platformConnectionConfigJson"),
    ).toMatchObject({
      hidden: false,
      readonly: false,
    });
    expect(fieldMeta("code_review_snapshot", "changesJson")).toMatchObject({
      hidden: false,
      readonly: false,
    });
    expect(fieldMeta("interaction_run_metrics", "inputTokens")).toMatchObject({
      readonly: false,
    });

    for (const ctd of V002_CTDS) {
      for (const fieldName of ctd.metaDefinition.order) {
        if (!fieldName.endsWith("Json")) {
          continue;
        }

        expect(fieldMeta(ctd.name, fieldName)).toMatchObject({
          hidden: false,
          readonly: false,
        });
      }
    }
  });

  it("exposes contract status options without using status as a title", () => {
    expect(fieldMeta("interaction_job", "status")).toMatchObject({
      isTitlePart: false,
      readonly: false,
      options: ["queued", "in_progress", "completed", "failed", "cancelled"],
    });
    expect(fieldMeta("review_finding", "status")).toMatchObject({
      isTitlePart: false,
      readonly: false,
      options: ["open", "resolved", "dismissed"],
    });
  });

  it("keeps populated help text concise", () => {
    for (const ctd of V002_CTDS) {
      for (const [fieldName, meta] of Object.entries(
        ctd.metaDefinition.propertiesConfig,
      )) {
        expect(
          meta.helpText.length,
          `${ctd.name}.${fieldName} helpText exceeds 150 characters`,
        ).toBeLessThanOrEqual(150);
      }
    }
  });
});

describe("Flotiq v003 provider trigger schema", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires provider trigger identity while making commentId optional", () => {
    const interactionJob = V003_CTDS.find(
      (candidate) => candidate.name === "interaction_job",
    )!;
    expect(interactionJob.schemaDefinition.allOf[1]!.properties).toHaveProperty(
      "triggerJson",
    );
    expect(interactionJob.schemaDefinition.required).not.toContain("commentId");
    expect(interactionJob.schemaDefinition.required).toContain("triggerJson");
  });

  it("pages through legacy jobs and backfills only missing trigger JSON in batches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const jobs = [
      ...Array.from({ length: 101 }, (_, index) =>
        createInteractionJob(`job-${index + 1}`, index + 1),
      ),
      createInteractionJob("job-existing", 999, '{"kind":"check_run"}'),
    ];
    const list = vi.fn(async ({ page = 1, limit = 100 }) => {
      const start = (page - 1) * limit;
      const data = jobs.slice(start, start + limit);
      return {
        data,
        total_count: jobs.length,
        count: data.length,
        total_pages: Math.ceil(jobs.length / limit),
        current_page: page,
      };
    });
    const batchUpdate = vi.fn(async (batch: Record<string, unknown>[]) => ({
      batch_total_count: batch.length,
      batch_success_count: batch.length,
      batch_error_count: 0,
      errors: [],
    }));

    await ensureV003CtdsExist("test-api-key", {
      content: {
        interaction_job: { list, batchUpdate },
      },
    } as never);

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(1, { page: 1, limit: 100 });
    expect(list).toHaveBeenNthCalledWith(2, { page: 2, limit: 100 });
    expect(batchUpdate).toHaveBeenCalledTimes(2);
    expect(batchUpdate.mock.calls[0]?.[0]).toHaveLength(100);
    expect(batchUpdate.mock.calls[1]?.[0]).toHaveLength(1);
    expect(batchUpdate.mock.calls.flatMap(([batch]) => batch)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "job-existing" })]),
    );
    expect(batchUpdate.mock.calls[0]?.[0]?.[0]).toMatchObject({
      id: "job-1",
      dedupeKey: "dedupe-job-1",
      commentId: 1,
      triggerJson: '{"kind":"comment","commentId":1}',
    });
    expect(batchUpdate.mock.calls[0]?.[0]?.[0]).not.toHaveProperty("internal");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).schemaDefinition
        .required,
    ).not.toContain("triggerJson");
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).schemaDefinition
        .required,
    ).toContain("triggerJson");
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      batchUpdate.mock.invocationCallOrder[0]!,
    );
    expect(batchUpdate.mock.invocationCallOrder.at(-1)).toBeLessThan(
      fetchMock.mock.invocationCallOrder[1]!,
    );
  });

  it("fails before writing a legacy job without a valid commentId", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const batchUpdate = vi.fn();
    const list = vi.fn(async () => ({
      data: [createInteractionJob("job-invalid", undefined)],
      total_count: 1,
      count: 1,
      total_pages: 1,
      current_page: 1,
    }));

    await expect(
      ensureV003CtdsExist("test-api-key", {
        content: {
          interaction_job: { list, batchUpdate },
        },
      } as never),
    ).rejects.toThrow(
      "Cannot migrate Flotiq interaction job job-invalid: missing valid commentId",
    );
    expect(batchUpdate).not.toHaveBeenCalled();
  });
});

describe("Flotiq CTD migration logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs through the injected logger instead of console", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (init?.method === "GET" && url.includes("/internal/contenttype/")) {
          return new Response(null, { status: 404 });
        }

        if (init?.method === "POST" && url.endsWith("/internal/contenttype")) {
          return new Response(null, { status: 201 });
        }

        throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
      });
    const consoleLogSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const logger = createLoggerMock();

    await ensureV002CtdsExist("test-api-key", logger);

    expect(fetchMock).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ ctdName: expect.any(String) }),
      "Ensuring Flotiq CTD exists.",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ ctdName: expect.any(String) }),
      "Flotiq CTD created.",
    );
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

function fieldMeta(ctdName: string, fieldName: string): FieldMeta {
  const ctd = V002_CTDS.find((candidate) => candidate.name === ctdName);
  if (!ctd) {
    throw new Error(`Unknown CTD: ${ctdName}`);
  }

  const meta = ctd.metaDefinition.propertiesConfig[fieldName];
  if (!meta) {
    throw new Error(`Unknown field: ${ctdName}.${fieldName}`);
  }

  return meta;
}

function createLoggerMock(): Logger {
  const logger = {
    child: vi.fn(() => logger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  return logger;
}

function createInteractionJob(
  id: string,
  commentId: number | undefined,
  triggerJson?: string,
): Record<string, unknown> {
  return {
    id,
    internal: {
      contentType: "interaction_job",
    },
    tenantId: [{ dataUrl: "/api/v1/content/tenant/tenant-1", type: "tenant" }],
    dedupeKey: `dedupe-${id}`,
    codeReviewId: 7,
    ...(commentId !== undefined ? { commentId } : {}),
    ...(triggerJson !== undefined ? { triggerJson } : {}),
    headSha: "abc123",
    status: "completed",
    payloadJson: "{}",
    retryCount: 0,
    enqueuedAt: "2026-06-11T00:00:00.000Z",
  };
}
