import { vi } from "vitest";

import type {
  InteractionJobRecord,
  InteractionJobStore,
  InteractionRunRecord,
} from "../../src/storage/contract/index.js";
import {
  type JobClaimContext,
  LeaseLostError,
} from "../../src/storage/storage-helpers.js";

/**
 * Builds a non-aborting {@link JobClaimContext} for worker unit tests. The
 * returned controller lets a test abort the context to simulate lease loss.
 */
export function createClaimContext(
  jobId: string,
  claimToken = "claim-token-1",
): JobClaimContext & { controller: AbortController } {
  const controller = new AbortController();
  return {
    jobId,
    claimToken,
    signal: controller.signal,
    interactionRunId: null,
    controller,
    assertOwned() {
      if (controller.signal.aborted) {
        throw new LeaseLostError();
      }
    },
  };
}

type CreateRunInput = Parameters<
  InteractionJobStore["createInteractionRunForClaim"]
>[0];
type TransitionRunInput = Parameters<
  InteractionJobStore["transitionInteractionRunForClaim"]
>[0];
type ReplaceFindingsInput = Parameters<
  InteractionJobStore["replaceReviewFindingsForClaim"]
>[0];
type MetricsInput = Parameters<
  InteractionJobStore["upsertInteractionRunMetricsForClaim"]
>[0];
type SnapshotInput = Parameters<
  InteractionJobStore["createCodeReviewSnapshotForClaim"]
>[0];
type FindingStatusInput = Parameters<
  InteractionJobStore["updateReviewFindingStatusForClaim"]
>[0];
type MappingInput = Parameters<
  InteractionJobStore["upsertDiscussionMappingForClaim"]
>[0];
type TransitionClaimInput = Parameters<
  InteractionJobStore["transitionClaim"]
>[0];

type SnapshotResult = Awaited<
  ReturnType<InteractionJobStore["createCodeReviewSnapshotForClaim"]>
>;
type MappingResult = Awaited<
  ReturnType<InteractionJobStore["upsertDiscussionMappingForClaim"]>
>;

/**
 * Default vi.fn implementations for the claim-aware interaction-job store used by
 * the worker. `createInteractionRunForClaim` returns the provided run record and
 * every ownership-gated operation succeeds by default; individual tests override
 * specific mocks via `mockImplementation` to exercise lease-loss or failure
 * paths. Parameters are typed from the storage contract so overrides receive
 * fully typed inputs.
 */
export function createClaimAwareJobStoreFake(options: {
  get: () => Promise<InteractionJobRecord | null>;
  run: InteractionRunRecord;
}) {
  return {
    get: vi.fn(options.get),
    createInteractionRunForClaim: vi.fn(
      async (_input: CreateRunInput): Promise<InteractionRunRecord | null> =>
        options.run,
    ),
    transitionInteractionRunForClaim: vi.fn(
      async (_input: TransitionRunInput): Promise<boolean> => true,
    ),
    replaceReviewFindingsForClaim: vi.fn(
      async (_input: ReplaceFindingsInput): Promise<boolean> => true,
    ),
    upsertInteractionRunMetricsForClaim: vi.fn(
      async (_input: MetricsInput): Promise<boolean> => true,
    ),
    createCodeReviewSnapshotForClaim: vi.fn(
      async (_input: SnapshotInput): Promise<SnapshotResult> => null,
    ),
    updateReviewFindingStatusForClaim: vi.fn(
      async (_input: FindingStatusInput): Promise<boolean> => true,
    ),
    upsertDiscussionMappingForClaim: vi.fn(
      async (_input: MappingInput): Promise<MappingResult> => null,
    ),
    transitionClaim: vi.fn(
      async (_input: TransitionClaimInput): Promise<boolean> => true,
    ),
  };
}
