import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";
import type { IPlatform } from "../src/platforms/IPlatform.js";

describe("provider setup routes", () => {
  const logger = createLogger("silent");
  let app: Awaited<ReturnType<typeof createApp>> | null = null;

  vi.setConfig({ testTimeout: 15_000 });

  afterAll(() => {
    vi.resetConfig();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("mounts a provider setup handler under the platform setup prefix", async () => {
    const platform: IPlatform = {
      getPlatformInfo: () => ({
        name: "Setup Test",
        description: "Setup test platform",
        slug: "setup-test",
      }),
      getSetupHandler:
        () =>
        async ({ reply, request, context }) => {
          reply.code(200).send({
            method: request.method,
            pathSuffix: context.pathSuffix,
            rawBody: context.rawBody.toString("utf8"),
          });
        },
      getTenantKey: () => "unused",
      parseWebhookPayload: (payload) => payload,
      identifyTenantKey: () => null,
      isWebhookRequestAuthorized: () => true,
      classifyWebhookTrigger: () => null,
      createInteractionJob: async () => {
        throw new Error("unused");
      },
      createReviewRuntime: () => {
        throw new Error("unused");
      },
      buildHarnessTenantContext: () => {
        throw new Error("unused");
      },
      getReviewSummaryInstructions: () => [],
      getRegistrationSchema: () => z.object({}),
    };

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
      platforms: [platform],
    });

    const payload = { hello: "world" };
    const response = await app.inject({
      method: "POST",
      url: "/setup/setup-test/callback/finish",
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      method: "POST",
      pathSuffix: "callback/finish",
      rawBody: JSON.stringify(payload),
    });
  });
});
