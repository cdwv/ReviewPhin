import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("treats a blank PLATFORM_MODULES value as the default module list", () => {
    const config = loadConfig({
      PLATFORM_MODULES: "",
    });

    expect(config.platformModules).toEqual([]);
  });

  it("defaults PUBLIC_URL to the local development server", () => {
    expect(loadConfig({ PORT: "4123" }).publicUrl).toBe(
      "http://localhost:4123",
    );
    expect(
      loadConfig({ PUBLIC_URL: "https://review.example.com/" }).publicUrl,
    ).toBe("https://review.example.com");
  });

  it("blocks bot indexing by default", () => {
    const config = loadConfig({});

    expect(config.allowBotIndexing).toBe(false);
    expect(config.botIndexingAllowedHosts).toEqual([]);
  });

  it("parses bot indexing host allowlist and global override", () => {
    const config = loadConfig({
      REVIEWPHIN_ALLOW_BOT_INDEXING: "true",
      REVIEWPHIN_BOT_INDEXING_ALLOWED_HOSTS:
        " reviewphin.example.com, docs.reviewphin.example.com ",
    });

    expect(config.allowBotIndexing).toBe(true);
    expect(config.botIndexingAllowedHosts).toEqual([
      "reviewphin.example.com",
      "docs.reviewphin.example.com",
    ]);
  });

  it("defaults the job runner configuration", () => {
    const config = loadConfig({});

    expect(config.jobPollIntervalMs).toBe(2_000);
    expect(config.maxQueuedJobAgeMs).toBe(21_600_000);
    expect(config.jobLeaseMs).toBe(120_000);
    expect(config.jobRunnerEnabled).toBe(true);
  });

  it("parses job runner configuration overrides", () => {
    const config = loadConfig({
      REVIEWPHIN_JOB_POLL_INTERVAL_MS: "500",
      REVIEWPHIN_MAX_QUEUED_JOB_AGE_MS: "60000",
      REVIEWPHIN_JOB_LEASE_MS: "5000",
      REVIEWPHIN_JOB_RUNNER_ENABLED: "false",
    });

    expect(config.jobPollIntervalMs).toBe(500);
    expect(config.maxQueuedJobAgeMs).toBe(60_000);
    expect(config.jobLeaseMs).toBe(5_000);
    expect(config.jobRunnerEnabled).toBe(false);
  });

  it("rejects non-positive poll and max-age durations", () => {
    expect(() =>
      loadConfig({ REVIEWPHIN_JOB_POLL_INTERVAL_MS: "0" }),
    ).toThrow();
    expect(() =>
      loadConfig({ REVIEWPHIN_MAX_QUEUED_JOB_AGE_MS: "-1" }),
    ).toThrow();
  });

  it("rejects a job lease shorter than the 1000ms minimum", () => {
    expect(() => loadConfig({ REVIEWPHIN_JOB_LEASE_MS: "999" })).toThrow();
    expect(loadConfig({ REVIEWPHIN_JOB_LEASE_MS: "1000" }).jobLeaseMs).toBe(
      1_000,
    );
  });
});
