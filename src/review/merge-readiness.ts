import type { ReviewFinding, ReviewMergeReadiness } from "./types.js";

export function deriveMergeReadinessStatus(
  findings: ReadonlyArray<Pick<ReviewFinding, "severity">>,
): ReviewMergeReadiness["status"] {
  if (findings.length === 0) {
    return "ready";
  }
  if (findings.some((finding) => finding.severity === "critical")) {
    return "blocked";
  }
  return "needs_attention";
}
