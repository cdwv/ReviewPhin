import type {
  GitLabDiscussion,
  GitLabMergeRequest,
  GitLabMergeRequestChange,
  GitLabNote,
  InstructionFile,
} from "../gitlab/types.js";
import type { ProjectMemoryContext } from "../memory/types.js";
import { reviewResultSchema } from "./types.js";
import type {
  PriorReviewFindingContext,
  PreviousReviewContext,
  ProviderThreadContext,
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
  workspacePath: string;
  mergeRequest: GitLabMergeRequest;
  changes: GitLabMergeRequestChange[];
  notes: GitLabNote[];
  discussions: GitLabDiscussion[];
  instructionFiles: InstructionFile[];
  projectMemory?: ProjectMemoryContext | undefined;
  trigger: ReviewTriggerContext;
  priorThreads: ProviderThreadContext[];
  priorFindings?: PriorReviewFindingContext[] | undefined;
  previousReview: PreviousReviewSource | null;
  logging?: ReviewContext["logging"];
}

const CHANGE_LIMIT_BY_MODE: Record<ReviewMode, number> = {
  "first-pass-full": 12,
  "incremental-rereview": 8,
  "follow-up-thread": 4,
};

const NOTE_LIMIT_BY_MODE: Record<ReviewMode, number> = {
  "first-pass-full": 12,
  "incremental-rereview": 8,
  "follow-up-thread": 0,
};

