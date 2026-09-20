import { createHash } from "node:crypto";
import type {
  AdmitInteractionInput,
  InteractionJobRecord,
  InteractionRequestRecord,
} from "./contract/index.js";

export const MAX_BATCH_WAIT_MS = 60_000;
export const MAX_BATCH_REQUESTS = 32;
export const MAX_BATCH_BYTES = 256 * 1024;

export function interactionRequestId(
  tenantId: string,
  dedupeKey: string,
): string {
  return `request_${createHash("sha256")
    .update(JSON.stringify([tenantId, dedupeKey]))
    .digest("hex")}`;
}

export function createInteractionRequest(
  input: AdmitInteractionInput,
): InteractionRequestRecord {
  const request = input.request;
  if (
    !Number.isSafeInteger(input.debounceMs) ||
    input.debounceMs < 0 ||
    !Number.isFinite(Date.parse(input.now))
  ) {
    throw new Error("Invalid interaction admission clock or debounce interval");
  }
  return {
    id: interactionRequestId(request.tenantId, request.dedupeKey),
    tenantId: request.tenantId,
    codeReviewId: request.codeReviewId,
    dedupeKey: request.dedupeKey,
    interactionJobId: null,
    commentId: request.commentId,
    triggerJson:
      request.triggerJson ??
      JSON.stringify({ kind: "comment", commentId: request.commentId }),
    payloadJson: request.payloadJson,
    headSha: request.headSha,
    receivedAt: input.now,
    admittedAt: null,
    debounceMs: input.debounceMs,
  };
}

export function requestBytes(request: InteractionRequestRecord): number {
  return (
    Buffer.byteLength(request.payloadJson) +
    Buffer.byteLength(request.triggerJson)
  );
}

export function batchReadyAt(
  requests: readonly InteractionRequestRecord[],
): string {
  if (!requests.length) throw new Error("An empty batch cannot be scheduled");
  const ordered = [...requests].sort(
    (a, b) =>
      a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id),
  );
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  const full =
    requests.length >= MAX_BATCH_REQUESTS ||
    requests.reduce((sum, request) => sum + requestBytes(request), 0) >=
      MAX_BATCH_BYTES;
  return new Date(
    Math.min(
      Date.parse(first.receivedAt) + MAX_BATCH_WAIT_MS,
      Date.parse(last.receivedAt) + (full ? 0 : last.debounceMs),
    ),
  ).toISOString();
}

export function canAppendRequest(
  job: InteractionJobRecord,
  requests: readonly InteractionRequestRecord[],
  request: InteractionRequestRecord,
  now: string,
): boolean {
  return (
    job.batchKind === "comment" &&
    job.status === "queued" &&
    job.startedAt === null &&
    job.retryCount === 0 &&
    job.tenantId === request.tenantId &&
    job.codeReviewId === request.codeReviewId &&
    request.debounceMs > 0 &&
    job.availableAt > now &&
    requests.length < MAX_BATCH_REQUESTS &&
    requests.reduce(
      (sum, item) => sum + requestBytes(item),
      requestBytes(request),
    ) <= MAX_BATCH_BYTES
  );
}

export function createBatchJob(
  request: InteractionRequestRecord,
): InteractionJobRecord {
  return {
    id: `job_${request.id.slice("request_".length)}`,
    tenantId: request.tenantId,
    codeReviewId: request.codeReviewId,
    dedupeKey: `batch:${request.id}`,
    commentId: request.commentId,
    triggerJson: request.triggerJson,
    payloadJson: request.payloadJson,
    headSha: request.headSha,
    batchKind: "comment",
    status: "queued",
    retryCount: 0,
    lastError: null,
    enqueuedAt: request.receivedAt,
    availableAt: batchReadyAt([request]),
    startedAt: null,
    finishedAt: null,
    claimToken: null,
    claimedBy: null,
    claimExpiresAt: null,
    latestInteractionRunId: null,
  };
}
