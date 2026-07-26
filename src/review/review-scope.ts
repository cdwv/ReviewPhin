import type {
  CodeReviewChange,
  CodeReviewDiscussion,
  CodeReviewItem,
  CodeReviewComment,
  ReviewAttachment,
  ReviewAttachmentIssue,
} from "./types.js";
import type { ProjectMemoryContext } from "../memory/types.js";
import type { GitReadonlyCapability } from "../harness/git-readonly.js";
import { GIT_CONTENT_SIGNATURE_PREFIX, reviewResultSchema } from "./types.js";
import type {
  PriorReviewFindingContext,
  PreviousReviewContext,
  ProviderDiscussionContext,
  ReviewChangeSummary,
  ReviewContext,
  ReviewMode,
  ReviewResult,
  ReviewTriggerContext,
  ReviewScopeContext,
} from "./types.js";

interface PreviousReviewSource {
  reviewRunId: string;
  finishedAt: string;
  headSha: string;
  resultJson: string;
  changesJson: string;
}

type FullRescanReason = "explicit" | "signature-transition" | null;

interface BuildScopedReviewContextInput {
  attachments?: ReviewAttachment[] | undefined;
  attachmentIssues?: ReviewAttachmentIssue[] | undefined;
  workspacePath: string;
  gitInspection?: GitReadonlyCapability | undefined;
  codeReview: CodeReviewItem;
  changes: CodeReviewChange[];
  comments: CodeReviewComment[];
  discussions: CodeReviewDiscussion[];
  projectMemory?: ProjectMemoryContext | undefined;
  trigger: ReviewTriggerContext;
  priorDiscussions: ProviderDiscussionContext[];
  priorFindings?: PriorReviewFindingContext[] | undefined;
  previousReview: PreviousReviewSource | null;
  logging?: ReviewContext["logging"];
}

const COMMENT_LIMIT_BY_MODE: Record<ReviewMode, number> = {
  "first-pass-full": 12,
  "incremental-rereview": 8,
  "follow-up-discussion": 0,
};

const THREAD_LIMIT_BY_MODE: Record<ReviewMode, number> = {
  "first-pass-full": 12,
  "incremental-rereview": 10,
  "follow-up-discussion": 1,
};

