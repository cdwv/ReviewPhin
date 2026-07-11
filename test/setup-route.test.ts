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
      createTriggerLifecycle: () => {
        throw new Error("unused");
      },
      createReviewRuntime: () => {
        throw new Error("unused");
      },
      createProjectMemoryBackend: () => {
        throw new Error("unused");
      },
      buildHarnessTenantContext: () => {
        throw new Error("unused");
      },
      getReviewSummaryInstructions: () => [],
      getTenantRegistrationSchema: () => z.object({}),
      getConnectionRegistrationSchema: () => z.object({}),
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

    const scriptResponse = await app.inject({
      method: "GET",
      url: "/github/setup/assets/github-setup.js",
    });
    expect(scriptResponse.statusCode).toBe(200);

    const styleResponse = await app.inject({
      method: "GET",
      url: "/github/setup/assets/github-setup.css",
    });
    expect(styleResponse.statusCode).toBe(200);
  });

  it("hosts GitHub setup samples outside the setup flow", async () => {
    const setupHandler = vi.fn(async () => {
      throw new Error("sample previews must not enter setup flow");
    });
    const platform: IPlatform = {
      getPlatformInfo: () => ({
        name: "GitHub",
        description: "GitHub App integration",
        slug: "github",
      }),
      getSetupHandler: () => setupHandler,
      getTenantKey: () => "unused",
      parseWebhookPayload: (payload) => payload,
      identifyTenantKey: () => null,
      isWebhookRequestAuthorized: () => true,
      classifyWebhookTrigger: () => null,
      createInteractionJob: async () => {
        throw new Error("unused");
      },
      createTriggerLifecycle: () => {
        throw new Error("unused");
      },
      createReviewRuntime: () => {
        throw new Error("unused");
      },
      createProjectMemoryBackend: () => {
        throw new Error("unused");
      },
      buildHarnessTenantContext: () => {
        throw new Error("unused");
      },
      getReviewSummaryInstructions: () => [],
      getTenantRegistrationSchema: () => z.object({}),
      getConnectionRegistrationSchema: () => z.object({}),
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
      platforms: [platform],
      publicUrl: "https://review.example.com/reviewphin/",
      enableGitHubSetupSamples: true,
    });

    const indexResponse = await app.inject({
      method: "GET",
      url: "/github/setup/samples",
      headers: {
        host: "preview.example:4300",
        "x-forwarded-proto": "https",
      },
    });
    expect(indexResponse.statusCode).toBe(200);
    expect(indexResponse.body).toContain("GitHub setup samples");
    expect(indexResponse.body).toContain('href="samples/register"');
    expect(indexResponse.body).not.toContain(
      "https://preview.example:4300/github/setup/samples/register",
    );

    const registerResponse = await app.inject({
      method: "GET",
      url: "/github/setup/samples/register",
      headers: {
        host: "preview.example:4300",
        "x-forwarded-proto": "https",
      },
    });
    expect(registerResponse.statusCode).toBe(200);
    expect(registerResponse.headers["content-type"]).toContain("text/html");
    expect(registerResponse.body).toContain("Register GitHub App");
    expect(registerResponse.body).toContain(
      'href="https://review.example.com/reviewphin/github/setup/assets/github-setup.css"',
    );
    expect(parseSetupData(registerResponse.body)).toMatchObject({
      page: "register",
      sample: true,
      owner: "octo-org",
      publicUrl: "https://review.example.com/reviewphin",
    });
    expect(setupHandler).not.toHaveBeenCalled();

    const successResponse = await app.inject({
      method: "GET",
      url: "/github/setup/samples/success",
    });
    expect(successResponse.statusCode).toBe(200);
    expect(parseSetupData(successResponse.body)).toMatchObject({
      page: "success",
      sample: true,
      installationId: 789,
      accessibleRepositoryCount: 12,
    });

    const missingResponse = await app.inject({
      method: "GET",
      url: "/github/setup/samples/unknown",
    });
    expect(missingResponse.statusCode).toBe(404);
  });

  it("does not host GitHub setup samples unless enabled", async () => {
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
      platforms: [],
    });

    const indexResponse = await app.inject({
      method: "GET",
      url: "/github/setup/samples",
    });
    expect(indexResponse.statusCode).toBe(404);

    const registerResponse = await app.inject({
      method: "GET",
      url: "/github/setup/samples/register",
    });
    expect(registerResponse.statusCode).toBe(404);
  });
});

function parseSetupData(page: string): Record<string, unknown> {
  const match =
    /<script type="application\/json" id="reviewphin-setup-data">(?<json>.*?)<\/script>/s.exec(
      page,
    );
  expect(match?.groups?.json).toBeDefined();
  return JSON.parse(match!.groups!.json!) as Record<string, unknown>;
}
