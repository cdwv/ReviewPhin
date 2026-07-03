import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";

describe("bot indexing policy", () => {
  const logger = createLogger("silent");
  let app: Awaited<ReturnType<typeof createApp>> | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("blocks indexing by default", async () => {
    app = await createApp({
      logger,
      tenantRegistry: {
        resolveWebhookTenant: async () => null,
      } as never,
      reviewWorker: {
        classifyWebhookTrigger: async () => null,
        createInteractionJobFromWebhook: async () => {
          throw new Error("unused");
        },
      } as never,
      queue: {
        enqueue: () => undefined,
      } as never,
      platforms: [],
    });

    const healthResponse = await app.inject({
      method: "GET",
      url: "/healthz",
    });
    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.headers["x-robots-tag"]).toContain("noindex");

    const robotsResponse = await app.inject({
      method: "GET",
      url: "/robots.txt",
    });
    expect(robotsResponse.statusCode).toBe(200);
    expect(robotsResponse.body).toContain("User-agent: *");
    expect(robotsResponse.body).toContain("Disallow: /");
    expect(robotsResponse.body).toContain("User-agent: GPTBot");
    expect(robotsResponse.body).toContain("User-agent: ClaudeBot");
  });

  it("only allows docs indexing when enabled globally", async () => {
    app = await createApp({
      logger,
      tenantRegistry: {
        resolveWebhookTenant: async () => null,
      } as never,
      reviewWorker: {
        classifyWebhookTrigger: async () => null,
        createInteractionJobFromWebhook: async () => {
          throw new Error("unused");
        },
      } as never,
      queue: {
        enqueue: () => undefined,
      } as never,
      platforms: [],
      allowBotIndexing: true,
    });

    const nonDocsResponse = await app.inject({
      method: "GET",
      url: "/healthz",
    });
    expect(nonDocsResponse.statusCode).toBe(200);
    expect(nonDocsResponse.headers["x-robots-tag"]).toContain("noindex");

    const docsResponse = await app.inject({
      method: "GET",
      url: "/docs/synthetic-indexing-check",
    });
    expect(docsResponse.headers["x-robots-tag"]).toBeUndefined();

    const robotsResponse = await app.inject({
      method: "GET",
      url: "/robots.txt",
    });
    expect(robotsResponse.statusCode).toBe(200);
    expect(robotsResponse.body).toContain("Disallow: /");
    expect(robotsResponse.body).toContain("Allow: /docs");
  });

  it("allows docs indexing for configured hosts while non-docs stay blocked", async () => {
    app = await createApp({
      logger,
      tenantRegistry: {
        resolveWebhookTenant: async () => null,
      } as never,
      reviewWorker: {
        classifyWebhookTrigger: async () => null,
        createInteractionJobFromWebhook: async () => {
          throw new Error("unused");
        },
      } as never,
      queue: {
        enqueue: () => undefined,
      } as never,
      platforms: [],
      botIndexingAllowedHosts: ["reviewphin.example.com"],
    });

    const blockedDocsResponse = await app.inject({
      method: "GET",
      url: "/docs/synthetic-indexing-check",
      headers: {
        host: "preview.reviewphin.example.com",
      },
    });
    expect(blockedDocsResponse.headers["x-robots-tag"]).toContain("noindex");

    const blockedNonDocsResponse = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: {
        host: "reviewphin.example.com:443",
      },
    });
    expect(blockedNonDocsResponse.headers["x-robots-tag"]).toContain(
      "noindex",
    );

    const allowedDocsResponse = await app.inject({
      method: "GET",
      url: "/docs/synthetic-indexing-check",
      headers: {
        host: "reviewphin.example.com:443",
      },
    });
    expect(allowedDocsResponse.headers["x-robots-tag"]).toBeUndefined();
  });
});
