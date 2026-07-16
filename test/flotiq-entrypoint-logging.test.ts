import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

const {
  ensureV002CtdsExistMock,
  ensureV003CtdsExistMock,
  ensureV004CtdsExistMock,
  ensureV005CtdsExistMock,
  ensureV006CtdsExistMock,
  listMigrationsMock,
  createMigrationMock,
} = vi.hoisted(() => ({
  ensureV002CtdsExistMock: vi.fn(),
  ensureV003CtdsExistMock: vi.fn(),
  ensureV004CtdsExistMock: vi.fn(),
  ensureV005CtdsExistMock: vi.fn(),
  ensureV006CtdsExistMock: vi.fn(),
  listMigrationsMock: vi.fn(),
  createMigrationMock: vi.fn(),
}));

vi.mock("@flotiq/flotiq-api-sdk", () => ({
  Flotiq: vi.fn(function FlotiqMock() {
    return {
      content: {
        migrations: {
          list: listMigrationsMock,
          create: createMigrationMock,
        },
      },
    };
  }),
}));

vi.mock("../src/storage/adapters/flotiq/migrations/v002.js", () => ({
  default: ensureV002CtdsExistMock,
}));

vi.mock("../src/storage/adapters/flotiq/migrations/v003.js", () => ({
  default: ensureV003CtdsExistMock,
}));

vi.mock("../src/storage/adapters/flotiq/migrations/v004.js", () => ({
  default: ensureV004CtdsExistMock,
}));

vi.mock("../src/storage/adapters/flotiq/migrations/v005.js", () => ({
  default: ensureV005CtdsExistMock,
}));

vi.mock("../src/storage/adapters/flotiq/migrations/v006.js", () => ({
  default: ensureV006CtdsExistMock,
}));

import { createStorageProvider } from "../src/storage/adapters/flotiq/entrypoint.js";

describe("Flotiq storage provider logging", () => {
  beforeEach(() => {
    ensureV002CtdsExistMock.mockReset();
    ensureV003CtdsExistMock.mockReset();
    ensureV004CtdsExistMock.mockReset();
    ensureV005CtdsExistMock.mockReset();
    ensureV006CtdsExistMock.mockReset();
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

      expect(ensureV002CtdsExistMock).toHaveBeenCalledWith(
        "test-api-key",
        logger,
      );
      expect(ensureV003CtdsExistMock).toHaveBeenCalledWith(
        "test-api-key",
        expect.any(Object),
        logger,
      );
      expect(createMigrationMock).toHaveBeenCalledWith({ name: "v002" });
      expect(createMigrationMock).toHaveBeenCalledWith({ name: "v003" });
      expect(createMigrationMock).toHaveBeenCalledWith({ name: "v004" });
      expect(createMigrationMock).toHaveBeenCalledWith({ name: "v005" });
      expect(createMigrationMock).toHaveBeenCalledWith({ name: "v006" });
      expect(logger.info).toHaveBeenCalledWith(
        { migrationId: "v002" },
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
      appliedMigrationIds: ["v002", "v003", "v004", "v005", "v006"],
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
