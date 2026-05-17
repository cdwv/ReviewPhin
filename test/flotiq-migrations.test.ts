import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import { ensureCTDsExist } from "../src/storage/adapters/flotiq/migrations/v000.js";

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

    await ensureCTDsExist("test-api-key", logger);

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
