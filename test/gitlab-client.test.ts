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
});
