import type { ProviderConfig } from "@github/copilot-sdk";

import type { ReviewContext, ReviewResult } from "./types.js";

export interface ReviewProviderConfig {
  modelProfileName: string | null;
  selectionSource: "merge-request-override" | "tenant" | "default" | "fallback";
  reviewModel: string | null;
  textGenerationModel: string | null;
  authToken: string | null;
  provider: ProviderConfig | undefined;
  providerBaseUrl: string | null;
  providerType: "openai" | "azure" | "anthropic" | null;
}

export interface ReviewProvider {
  readonly name: string;
  review(context: ReviewContext): Promise<ReviewResult>;
}

export interface ReviewProviderFactory {
  createProvider(config: ReviewProviderConfig): ReviewProvider;
}