export function buildScopedReviewContext(
  input: BuildScopedReviewContextInput,
): ReviewContext {
  const previousReviewResult = parsePreviousReviewResult(
    input.previousReview?.resultJson ?? null,
  );
  const previousReviewChanges = parsePreviousReviewChanges(
    input.previousReview?.changesJson ?? null,
  );
  const explicitFullRescan = hasExplicitFullRescanInstruction(
    input.trigger.instruction,
  );
  const signatureTransition =
    input.previousReview !== null &&
    hasIncompatibleChangeSignatureFormats(input.changes, previousReviewChanges);
  const fullRescanReason: FullRescanReason = explicitFullRescan
    ? "explicit"
    : signatureTransition
      ? "signature-transition"
      : null;
  const mode = determineReviewMode(
    input.trigger,
    input.previousReview,
    fullRescanReason !== null,
  );
  const priorFindings = input.priorFindings ?? [];
  const targetDiscussionId =
    input.trigger.kind === "manual-review"
      ? null
      : input.trigger.targetDiscussionId;
  const targetDiscussion =
    targetDiscussionId !== null
      ? (input.priorDiscussions.find(
          (discussion) => discussion.discussionId === targetDiscussionId,
        ) ?? null)
      : null;

  const deltaChanges =
    input.previousReview && mode === "incremental-rereview"
      ? findDeltaChanges(input.changes, previousReviewChanges)
      : [];
  const deltaPaths = new Set(
    deltaChanges.map((change) => getChangePath(change)),
  );
  const targetDiscussionPaths = new Set<string>();
  if (targetDiscussion?.anchor?.path) {
    targetDiscussionPaths.add(targetDiscussion.anchor.path);
  }
  if (targetDiscussion?.anchor?.oldPath) {
    targetDiscussionPaths.add(targetDiscussion.anchor.oldPath);
  }

  const widenedInputChanges =
    mode === "incremental-rereview" && deltaChanges.length > 0
      ? deltaChanges
      : input.changes;
  const widenScopeHints = collectWidenScopeHints(widenedInputChanges);

  const focusPaths = new Set<string>();
  for (const path of targetDiscussionPaths) {
    focusPaths.add(path);
  }

  if (mode === "incremental-rereview") {
    for (const path of deltaPaths) {
      focusPaths.add(path);
    }
    for (const discussion of input.priorDiscussions) {
      if (!discussion.resolved && discussion.anchor?.path) {
        focusPaths.add(discussion.anchor.path);
      }
      if (!discussion.resolved && discussion.anchor?.oldPath) {
        focusPaths.add(discussion.anchor.oldPath);
      }
    }
    for (const finding of priorFindings) {
      if (finding.status !== "open") {
        continue;
      }
      if (finding.anchor?.path) {
        focusPaths.add(finding.anchor.path);
      }
      if (finding.anchor?.oldPath) {
        focusPaths.add(finding.anchor.oldPath);
      }
    }
  }

  const allChangedFiles = input.changes.map((change) => {
    const path = getChangePath(change);
    const oldPath = change.oldPath;
    const reason =
      targetDiscussionPaths.has(path) || targetDiscussionPaths.has(oldPath)
        ? "target discussion"
        : deltaPaths.has(path)
          ? "changed since the previous review"
          : focusPaths.has(path) || focusPaths.has(oldPath)
            ? "open finding or unresolved discussion"
            : undefined;
    return toChangeSummary(change, reason);
  });

  const selectedChanges = selectChanges({
    changes: input.changes,
    focusPaths,
    mode,
  });
  const selectedPathSet = new Set(
    selectedChanges.map((change) => getChangePath(change)),
  );

  const selectedPriorDiscussions = selectPriorDiscussions({
    priorDiscussions: input.priorDiscussions,
    focusPaths: selectedPathSet,
    mode,
    targetDiscussion,
  });
  const selectedPriorDiscussionIds = new Set(
    selectedPriorDiscussions.map(
      (discussion) => discussion.platformDiscussionId,
    ),
  );
  const selectedComments = selectComments(input.comments, mode);
  const selectedDiscussions =
    mode === "follow-up-discussion"
      ? input.discussions.filter(
          (discussion) =>
            targetDiscussion !== null &&
            discussion.id === targetDiscussion.platformDiscussionId,
        )
      : input.discussions.filter((discussion) =>
          selectedPriorDiscussionIds.has(discussion.id),
        );

  const omittedChangedFiles = input.changes
    .filter((change) => !selectedChanges.includes(change))
    .map((change) => toChangeSummary(change));

  const scope = buildScope({
    mode,
    trigger: input.trigger,
    targetDiscussion,
    previousReview: input.previousReview,
    previousReviewResult,
    priorFindings,
    selectedChanges,
    allChangedFiles,
    omittedChangedFiles,
    deltaChanges,
    widenScopeHints,
    fullRescanReason,
  });

  return {
    attachments: input.attachments ?? [],
    attachmentIssues: input.attachmentIssues ?? [],
    workspacePath: input.workspacePath,
    ...(input.gitInspection ? { gitInspection: input.gitInspection } : {}),
    codeReview: input.codeReview,
    changes: selectedChanges,
    comments: selectedComments,
    discussions: selectedDiscussions,
    projectMemory: input.projectMemory ?? {
      enabled: false,
      page: null,
      entries: [],
    },
    trigger: input.trigger,
    priorDiscussions: selectedPriorDiscussions,
    scope,
    ...(input.logging ? { logging: input.logging } : {}),
  };
}

function determineReviewMode(
  trigger: ReviewTriggerContext,
  previousReview: PreviousReviewSource | null,
  explicitFullRescan: boolean,
): ReviewMode {
  if (trigger.kind === "follow-up-comment") {
    return "follow-up-discussion";
  }

  if (!previousReview || explicitFullRescan) {
    return "first-pass-full";
  }

  return "incremental-rereview";
}

