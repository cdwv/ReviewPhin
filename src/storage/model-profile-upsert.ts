import type {
  ModelProfileRecord,
  ModelReasoningEffort,
  UpsertModelProfileInput,
} from "./contract/index.js";

export interface ResolvedModelProfileUpsertInput {
  readonly name: string;
  readonly providerBaseUrl: string | null;
  readonly providerType: "openai" | "azure" | "anthropic" | null;
  readonly wireApi: "completions" | "responses" | null;
  readonly authToken: string | null;
  readonly reviewModel: string | null;
  readonly textGenerationModel: string | null;
  readonly reviewReasoningEffort: ModelReasoningEffort | null;
  readonly textGenerationReasoningEffort: ModelReasoningEffort | null;
  readonly isDefault: boolean;
}

export function resolveModelProfileUpsertInput(
  existing: ModelProfileRecord | null,
  input: UpsertModelProfileInput,
): ResolvedModelProfileUpsertInput {
  const providerBaseUrl = resolveDefined(
    input.providerBaseUrl,
    existing?.providerBaseUrl ?? null,
  );
  let providerType = resolveDefined(
    input.providerType,
    existing?.providerType ?? null,
  );

  if (providerBaseUrl === null && input.providerType === undefined) {
    providerType = null;
  }

  const resolved = {
    name: input.name,
    providerBaseUrl,
    providerType,
    wireApi: resolveDefined(input.wireApi, existing?.wireApi ?? null),
    authToken: resolveDefined(input.authToken, existing?.authToken ?? null),
    reviewModel: resolveDefined(
      input.reviewModel,
      existing?.reviewModel ?? null,
    ),
    textGenerationModel: resolveDefined(
      input.textGenerationModel,
      existing?.textGenerationModel ?? null,
    ),
    reviewReasoningEffort: resolveDefined(
      input.reviewReasoningEffort,
      existing?.reviewReasoningEffort ?? null,
    ),
    textGenerationReasoningEffort: resolveDefined(
      input.textGenerationReasoningEffort,
      existing?.textGenerationReasoningEffort ?? null,
    ),
    isDefault: resolveDefined(input.isDefault, existing?.isDefault ?? false),
  };

  if (!resolved.providerBaseUrl && resolved.providerType) {
    throw new Error("provider type requires --base-url");
  }

  if (!resolved.providerBaseUrl && resolved.wireApi) {
    throw new Error("wire api requires --base-url");
  }

  if (resolved.providerBaseUrl && !resolved.reviewModel) {
    throw new Error("custom providers require --review-model");
  }

  return resolved;
}

function resolveDefined<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}
