import { afterEach, describe, expect, it, vi } from "vitest";

import { GitLabClient } from "../src/gitlab/client.js";
import { createLogger } from "../src/logger.js";

describe("GitLabClient headers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("requests repository archives with a binary-compatible accept header", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://gitlab.example.com/api/v4/projects/1085/repository/archive.tar.gz?sha=abc123"
      );
      expect(new Headers(init?.headers).get("accept")).toBe("application/octet-stream, application/x-gzip, */*");
      expect(new Headers(init?.headers).get("private-token")).toBe("token");

      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-type": "application/gzip"
        }
      });
    });

    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent")
    });

    const archive = await client.downloadRepositoryArchive(1085, "abc123");
    expect(Array.from(archive)).toEqual([1, 2, 3]);
  });

  it("requests raw files without forcing json accept headers", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("accept")).toBe("*/*");

      return new Response("file-content", {
        status: 200,
        headers: {
          "content-type": "text/plain"
        }
      });
    });

    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent")
    });

    const content = await client.getRawFile(1085, "README.md", "abc123");
    expect(content).toBe("file-content");
  });

  it("emits request and response records to the GitLab request logger", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "disc_1", individual_note: false, notes: [] }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const requestLogger = {
      log: vi.fn(async () => {})
    };

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
      requestLogger
    });

    await client.createMergeRequestDiscussion(1085, 7, {
      body: "Test body"
    });

    expect(requestLogger.log).toHaveBeenCalledTimes(2);
    expect(requestLogger.log).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        phase: "request",
        method: "POST",
        path: "/projects/1085/merge_requests/7/discussions",
        request: expect.objectContaining({
          body: {
            body: "Test body"
          }
        })
      })
    );
    expect(requestLogger.log).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        phase: "response",
        status: 200,
        response: expect.objectContaining({
          body: expect.stringContaining("\"disc_1\"")
        })
      })
    );
  });
});
