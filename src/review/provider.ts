import type { HarnessModelConfig, HarnessTenantContext } from "../harness/types.js";
import type { ReviewContext, ReviewResult } from "./types.js";

export type ReviewProviderConfig = HarnessModelConfig;

export interface ReviewProviderRuntimeContext {
  tenant: HarnessTenantContext;
}

export interface ReviewProvider {
  readonly name: string;
  review(context: ReviewContext, runtime: ReviewProviderRuntimeContext): Promise<ReviewResult>;
}

export interface ReviewProviderFactory {
  createProvider(config: ReviewProviderConfig): ReviewProvider;
}
