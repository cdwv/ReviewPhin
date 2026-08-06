import { readFileSync } from "node:fs";

interface PackageMetadata {
  version?: unknown;
}

export const reviewPhinVersion = readReviewPhinVersion();

function readReviewPhinVersion(): string {
  try {
    const packageMetadata = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageMetadata;

    if (
      typeof packageMetadata.version === "string" &&
      packageMetadata.version.trim() !== ""
    ) {
      return packageMetadata.version.trim();
    }
  } catch {
    // Keep run logging operational even when package metadata is unavailable.
  }

  return "unknown";
}
