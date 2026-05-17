import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

const { ensureCTDsExistMock, listMigrationsMock, createMigrationMock } =
  vi.hoisted(() => ({
    ensureCTDsExistMock: vi.fn(),
    listMigrationsMock: vi.fn(),
    createMigrationMock: vi.fn(),
  }));

vi.mock("@flotiq/flotiq-api-sdk", () => ({
  Flotiq: vi.fn().mockImplementation(() => ({
    content: {
      migrations: {
        list: listMigrationsMock,
        create: createMigrationMock,
      },
    },
  })),
}));

vi.mock("../src/storage/adapters/flotiq/migrations/v000.js", () => ({
  default: ensureCTDsExistMock,
}));

import { createStorageProvider } from "../src/storage/adapters/flotiq/entrypoint.js";

describe("Flotiq storage provider logging", () => {
  beforeEach(() => {
    ensureCTDsExistMock.mockReset();
    listMigrationsMock.mockReset();
    createMigrationMock.mockReset();
  });

  it("uses the injected logger while preparing migrations", async () => {
    listMigrationsMock.mockResolvedValue({ data: [] });
    createMigrationMock.mockResolvedValue(undefined);

    const logger = createLoggerMock();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const consoleLogSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    try {
      const provider = createStorageProvider({
        env: { FLOTIQ_API_KEY: "test-api-key" },
        logger,
      });

      await provider.prepare();

      expect(ensureCTDsExistMock).toHaveBeenCalledWith("test-api-key", logger);
      expect(createMigrationMock).toHaveBeenCalledWith({ name: "v000" });
      expect(logger.info).toHaveBeenCalledWith(
        { migrationId: "v000" },
        "Applied Flotiq migration.",
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it("returns applied migration ids after creating missing records", async () => {
    listMigrationsMock.mockResolvedValue({ data: [] });
    createMigrationMock.mockResolvedValue(undefined);

    const provider = createStorageProvider({
      env: { FLOTIQ_API_KEY: "test-api-key" },
    });

    await expect(provider.prepare()).resolves.toMatchObject({
      appliedMigrationIds: ["v000"],
    });
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
