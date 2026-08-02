import { createFindingIdentityKey } from "../utils/ids.js";
import type { ReviewFinding, ReviewResult } from "./types.js";

export type ActiveReviewFinding = Pick<
  ReviewFinding,
  "title" | "body" | "severity" | "category"
>;

interface PriorReviewFinding extends ActiveReviewFinding {
  identityKey: string;
  status: string;
}

interface DiscussionFindingIdentity {
  discussionId: string;
  identityKey: string;
}

export function projectActiveReviewFindings(input: {
  priorFindings: ReadonlyArray<PriorReviewFinding>;
  discussionIdentities: ReadonlyArray<DiscussionFindingIdentity>;
  reviewResult: ReviewResult;
}): ActiveReviewFinding[] {
  const activeFindings = new Map<string, ActiveReviewFinding>();
  for (const finding of input.priorFindings) {
    if (finding.status === "open") {
      activeFindings.set(finding.identityKey, toActiveFinding(finding));
    }
  }

  const identityByDiscussionId = new Map(
    input.discussionIdentities.map(({ discussionId, identityKey }) => [
      discussionId,
      identityKey,
    ]),
  );
  const referencedDiscussionIds = new Set<string>();

  for (const finding of input.reviewResult.findings) {
    const nextIdentityKey = createFindingIdentityKey({
      title: finding.title,
      category: finding.category,
      path: finding.anchor?.path,
      startLine: finding.anchor?.startLine,
      endLine: finding.anchor?.endLine,
      side: finding.anchor?.side,
    });
    if (finding.priorDiscussionId) {
      const previousIdentityKey = identityByDiscussionId.get(
        finding.priorDiscussionId,
      );
      if (previousIdentityKey) {
        referencedDiscussionIds.add(finding.priorDiscussionId);
        if (previousIdentityKey !== nextIdentityKey) {
          activeFindings.delete(previousIdentityKey);
        }
      }
    }

    activeFindings.set(nextIdentityKey, toActiveFinding(finding));
  }

  for (const disposition of input.reviewResult.priorDispositions) {
    if (
      disposition.action !== "resolve" ||
      referencedDiscussionIds.has(disposition.discussionId)
    ) {
      continue;
    }

    const identityKey = identityByDiscussionId.get(disposition.discussionId);
    if (identityKey) {
      activeFindings.delete(identityKey);
    }
  }

  return [...activeFindings.values()];
}

function toActiveFinding(finding: ActiveReviewFinding): ActiveReviewFinding {
  return {
    title: finding.title,
    body: finding.body,
    severity: finding.severity,
    category: finding.category,
  };
}
