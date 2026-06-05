import type { HarnessModelConfig } from "../harness/types.js";
import type { ProviderConfig } from "@github/copilot-sdk";
import type {
  ModelProfileRecord,
  StorageStores,
  TenantRecord,
} from "../storage/contract/index.js";

const REVIEWPHIN_PROFILE_OVERRIDE_PATTERN =
  /(?:^|\r?\n)\s*\/reviewphin-profile\s+([A-Za-z0-9][A-Za-z0-9._-]*)\b/i;

export class ModelProfileConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ModelProfileConfigurationError";
  }
}

export function extractCodeReviewModelProfileOverride(
  description: string,
): string | null {
  const match = description.match(REVIEWPHIN_PROFILE_OVERRIDE_PATTERN);
  return match?.[1] ?? null;
}

export async function resolveReviewProviderConfig(input: {
  storage: {
    stores: {
      modelProfiles: Pick<StorageStores["modelProfiles"], "get" | "find">;
    };
  };
  tenant: TenantRecord;
  codeReview: {
    description: string;
  };
}): Promise<HarnessModelConfig> {
  const overrideName = extractCodeReviewModelProfileOverride(
    input.codeReview.description,
  );
  if (overrideName) {
    const profile = await input.storage.stores.modelProfiles.get(overrideName);
    if (!profile) {
      throw new ModelProfileConfigurationError(
        `Code review requested unknown model profile "${overrideName}"`,
      );
    }

    return mapResolvedProfile(profile, "code-review-override");
  }

  if (input.tenant.modelProfileName) {
    const profile = await input.storage.stores.modelProfiles.get(
      input.tenant.modelProfileName,
    );
    if (!profile) {
      throw new ModelProfileConfigurationError(
        `Tenant ${input.tenant.key} references unknown model profile "${input.tenant.modelProfileName}"`,
      );
    }

    return mapResolvedProfile(profile, "tenant");
  }

  const defaultProfile = await input.storage.stores.modelProfiles.find({
    isDefault: { eq: true },
  });
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
    providerType: null,
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
  selectionSource: HarnessModelConfig["selectionSource"],
): HarnessModelConfig {
  validateModelProfile(profile);

  return {
    modelProfileName: profile.name,
    selectionSource,
    reviewModel: profile.reviewModel,
    textGenerationModel: profile.textGenerationModel ?? profile.reviewModel,
    authToken: profile.authToken,
    provider: buildProviderConfig(profile),
    providerBaseUrl: profile.providerBaseUrl,
    providerType: profile.providerType,
  };
}

function buildProviderConfig(
  profile: ModelProfileRecord,
): ProviderConfig | undefined {
  if (!profile.providerBaseUrl) {
    return undefined;
  }

  return {
    baseUrl: profile.providerBaseUrl,
    ...(profile.providerType ? { type: profile.providerType } : {}),
    wireApi: profile.wireApi ?? "responses",
    ...(profile.authToken ? { apiKey: profile.authToken } : {}),
  };
}

function validateModelProfile(profile: ModelProfileRecord): void {
  if (!profile.providerBaseUrl) {
    return;
  }

  if (!profile.reviewModel) {
    throw new ModelProfileConfigurationError(
      `Model profile "${profile.name}" configures a provider base URL but no review model`,
    );
  }
}
