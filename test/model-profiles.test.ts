import { describe, expect, it, vi } from "vitest";

import {
  extractCodeReviewModelProfileOverride,
  resolveReviewProviderConfig,
} from "../src/review/model-profiles.js";
import type { ModelProfileRecord } from "../src/storage/contract/index.js";

const tenant = {
  id: "tenant_1",
  key: "https://gitlab.example.com::123",
  platform: "gitlab",
  platformConnectionId: "connection-1",
  platformConfigJson: JSON.stringify({
    baseUrl: "https://gitlab.example.com",
    projectId: 123,
    apiToken: "token",
    webhookSecret: "secret",
    botUserId: 999,
    botUsername: "review-bot",
  }),
  baseUrl: "https://gitlab.example.com",
  projectId: 123,
  apiToken: "token",
  webhookSecret: "secret",
  botUserId: 999,
  botUsername: "review-bot",
  modelProfileName: "tenant-profile",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function createProfile(
  name: string,
  overrides: Partial<ModelProfileRecord> = {},
): ModelProfileRecord {
  return {
    name,
    providerBaseUrl: null,
    providerType: null,
    wireApi: null,
    authToken: null,
    reviewModel: "gpt-5.4",
    textGenerationModel: null,
    reviewReasoningEffort: null,
    textGenerationReasoningEffort: null,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("model profile resolution", () => {
  it("extracts code review overrides from descriptions", () => {
    expect(
      extractCodeReviewModelProfileOverride(
        [
          "This MR updates the queue worker.",
          "",
          "/reviewphin-profile byok-prod",
        ].join("\n"),
      ),
    ).toBe("byok-prod");
  });

  it("prefers merge request overrides over tenant and default profiles", async () => {
    const modelProfiles = {
      get: vi.fn(async (name: string) =>
        createProfile(name, {
          providerBaseUrl:
            name === "byok-prod" ? "https://llm.example.com/v1" : null,
          providerType: name === "byok-prod" ? "openai" : null,
          wireApi: name === "byok-prod" ? "completions" : null,
          authToken: name === "byok-prod" ? "secret-token" : null,
          reviewModel: name === "byok-prod" ? "custom-review" : "gpt-5.4",
          textGenerationModel: name === "byok-prod" ? "custom-text" : null,
        }),
      ),
      find: vi.fn(async () =>
        createProfile("default-profile", {
          isDefault: true,
        }),
      ),
    };

    const resolved = await resolveReviewProviderConfig({
      storage: { stores: { modelProfiles } },
      tenant,
      codeReview: {
        description: "Queue changes\n/reviewphin-profile byok-prod",
      },
    });

    expect(resolved).toMatchObject({
      modelProfileName: "byok-prod",
      selectionSource: "code-review-override",
      authToken: "secret-token",
      reviewModel: "custom-review",
      textGenerationModel: "custom-text",
      providerBaseUrl: "https://llm.example.com/v1",
      providerType: "openai",
    });
    expect(resolved.provider).toEqual({
      baseUrl: "https://llm.example.com/v1",
      type: "openai",
      wireApi: "completions",
      apiKey: "secret-token",
    });
    expect(modelProfiles.find).not.toHaveBeenCalled();
  });

  it("defaults custom provider profiles to responses when wireApi is omitted", async () => {
    const resolved = await resolveReviewProviderConfig({
      storage: {
        stores: {
          modelProfiles: {
            get: vi.fn(async () =>
              createProfile("byok-default-wire-api", {
                providerBaseUrl: "https://llm.example.com/v1",
                providerType: "openai",
                reviewModel: "custom-review",
              }),
            ),
            find: vi.fn(async () => null),
          },
        },
      },
      tenant,
      codeReview: {
        description: "No override here",
      },
    });

    expect(resolved.provider).toEqual({
      baseUrl: "https://llm.example.com/v1",
      type: "openai",
      wireApi: "responses",
    });
  });

  it("falls back to default profiles, keeps native auth tokens, and errors on unknown overrides", async () => {
    const storage = {
      stores: {
        modelProfiles: {
          get: vi.fn(async (name: string) => {
            if (name === "tenant-profile") {
              return null;
            }

            return null;
          }),
          find: vi.fn(async () => ({
            ...createProfile("default-profile", {
              isDefault: true,
              textGenerationModel: "gpt-5.4-mini",
            }),
          })),
        },
      },
    };

    await expect(
      resolveReviewProviderConfig({
        storage,
        tenant: {
          ...tenant,
          modelProfileName: null,
        },
        codeReview: {
          description: "/reviewphin-profile missing-profile",
        },
      }),
    ).rejects.toThrow('unknown model profile "missing-profile"');

    const resolved = await resolveReviewProviderConfig({
      storage,
      tenant: {
        ...tenant,
        modelProfileName: null,
      },
      codeReview: {
        description: "No override here",
      },
    });

    expect(resolved).toMatchObject({
      modelProfileName: "default-profile",
      selectionSource: "default",
      authToken: null,
      reviewModel: "gpt-5.4",
      textGenerationModel: "gpt-5.4-mini",
      providerBaseUrl: null,
      providerType: null,
    });

    const nativeResolved = await resolveReviewProviderConfig({
      storage: {
        stores: {
          modelProfiles: {
            get: vi.fn(async () =>
              createProfile("native-token", {
                authToken: "github-token",
              }),
            ),
            find: vi.fn(async () => null),
          },
        },
      },
      tenant,
      codeReview: {
        description: "No override here",
      },
    });

    expect(nativeResolved).toMatchObject({
      modelProfileName: "native-token",
      selectionSource: "tenant",
      authToken: "github-token",
      provider: undefined,
      providerBaseUrl: null,
    });
  });

  it("preserves both reasoning-effort values independently without cross-role fallback", async () => {
    const resolved = await resolveReviewProviderConfig({
      storage: {
        stores: {
          modelProfiles: {
            get: vi.fn(async () =>
              createProfile("effort-profile", {
                reviewModel: "gpt-5.6",
                textGenerationModel: null,
                reviewReasoningEffort: "high",
                textGenerationReasoningEffort: null,
              }),
            ),
            find: vi.fn(async () => null),
          },
        },
      },
      tenant,
      codeReview: {
        description: "No override here",
      },
    });

    expect(resolved.reviewReasoningEffort).toBe("high");
    expect(resolved.textGenerationReasoningEffort).toBeNull();
    // text generation falls back to the review model but never to the review effort
    expect(resolved.textGenerationModel).toBe("gpt-5.6");
  });

  it("keeps distinct reasoning-effort values for each role", async () => {
    const resolved = await resolveReviewProviderConfig({
      storage: {
        stores: {
          modelProfiles: {
            get: vi.fn(async () =>
              createProfile("dual-effort", {
                reviewReasoningEffort: "xhigh",
                textGenerationReasoningEffort: "low",
              }),
            ),
            find: vi.fn(async () => null),
          },
        },
      },
      tenant,
      codeReview: {
        description: "No override here",
      },
    });

    expect(resolved.reviewReasoningEffort).toBe("xhigh");
    expect(resolved.textGenerationReasoningEffort).toBe("low");
  });

  it("sets both reasoning-effort values to null for the fallback configuration", async () => {
    const resolved = await resolveReviewProviderConfig({
      storage: {
        stores: {
          modelProfiles: {
            get: vi.fn(async () => null),
            find: vi.fn(async () => null),
          },
        },
      },
      tenant: {
        ...tenant,
        modelProfileName: null,
      },
      codeReview: {
        description: "No override here",
      },
    });

    expect(resolved.selectionSource).toBe("fallback");
    expect(resolved.reviewReasoningEffort).toBeNull();
    expect(resolved.textGenerationReasoningEffort).toBeNull();
  });
});
