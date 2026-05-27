import { afterEach, describe, expect, it, vi } from "vitest";

import { GitLabClient } from "../src/platforms/gitlab/client.js";
import { createLogger } from "../src/logger.js";

function getRequestUrl(input: URL | RequestInfo): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function getRequestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") {
    return body;
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  throw new TypeError(
    `Unexpected request body type: ${body === null ? "null" : typeof body}`,
  );
}

describe("GitLabClient headers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("requests repository archives with a binary-compatible accept header", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(getRequestUrl(input)).toBe(
          "https://gitlab.example.com/api/v4/projects/1085/repository/archive.tar.gz?sha=abc123",
        );
        expect(new Headers(init?.headers).get("accept")).toBe(
          "application/octet-stream, application/x-gzip, */*",
        );
        expect(new Headers(init?.headers).get("private-token")).toBe("token");

        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "application/gzip",
          },
        });
      },
    );

    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    const archive = await client.downloadRepositoryArchive(1085, "abc123");
    expect(Array.from(archive)).toEqual([1, 2, 3]);
  });

  it("requests raw files without forcing json accept headers", async () => {
    const fetchMock = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("accept")).toBe("*/*");

        return new Response("file-content", {
          status: 200,
          headers: {
            "content-type": "text/plain",
          },
        });
      },
    );

    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    const content = await client.getRawFile(1085, "README.md", "abc123");
    expect(content).toBe("file-content");
  });

  it("fetches project wiki pages with the with_content query parameter when requested", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(getRequestUrl(input)).toBe(
          "https://gitlab.example.com/api/v4/projects/1085/wikis?with_content=1&page=1&per_page=100",
        );
        expect(new Headers(init?.headers).get("accept")).toBe(
          "application/json",
        );

        return new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "x-next-page": "",
            "content-type": "application/json",
          },
        });
      },
    );

    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    expect(
      await client.listProjectWikiPages(1085, { withContent: true }),
    ).toEqual([]);
  });

  it("updates project wiki pages using form-encoded content", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(getRequestUrl(input)).toBe(
          "https://gitlab.example.com/api/v4/projects/1085/wikis/Reviewphin-memory",
        );
        expect(new Headers(init?.headers).get("content-type")).toBe(
          "application/x-www-form-urlencoded",
        );
        const body = getRequestBodyText(init?.body);
        expect(body).toContain("title=Reviewphin+memory");
        expect(body).toContain("content=hello+world");

        return new Response(
          JSON.stringify({
            title: "Reviewphin memory",
            slug: "Reviewphin-memory",
            format: "markdown",
            content: "hello world",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    );

    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    const page = await client.updateProjectWikiPage(1085, "Reviewphin-memory", {
      title: "Reviewphin memory",
      content: "hello world",
    });
    expect(page.slug).toBe("Reviewphin-memory");
  });

  it("downloads on-host GitLab images as base64 blobs", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(getRequestUrl(input)).toBe(
          "https://gitlab.example.com/api/v4/projects/1085/uploads/abc123/diagram.png",
        );
        expect(new Headers(init?.headers).get("accept")).toBe("image/*, */*");

        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "3",
          },
        });
      },
    );
    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    await expect(
      client.downloadImage(
        "https://gitlab.example.com/-/project/1085/uploads/abc123/diagram.png",
      ),
    ).resolves.toEqual({
      data: "AQID",
      mimeType: "image/png",
      sizeBytes: 3,
    });
  });

  it("downloads path-prefixed project upload urls through the GitLab API", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(getRequestUrl(input)).toBe(
          "https://gitlab.example.com/gitlab/api/v4/projects/1085/uploads/abc123/diagram.png",
        );
        expect(new Headers(init?.headers).get("accept")).toBe("image/*, */*");

        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "3",
          },
        });
      },
    );
    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com/gitlab",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    await expect(
      client.downloadImage(
        "https://gitlab.example.com/gitlab/-/project/1085/uploads/abc123/diagram.png",
      ),
    ).resolves.toEqual({
      data: "AQID",
      mimeType: "image/png",
      sizeBytes: 3,
    });
  });

  it("rejects off-host GitLab image urls before fetching", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    await expect(
      client.downloadImage("https://cdn.example.com/uploads/diagram.png"),
    ).rejects.toMatchObject({
      name: "GitLabImageDownloadError",
      reason: "off-host",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported GitLab image content types", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>nope</html>", {
          status: 200,
          headers: {
            "content-type": "text/html",
          },
        }),
    );
    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    await expect(
      client.downloadImage(
        "https://gitlab.example.com/-/project/1085/uploads/abc123/diagram.png",
      ),
    ).rejects.toMatchObject({
      name: "GitLabImageDownloadError",
      reason: "unsupported-mime",
    });
  });

  it("rejects oversized GitLab images using the declared content length", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "3",
          },
        }),
    );
    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    await expect(
      client.downloadImage(
        "https://gitlab.example.com/-/project/1085/uploads/abc123/diagram.png",
        {
          maxBytes: 2,
        },
      ),
    ).rejects.toMatchObject({
      name: "GitLabImageDownloadError",
      reason: "too-large",
    });
  });

  it("emits request and response records to the GitLab request logger", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "disc_1", individual_note: false, notes: [] }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    );
    globalThis.fetch = fetchMock;

    const requestLogger = {
      log: vi.fn(async () => {}),
    };

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
      requestLogger,
    });

    await client.createCodeReviewDiscussion(1085, 7, {
      body: "Test body",
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
            body: "Test body",
          },
        }),
      }),
    );
    expect(requestLogger.log).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        phase: "response",
        status: 200,
        response: expect.objectContaining({
          body: expect.stringContaining('"disc_1"'),
        }),
      }),
    );
  });

  it("creates merge request draft notes with nested position payloads", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(getRequestUrl(input)).toBe(
          "https://gitlab.example.com/api/v4/projects/1085/merge_requests/7/draft_notes",
        );
        expect(new Headers(init?.headers).get("content-type")).toBe(
          "application/x-www-form-urlencoded",
        );
        const body = getRequestBodyText(init?.body);
        expect(body).toContain("note=Draft+body");
        expect(body).toContain("position%5Bbase_sha%5D=base");
        expect(body).toContain("position%5Bstart_sha%5D=start");
        expect(body).toContain("position%5Bhead_sha%5D=head");
        expect(body).toContain("position%5Bposition_type%5D=text");
        expect(body).toContain("position%5Bold_path%5D=src%2Fold.ts");
        expect(body).toContain("position%5Bnew_path%5D=src%2Fnew.ts");
        expect(body).toContain("position%5Bnew_line%5D=14");

        return new Response(
          JSON.stringify({
            id: 12,
            author_id: 999,
            merge_request_id: 7,
            resolve_discussion: false,
            discussion_id: null,
            note: "Draft body",
            position: null,
          }),
          {
            status: 201,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    );

    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    await expect(
      client.createCodeReviewDraftNote(1085, 7, {
        note: "Draft body",
        position: {
          base_sha: "base",
          start_sha: "start",
          head_sha: "head",
          position_type: "text",
          old_path: "src/old.ts",
          new_path: "src/new.ts",
          new_line: 14,
        },
      }),
    ).resolves.toMatchObject({
      id: 12,
      note: "Draft body",
    });
  });

  it("bulk publishes draft notes without requiring a response body", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(getRequestUrl(input)).toBe(
          "https://gitlab.example.com/api/v4/projects/1085/merge_requests/7/draft_notes/bulk_publish",
        );
        expect(init?.method).toBe("POST");

        return new Response(null, { status: 204 });
      },
    );

    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    await expect(
      client.bulkPublishCodeReviewDraftNotes(1085, 7),
    ).resolves.toBeUndefined();
  });

  it("lists merge request discussions with no-cache headers when requested", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(getRequestUrl(input)).toBe(
          "https://gitlab.example.com/api/v4/projects/1085/merge_requests/7/discussions?page=1&per_page=100",
        );

        const headers = new Headers(init?.headers);
        expect(headers.get("cache-control")).toBe("no-cache");
        expect(headers.get("pragma")).toBe("no-cache");

        return new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    );

    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    await expect(
      client.listCodeReviewDiscussions(1085, 7, { noCache: true }),
    ).resolves.toEqual([]);
  });

  it("lists merge request notes with no-cache headers when requested", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(getRequestUrl(input)).toBe(
          "https://gitlab.example.com/api/v4/projects/1085/merge_requests/7/notes?page=1&per_page=100",
        );

        const headers = new Headers(init?.headers);
        expect(headers.get("cache-control")).toBe("no-cache");
        expect(headers.get("pragma")).toBe("no-cache");

        return new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    );

    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    await expect(
      client.listCodeReviewNotes(1085, 7, { noCache: true }),
    ).resolves.toEqual([]);
  });

  it("deletes draft notes without requiring a response body", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(getRequestUrl(input)).toBe(
          "https://gitlab.example.com/api/v4/projects/1085/merge_requests/7/draft_notes/12",
        );
        expect(init?.method).toBe("DELETE");

        return new Response(null, { status: 204 });
      },
    );

    globalThis.fetch = fetchMock;

    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      apiToken: "token",
      logger: createLogger("silent"),
    });

    await expect(
      client.deleteCodeReviewDraftNote(1085, 7, 12),
    ).resolves.toBeUndefined();
  });
});
