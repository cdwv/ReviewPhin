import type { ProviderConfig } from "@github/copilot-sdk";

import type { GitLabMergeRequest } from "../gitlab/types.js";
import type { ModelProfileRecord, Storage, TenantRecord } from "../storage/types.js";
import type { ReviewProviderConfig } from "./provider.js";

const REVIEWPHIN_PROFILE_OVERRIDE_PATTERN = /(?:^|\r?\n)\s*\/reviewphin-profile\s+([A-Za-z0-9][A-Za-z0-9._-]*)\b/i;

export class ModelProfileConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ModelProfileConfigurationError";
  }
}

export function extractMergeRequestModelProfileOverride(description: string): string | null {
  const match = description.match(REVIEWPHIN_PROFILE_OVERRIDE_PATTERN);
  return match?.[1] ?? null;
}

export async function resolveReviewProviderConfig(input: {
  storage: Pick<Storage, "getModelProfileByName" | "getDefaultModelProfile">;
  tenant: TenantRecord;
  mergeRequest: Pick<GitLabMergeRequest, "description">;
}): Promise<ReviewProviderConfig> {
  const overrideName = extractMergeRequestModelProfileOverride(input.mergeRequest.description);
  if (overrideName) {
    const profile = await input.storage.getModelProfileByName(overrideName);
    if (!profile) {
      throw new ModelProfileConfigurationError(`Merge request requested unknown model profile "${overrideName}"`);
    }

    return mapResolvedProfile(profile, "merge-request-override");
  }

  if (input.tenant.modelProfileName) {
    const profile = await input.storage.getModelProfileByName(input.tenant.modelProfileName);
    if (!profile) {
      throw new ModelProfileConfigurationError(
        `Tenant ${input.tenant.key} references unknown model profile "${input.tenant.modelProfileName}"`
      );
    }

    return mapResolvedProfile(profile, "tenant");
  }

  const defaultProfile = await input.storage.getDefaultModelProfile();
  if (defaultProfile) {
    return mapResolvedProfile(defaultProfile, "default");
  }

  return {
    modelProfileName: null,
    selectionSource: "fallback",
    reviewModel: null,
    textGenerationModel: null,
    authToken: null,
    provider: undefined,
    providerBaseUrl: null,
    providerType: null
  };
}

export function maskSecret(value: string | null): string | null {
  if (!value) {
    return null;
  }

  if (value.length <= 4) {
    return "*".repeat(value.length);
  }

  return `${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

function mapResolvedProfile(
  profile: ModelProfileRecord,
  selectionSource: ReviewProviderConfig["selectionSource"]
): ReviewProviderConfig {
  validateModelProfile(profile);

  return {
    modelProfileName: profile.name,
    selectionSource,
    reviewModel: profile.reviewModel,
    textGenerationModel: profile.textGenerationModel ?? profile.reviewModel,
    authToken: profile.authToken,
    provider: buildProviderConfig(profile),
    providerBaseUrl: profile.providerBaseUrl,
    providerType: profile.providerType
  };
}

function buildProviderConfig(profile: ModelProfileRecord): ProviderConfig | undefined {
  if (!profile.providerBaseUrl) {
    return undefined;
  }

  return {
    baseUrl: profile.providerBaseUrl,
    ...(profile.providerType ? { type: profile.providerType } : {}),
    wireApi: profile.wireApi ?? "responses",
    ...(profile.authToken ? { apiKey: profile.authToken } : {})
  };
}

function validateModelProfile(profile: ModelProfileRecord): void {
  if (!profile.providerBaseUrl) {
    return;
  }

  if (!profile.reviewModel) {
    throw new ModelProfileConfigurationError(`Model profile "${profile.name}" configures a provider base URL but no review model`);
  }
}
