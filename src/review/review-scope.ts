import type {
  CodeReviewChange,
  CodeReviewDiscussion,
  CodeReviewItem,
  CodeReviewComment,
  ReviewAttachment,
  ReviewAttachmentIssue,
} from "./types.js";
import type { ProjectMemoryContext } from "../memory/types.js";
import { reviewResultSchema } from "./types.js";
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

interface BuildScopedReviewContextInput {
  attachments?: ReviewAttachment[] | undefined;
  attachmentIssues?: ReviewAttachmentIssue[] | undefined;
  workspacePath: string;
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

const CHANGE_LIMIT_BY_MODE: Record<ReviewMode, number> = {
  "first-pass-full": 12,
  "incremental-rereview": 8,
  "follow-up-discussion": 4,
};

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
  const mode = determineReviewMode(
    input.trigger,
    input.previousReview,
    explicitFullRescan,
  );
  const priorFindings = input.priorFindings ?? [];
  const targetDiscussionId =
    input.trigger.kind === "manual-review"
      ? null
      : input.trigger.targetDiscussionId;
  const targetDiscussion =
    targetDiscussionId !== null
      ? (input.priorDiscussions.find(
          (discussion) =>
            discussion.discussionId === targetDiscussionId,
        ) ?? null)
      : null;

  const allChangedFiles = input.changes.map((change) =>
    toChangeSummary(change),
  );
  const deltaChanges = input.previousReview
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

  const selectedChanges = selectChanges({
    changes: input.changes,
    focusPaths,
    mode,
    deltaChanges,
    widenScopeHints,
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
  });

  return {
    attachments: input.attachments ?? [],
    attachmentIssues: input.attachmentIssues ?? [],
    workspacePath: input.workspacePath,
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

function selectChanges(input: {
  changes: CodeReviewChange[];
  focusPaths: Set<string>;
  mode: ReviewMode;
  deltaChanges: CodeReviewChange[];
  widenScopeHints: string[];
}): CodeReviewChange[] {
  const focusedChanges = input.changes.filter((change) => {
    const path = getChangePath(change);
    return input.focusPaths.has(path) || input.focusPaths.has(change.oldPath);
  });

  const candidatePool = getChangesCandidatePool(input, focusedChanges);

  if (candidatePool.length <= CHANGE_LIMIT_BY_MODE[input.mode]) {
    return candidatePool.slice();
  }

  const prioritized = candidatePool
    .map((change, index) => ({
      change,
      index,
      score: scoreChange(change, input.focusPaths, input.widenScopeHints),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, CHANGE_LIMIT_BY_MODE[input.mode])
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.change);

  if (prioritized.length > 0) {
    return prioritized;
  }

  return candidatePool.slice(0, CHANGE_LIMIT_BY_MODE[input.mode]);
}

function getChangesCandidatePool(
  input: {
    changes: CodeReviewChange[];
    focusPaths: Set<string>;
    mode: ReviewMode;
    deltaChanges: CodeReviewChange[];
    widenScopeHints: string[];
  },
  focusedChanges: CodeReviewChange[],
) {
  if (input.mode === "follow-up-discussion") {
    return focusedChanges;
  }

  if (input.mode === "incremental-rereview" && input.deltaChanges.length > 0) {
    return mergeChangesPreservingOrder(
      input.changes,
      focusedChanges,
      input.deltaChanges,
    );
  }

  return input.changes;
}

function mergeChangesPreservingOrder(
  orderedChanges: CodeReviewChange[],
  ...changeGroups: CodeReviewChange[][]
): CodeReviewChange[] {
  const included = new Set(
    changeGroups.flat().map((change) => getChangeSignature(change)),
  );
  return orderedChanges.filter((change) =>
    included.has(getChangeSignature(change)),
  );
}

function scoreChange(
  change: CodeReviewChange,
  focusPaths: Set<string>,
  widenScopeHints: string[],
): number {
  const path = getChangePath(change);
  let score = 0;

  if (focusPaths.has(path) || focusPaths.has(change.oldPath)) {
    score += 1_000;
  }

  if (change.newFile || change.renamedFile || change.deletedFile) {
    score += 100;
  }

  if (/^(src|test)\//.test(path)) {
    score += path.startsWith("src/") ? 60 : 20;
  }

  if (
    /^(src\/(platforms|jobs|reconcile|review|storage)\/|package\.json$|pnpm-lock\.yaml$|tsconfig(\..+)?\.json$|Dockerfile$|docker-compose\.yml$)/.test(
      path,
    )
  ) {
    score += 120;
  }

  if (
    widenScopeHints.length > 0 &&
    /(^src\/|package\.json$|pnpm-lock\.yaml$|tsconfig(\..+)?\.json$)/.test(path)
  ) {
    score += 40;
  }

  score += Math.min((change.diff?.length ?? 0) / 80, 80);
  return score;
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
        `${input.omittedChangedFiles.length} additional changed file(s) are summarized without inline diffs.`,
      );
    } else {
      parts.push("All current changed files are included in detail.");
    }

    return parts.join(" ");
  }

  return [
    ...(input.trigger.kind === "manual-review" && input.trigger.instruction
      ? [`Apply this manual review instruction: ${input.trigger.instruction}`]
      : []),
    input.previousReview
      ? "A fresh full rescan was explicitly requested even though a previous review exists."
      : "This is the first full review request for this code review.",
    input.omittedChangedFiles.length > 0
      ? `${input.omittedChangedFiles.length} changed file(s) are summarized without inline diffs to keep the starting context bounded.`
      : "All changed files are included in detail.",
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
  return {
    path: getChangePath(change),
    oldPath: change.oldPath,
    newFile: change.newFile,
    renamedFile: change.renamedFile,
    deletedFile: change.deletedFile,
    ...(reason ? { reason } : {}),
  };
}

function getChangePath(change: CodeReviewChange): string {
  return change.newPath || change.oldPath;
}

function getChangeSignature(change: CodeReviewChange): string {
  return JSON.stringify({
    oldPath: change.oldPath,
    newPath: change.newPath,
    diff: change.diff ?? "",
    newFile: change.newFile,
    renamedFile: change.renamedFile,
    deletedFile: change.deletedFile,
  });
}
