import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import ensureV002CtdsExist, {
  V002_CTDS,
} from "../src/storage/adapters/flotiq/migrations/v002.js";

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
