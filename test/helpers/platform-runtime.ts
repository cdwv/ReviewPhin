import type { PlatformReviewRuntime } from "../../src/platforms/IPlatform.js";

export function overridePlatformRuntime(
  runtime: PlatformReviewRuntime,
  overrides: Partial<PlatformReviewRuntime>,
): PlatformReviewRuntime {
  return Object.assign(
    Object.create(Object.getPrototypeOf(runtime)) as PlatformReviewRuntime,
    runtime,
    overrides,
  );
}