function hasExplicitFullRescanInstruction(instruction: string | null): boolean {
  if (!instruction) {
    return false;
  }

  return /\b(full\s+rescan|full\s+review|fresh\s+full\s+review|full\s+review\s+from\s+scratch|rescan\s+everything)\b/i.test(
    instruction,
  );
}

function parsePreviousReviewResult(
  resultJson: string | null,
): ReviewResult | null {
  if (!resultJson) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(resultJson);
    const validated = reviewResultSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

function parsePreviousReviewChanges(
  changesJson: string | null,
): CodeReviewChange[] {
  if (!changesJson) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(changesJson);
    return Array.isArray(parsed) ? (parsed as CodeReviewChange[]) : [];
  } catch {
    return [];
  }
}

function findDeltaChanges(
  currentChanges: CodeReviewChange[],
  previousChanges: CodeReviewChange[],
): CodeReviewChange[] {
  const previousSignatureByPath = new Map(
    previousChanges.map((change) => [
      getChangePath(change),
      getChangeSignature(change),
    ]),
  );
  return currentChanges.filter(
    (change) =>
      previousSignatureByPath.get(getChangePath(change)) !==
      getChangeSignature(change),
  );
}

function hasIncompatibleChangeSignatureFormats(
  currentChanges: CodeReviewChange[],
  previousChanges: CodeReviewChange[],
): boolean {
  const currentFormats = getChangeSignatureFormats(currentChanges);
  const previousFormats = getChangeSignatureFormats(previousChanges);
  if (currentFormats.size === 0 || previousFormats.size === 0) {
    return false;
  }
  return (
    currentFormats.size !== previousFormats.size ||
    [...currentFormats].some((format) => !previousFormats.has(format))
  );
}

function getChangeSignatureFormats(
  changes: CodeReviewChange[],
): Set<"git-raw-v2" | "content-signature-v1" | "provider-diff"> {
  return new Set(
    changes.map((change) => {
      if (change.contentSignature === undefined) {
        return "provider-diff";
      }
      return change.contentSignature.startsWith(GIT_CONTENT_SIGNATURE_PREFIX)
        ? "git-raw-v2"
        : "content-signature-v1";
    }),
  );
}

function selectChanges(input: {
  changes: CodeReviewChange[];
  focusPaths: Set<string>;
  mode: ReviewMode;
}): CodeReviewChange[] {
  const focusedChanges = input.changes.filter((change) => {
    const path = getChangePath(change);
    return input.focusPaths.has(path) || input.focusPaths.has(change.oldPath);
  });
  return input.mode === "follow-up-discussion"
    ? focusedChanges
    : input.changes.slice();
}

function collectWidenScopeHints(changes: CodeReviewChange[]): string[] {
  const hints = new Set<string>();

  for (const change of changes) {
    const path = getChangePath(change);
    if (
      /^(package\.json|pnpm-lock\.yaml|Dockerfile|docker-compose\.yml|tsconfig(\..+)?\.json)$/.test(
        path,
      )
    ) {
      hints.add("shared build or runtime configuration changed");
    }
    if (
      /^src\/.+\/types\.ts$/.test(path) ||
      /(^|\/)(api|client|schema|types)\.ts$/.test(path)
    ) {
      hints.add("public interfaces or shared contracts changed");
    }
    if (path.startsWith("src/storage/") || /migration/i.test(path)) {
      hints.add("storage or migration behavior changed");
    }
    if (/^src\/(platforms|review|reconcile|jobs)\//.test(path)) {
      hints.add("core review workflow code changed");
    }
  }

  return [...hints];
}