const THREAD_LIMIT_BY_MODE: Record<ReviewMode, number> = {
  "first-pass-full": 12,
  "incremental-rereview": 10,
  "follow-up-thread": 1,
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
  const targetThread =
    input.trigger.targetThreadId !== null
      ? (input.priorThreads.find(
          (thread) => thread.threadId === input.trigger.targetThreadId,
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
  const targetThreadPaths = new Set<string>();
  if (targetThread?.anchor?.path) {
    targetThreadPaths.add(targetThread.anchor.path);
  }
  if (targetThread?.anchor?.oldPath) {
    targetThreadPaths.add(targetThread.anchor.oldPath);
  }

  const widenedInputChanges =
    mode === "incremental-rereview" && deltaChanges.length > 0
      ? deltaChanges
      : input.changes;
  const widenScopeHints = collectWidenScopeHints(widenedInputChanges);

  const focusPaths = new Set<string>();
  for (const path of targetThreadPaths) {
    focusPaths.add(path);
  }

  if (mode === "incremental-rereview") {
    for (const path of deltaPaths) {
      focusPaths.add(path);
    }
    for (const thread of input.priorThreads) {
      if (!thread.resolved && thread.anchor?.path) {
        focusPaths.add(thread.anchor.path);
      }
      if (!thread.resolved && thread.anchor?.oldPath) {
        focusPaths.add(thread.anchor.oldPath);
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

  const selectedThreads = selectPriorThreads({
    priorThreads: input.priorThreads,
    focusPaths: selectedPathSet,
    mode,
    targetThread,
  });
  const selectedThreadIds = new Set(
    selectedThreads.map((thread) => thread.discussionId),
  );
  const selectedNotes = selectNotes(input.notes, mode);
  const selectedDiscussions =
    mode === "follow-up-thread"
      ? input.discussions.filter(
          (discussion) =>
            targetThread !== null &&
            discussion.id === targetThread.discussionId,
        )
      : input.discussions.filter((discussion) =>
          selectedThreadIds.has(discussion.id),
        );

  const omittedChangedFiles = input.changes
    .filter((change) => !selectedChanges.includes(change))
    .map((change) => toChangeSummary(change));

  const scope = buildScope({
    mode,
    trigger: input.trigger,
    targetThread,
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
    workspacePath: input.workspacePath,
    mergeRequest: input.mergeRequest,
    changes: selectedChanges,
    notes: selectedNotes,
    discussions: selectedDiscussions,
    instructionFiles: input.instructionFiles,
    projectMemory: input.projectMemory ?? {
      enabled: false,
      page: null,
      entries: [],
    },
    trigger: input.trigger,
    priorThreads: selectedThreads,
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
    return "follow-up-thread";
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
): GitLabMergeRequestChange[] {
  if (!changesJson) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(changesJson);
    return Array.isArray(parsed) ? (parsed as GitLabMergeRequestChange[]) : [];
  } catch {
    return [];
  }
}

function findDeltaChanges(
  currentChanges: GitLabMergeRequestChange[],
  previousChanges: GitLabMergeRequestChange[],
): GitLabMergeRequestChange[] {
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
  changes: GitLabMergeRequestChange[];
  focusPaths: Set<string>;
  mode: ReviewMode;
  deltaChanges: GitLabMergeRequestChange[];
  widenScopeHints: string[];
}): GitLabMergeRequestChange[] {
  const focusedChanges = input.changes.filter((change) => {
    const path = getChangePath(change);
    return input.focusPaths.has(path) || input.focusPaths.has(change.old_path);
  });

  const candidatePool =
    input.mode === "follow-up-thread"
      ? focusedChanges
      : input.mode === "incremental-rereview"
        ? input.deltaChanges.length > 0
          ? mergeChangesPreservingOrder(
              input.changes,
              focusedChanges,
              input.deltaChanges,
            )
          : input.changes
        : input.changes;

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

function mergeChangesPreservingOrder(
  orderedChanges: GitLabMergeRequestChange[],
  ...changeGroups: GitLabMergeRequestChange[][]
): GitLabMergeRequestChange[] {
  const included = new Set(
    changeGroups.flat().map((change) => getChangeSignature(change)),
  );
  return orderedChanges.filter((change) =>
    included.has(getChangeSignature(change)),
  );
}

function scoreChange(
  change: GitLabMergeRequestChange,
  focusPaths: Set<string>,
  widenScopeHints: string[],
): number {
  const path = getChangePath(change);
  let score = 0;

  if (focusPaths.has(path) || focusPaths.has(change.old_path)) {
    score += 1_000;
  }

  if (change.new_file || change.renamed_file || change.deleted_file) {
    score += 100;
  }

  if (/^(src|test)\//.test(path)) {
    score += path.startsWith("src/") ? 60 : 20;
  }

  if (
    /^(src\/(gitlab|jobs|reconcile|review|storage)\/|package\.json$|pnpm-lock\.yaml$|tsconfig(\..+)?\.json$|Dockerfile$|docker-compose\.yml$)/.test(
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

function collectWidenScopeHints(changes: GitLabMergeRequestChange[]): string[] {
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
    if (/^src\/storage\//.test(path) || /migration/i.test(path)) {
      hints.add("storage or migration behavior changed");
    }
    if (/^src\/(gitlab|review|reconcile|jobs)\//.test(path)) {
      hints.add("core review workflow code changed");
    }
  }

  return [...hints];
}

function selectPriorThreads(input: {
  priorThreads: ProviderThreadContext[];
  focusPaths: Set<string>;
  mode: ReviewMode;
  targetThread: ProviderThreadContext | null;
}): ProviderThreadContext[] {
  if (input.mode === "follow-up-thread") {
    return input.targetThread ? [input.targetThread] : [];
  }

  const candidateThreads =
    input.mode === "incremental-rereview"
      ? input.priorThreads.filter((thread) => !thread.resolved)
      : input.priorThreads;

  if (candidateThreads.length <= THREAD_LIMIT_BY_MODE[input.mode]) {
    return candidateThreads.slice();
  }

  return candidateThreads
    .map((thread, index) => ({
      thread,
      index,
      score:
        (thread.resolved ? 0 : 500) +
        (thread.anchor?.path && input.focusPaths.has(thread.anchor.path)
          ? 300
          : 0) +
        (thread.anchor?.oldPath && input.focusPaths.has(thread.anchor.oldPath)
          ? 300
          : 0) +
        Math.min(thread.humanReplies.length * 30, 120),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, THREAD_LIMIT_BY_MODE[input.mode])
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.thread);
}

function selectNotes(notes: GitLabNote[], mode: ReviewMode): GitLabNote[] {
  const limit = NOTE_LIMIT_BY_MODE[mode];
  return limit > 0 ? notes.slice(-limit) : [];
}

function buildScope(input: {
  mode: ReviewMode;
  trigger: ReviewTriggerContext;
  targetThread: ProviderThreadContext | null;
  previousReview: PreviousReviewSource | null;
  previousReviewResult: ReviewResult | null;
  priorFindings: PriorReviewFindingContext[];
  selectedChanges: GitLabMergeRequestChange[];
  allChangedFiles: ReviewChangeSummary[];
  omittedChangedFiles: ReviewChangeSummary[];
  deltaChanges: GitLabMergeRequestChange[];
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
  const scopeSummary =
    input.mode === "follow-up-thread"
      ? `Focus on the target bot-owned thread${input.targetThread ? ` "${input.targetThread.title}"` : ""} and the ${selectedChangeCount} directly related changed file(s).`
      : input.mode === "incremental-rereview"
        ? [
            input.trigger.kind === "summary-follow-up"
              ? "A reply on the bot-owned summary note requested another review pass."
              : input.trigger.instruction
                ? "Repeated direct mention requested a new review pass."
                : "Repeated direct mention requested another review pass.",
            input.previousReview
              ? `Start from review run ${input.previousReview.reviewRunId} at head ${input.previousReview.headSha}.`
              : "No previous review head was available; widen scope as needed.",
            `Prioritize the ${input.deltaChanges.length} file(s) changed since the previous review before widening beyond the delta.`,
            input.omittedChangedFiles.length > 0
              ? `${input.omittedChangedFiles.length} additional changed file(s) are summarized without inline diffs.`
              : "All current changed files are included in detail.",
          ].join(" ")
        : [
            input.previousReview
              ? "A fresh full rescan was explicitly requested even though a previous review exists."
              : "This is the first full review request for this merge request.",
            input.omittedChangedFiles.length > 0
              ? `${input.omittedChangedFiles.length} changed file(s) are summarized without inline diffs to keep the starting context bounded.`
              : "All changed files are included in detail.",
          ].join(" ");

  return {
    mode: input.mode,
    scopeSummary,
    widenScopeHints: input.widenScopeHints,
    allChangedFiles: input.allChangedFiles,
    omittedChangedFiles: input.omittedChangedFiles,
    targetThread: input.targetThread,
    previousReview,
    priorFindings: input.priorFindings,
    deltaSincePreviousReview,
  };
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
  change: GitLabMergeRequestChange,
  reason?: string,
): ReviewChangeSummary {
  return {
    path: getChangePath(change),
    oldPath: change.old_path,
    newFile: change.new_file,
    renamedFile: change.renamed_file,
    deletedFile: change.deleted_file,
    ...(reason ? { reason } : {}),
  };
}

function getChangePath(change: GitLabMergeRequestChange): string {
  return change.new_path || change.old_path;
}

function getChangeSignature(change: GitLabMergeRequestChange): string {
  return JSON.stringify({
    oldPath: change.old_path,
    newPath: change.new_path,
    diff: change.diff ?? "",
    newFile: change.new_file,
    renamedFile: change.renamed_file,
    deletedFile: change.deleted_file,
  });
}