function selectPriorDiscussions(input: {
  priorDiscussions: ProviderDiscussionContext[];
  focusPaths: Set<string>;
  mode: ReviewMode;
  targetDiscussion: ProviderDiscussionContext | null;
}): ProviderDiscussionContext[] {
  if (input.mode === "follow-up-discussion") {
    return input.targetDiscussion ? [input.targetDiscussion] : [];
  }

  const candidateDiscussions =
    input.mode === "incremental-rereview"
      ? input.priorDiscussions.filter((discussion) => !discussion.resolved)
      : input.priorDiscussions;

  if (candidateDiscussions.length <= THREAD_LIMIT_BY_MODE[input.mode]) {
    return candidateDiscussions.slice();
  }

  return candidateDiscussions
    .map((discussion, index) => ({
      discussion,
      index,
      score:
        (discussion.resolved ? 0 : 500) +
        (discussion.anchor?.path && input.focusPaths.has(discussion.anchor.path)
          ? 300
          : 0) +
        (discussion.anchor?.oldPath &&
        input.focusPaths.has(discussion.anchor.oldPath)
          ? 300
          : 0) +
        Math.min(discussion.humanReplies.length * 30, 120),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, THREAD_LIMIT_BY_MODE[input.mode])
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.discussion);
}

function selectComments(
  comments: CodeReviewComment[],
  mode: ReviewMode,
): CodeReviewComment[] {
  const limit = COMMENT_LIMIT_BY_MODE[mode];
  return limit > 0 ? comments.slice(-limit) : [];
}

function buildScope(input: {
  mode: ReviewMode;
  trigger: ReviewTriggerContext;
  targetDiscussion: ProviderDiscussionContext | null;
  previousReview: PreviousReviewSource | null;
  previousReviewResult: ReviewResult | null;
  priorFindings: PriorReviewFindingContext[];
  selectedChanges: CodeReviewChange[];
  allChangedFiles: ReviewChangeSummary[];
  omittedChangedFiles: ReviewChangeSummary[];
  deltaChanges: CodeReviewChange[];
  widenScopeHints: string[];
  fullRescanReason: FullRescanReason;
}): ReviewScopeContext {
  const previousReview = buildPreviousReviewContext(
    input.previousReview,
    input.previousReviewResult,
  );
  const deltaSincePreviousReview =
    input.mode === "incremental-rereview" && input.previousReview
      ? {
          previousReviewRunId: input.previousReview.reviewRunId,
          previousHeadSha: input.previousReview.headSha,
          changedFiles: input.deltaChanges.map((change) =>
            toChangeSummary(change),
          ),
        }
      : null;

  const selectedChangeCount = input.selectedChanges.length;
  const scopeSummary = buildScopeSummary(input, selectedChangeCount);

  return {
    mode: input.mode,
    scopeSummary,
    widenScopeHints: input.widenScopeHints,
    allChangedFiles: input.allChangedFiles,
    omittedChangedFiles: input.omittedChangedFiles,
    targetDiscussion: input.targetDiscussion,
    previousReview,
    priorFindings: input.priorFindings,
    deltaSincePreviousReview,
  };
}

function buildScopeSummary(
  input: {
    mode: ReviewMode;
    trigger: ReviewTriggerContext;
    targetDiscussion: ProviderDiscussionContext | null;
    previousReview: PreviousReviewSource | null;
    previousReviewResult: ReviewResult | null;
    priorFindings: PriorReviewFindingContext[];
    selectedChanges: CodeReviewChange[];
    allChangedFiles: ReviewChangeSummary[];
    omittedChangedFiles: ReviewChangeSummary[];
    deltaChanges: CodeReviewChange[];
    widenScopeHints: string[];
    fullRescanReason: FullRescanReason;
  },
  selectedChangeCount: number,
) {
  if (input.mode === "follow-up-discussion") {
    const discussionTitle = input.targetDiscussion
      ? ` "${input.targetDiscussion.title}"`
      : "";
    return `Focus on the target bot-owned discussion${discussionTitle} and the ${selectedChangeCount} directly related changed file(s).`;
  }

  if (input.mode === "incremental-rereview") {
    const parts = [];

    if (input.trigger.kind === "manual-review") {
      parts.push(
        input.trigger.instruction
          ? `A manual action requested another review pass with this instruction: ${input.trigger.instruction}`
          : "A provider-owned manual action requested another review pass.",
      );
    } else if (input.trigger.kind === "summary-follow-up") {
      parts.push(
        "A reply on the bot-owned summary comment requested another review pass.",
      );
    } else if (input.trigger.instruction) {
      parts.push("Repeated direct mention requested a new review pass.");
    } else {
      parts.push("Repeated direct mention requested another review pass.");
    }

    if (input.previousReview) {
      parts.push(
        `Start from review run ${input.previousReview.reviewRunId} at head ${input.previousReview.headSha}.`,
      );
    } else {
      parts.push(
        "No previous review head was available; widen scope as needed.",
      );
    }

    parts.push(
      `Prioritize the ${input.deltaChanges.length} file(s) changed since the previous review before widening beyond the delta.`,
    );

    if (input.omittedChangedFiles.length > 0) {
      parts.push(
        `${input.omittedChangedFiles.length} additional changed file(s) remain visible in the complete manifest.`,
      );
    } else {
      parts.push(
        "The complete current change boundary is included; inspect detailed evidence on demand.",
      );
    }

    return parts.join(" ");
  }

  return [
    ...(input.trigger.kind === "manual-review" && input.trigger.instruction
      ? [`Apply this manual review instruction: ${input.trigger.instruction}`]
      : []),
    input.previousReview
      ? input.fullRescanReason === "signature-transition"
        ? "The stored review snapshot uses a different change-signature format, so this review establishes a fresh full-rescan baseline."
        : "A fresh full rescan was explicitly requested even though a previous review exists."
      : "This is the first full review request for this code review.",
    input.omittedChangedFiles.length > 0
      ? `${input.omittedChangedFiles.length} changed file(s) remain visible in the complete manifest.`
      : "The complete change boundary is included; inspect detailed evidence on demand.",
  ].join(" ");
}

function buildPreviousReviewContext(
  previousReview: PreviousReviewSource | null,
  result: ReviewResult | null,
): PreviousReviewContext | null {
  if (!previousReview) {
    return null;
  }

  return {
    reviewRunId: previousReview.reviewRunId,
    reviewedAt: previousReview.finishedAt,
    headSha: previousReview.headSha,
    overviewSummary:
      result?.overview.overallAssessment ?? result?.overview.summary ?? null,
    mergeReadiness: result?.overview.mergeReadiness ?? null,
  };
}

function toChangeSummary(
  change: CodeReviewChange,
  reason?: string,
): ReviewChangeSummary {
  const diffStats = summarizeDiff(change.diff);
  return {
    path: getChangePath(change),
    oldPath: change.oldPath === change.newPath ? null : change.oldPath,
    newFile: change.newFile,
    renamedFile: change.renamedFile,
    deletedFile: change.deletedFile,
    additions: change.additions ?? diffStats.additions,
    deletions: change.deletions ?? diffStats.deletions,
    changedLineRanges: diffStats.changedLineRanges,
    diffAvailable: change.diff !== undefined,
    ...(reason ? { reason } : {}),
  };
}

function summarizeDiff(diff: string | undefined): {
  additions: number | null;
  deletions: number | null;
  changedLineRanges: ReviewChangeSummary["changedLineRanges"];
} {
  if (diff === undefined) {
    return {
      additions: null,
      deletions: null,
      changedLineRanges: [],
    };
  }

  let additions = 0;
  let deletions = 0;
  const changedLineRanges: ReviewChangeSummary["changedLineRanges"] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }

    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) {
      continue;
    }
    const oldStart = Number(hunk[1]);
    const oldCount = Number(hunk[2] ?? 1);
    const newStart = Number(hunk[3]);
    const newCount = Number(hunk[4] ?? 1);
    changedLineRanges.push({
      oldStart: oldCount === 0 ? null : oldStart,
      oldEnd: oldCount === 0 ? null : oldStart + oldCount - 1,
      newStart: newCount === 0 ? null : newStart,
      newEnd: newCount === 0 ? null : newStart + newCount - 1,
    });
  }
  return { additions, deletions, changedLineRanges };
}

function getChangePath(change: CodeReviewChange): string {
  return change.newPath || change.oldPath;
}

function getChangeSignature(change: CodeReviewChange): string {
  return JSON.stringify({
    oldPath: change.oldPath,
    newPath: change.newPath,
    content: change.contentSignature ?? change.diff ?? "",
    newFile: change.newFile,
    renamedFile: change.renamedFile,
    deletedFile: change.deletedFile,
  });
}
