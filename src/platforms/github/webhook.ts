import { z } from "zod";

import type { PlatformWebhookRequest } from "../IPlatform.js";

const githubWebhookBodySchema = z
  .object({
    action: z.string().min(1).optional(),
    installation: z
      .object({
        id: z.number().int().positive(),
      })
      .passthrough()
      .optional(),
    repository: z
      .object({
        id: z.number().int().positive(),
        full_name: z.string().min(3).optional(),
      })
      .passthrough()
      .optional(),
    pull_request: z
      .object({
        number: z.number().int().positive(),
        head: z.object({
          sha: z.string().min(1),
        }),
      })
      .passthrough()
      .optional(),
    issue: z
      .object({
        number: z.number().int().positive(),
        pull_request: z.object({}).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    comment: z
      .object({
        id: z.number().int().positive(),
        body: z.string(),
        in_reply_to_id: z.number().int().positive().optional(),
        user: z
          .object({
            id: z.number().int().positive(),
            login: z.string().min(1),
            type: z.string().min(1).optional(),
          })
          .passthrough()
          .nullable(),
      })
      .passthrough()
      .optional(),
    requested_action: z
      .object({
        identifier: z.string().min(1),
      })
      .passthrough()
      .optional(),
    check_run: z
      .object({
        id: z.number().int().positive(),
        head_sha: z.string().min(1),
        app: z.object({
          id: z.number().int().positive(),
        }),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface GitHubWebhookPayload {
  body: z.infer<typeof githubWebhookBodySchema>;
  deliveryId: string;
  eventName: string;
  action: string | null;
  installationId: number | null;
  repositoryId: number | null;
  requestedActionIdentifier: string | null;
  checkRunId: number | null;
  checkRunHeadSha: string | null;
  checkRunAppId: number | null;
  pullRequestNumber: number | null;
  pullRequestHeadSha: string | null;
  issueIsPullRequest: boolean;
  commentId: number | null;
  commentBody: string | null;
  commentAuthorLogin: string | null;
  commentAuthorType: string | null;
  commentInReplyToId: number | null;
}

export function parseGitHubWebhook(
  payload: unknown,
  req?: PlatformWebhookRequest,
): GitHubWebhookPayload {
  if (!req) {
    throw new Error("GitHub webhook request metadata is required");
  }
  const body = githubWebhookBodySchema.parse(payload);
  const deliveryId = getRequiredHeader(req, "x-github-delivery");
  const eventName = getRequiredHeader(req, "x-github-event");
  const pullRequestNumber =
    body.pull_request?.number ??
    (body.issue?.pull_request ? body.issue.number : null);
  return {
    body,
    deliveryId,
    eventName,
    action: body.action ?? null,
    installationId: body.installation?.id ?? null,
    repositoryId: body.repository?.id ?? null,
    requestedActionIdentifier: body.requested_action?.identifier ?? null,
    checkRunId: body.check_run?.id ?? null,
    checkRunHeadSha: body.check_run?.head_sha ?? null,
    checkRunAppId: body.check_run?.app.id ?? null,
    pullRequestNumber,
    pullRequestHeadSha: body.pull_request?.head.sha ?? null,
    issueIsPullRequest: Boolean(body.issue?.pull_request),
    commentId: body.comment?.id ?? null,
    commentBody: body.comment?.body ?? null,
    commentAuthorLogin: body.comment?.user?.login ?? null,
    commentAuthorType: body.comment?.user?.type ?? null,
    commentInReplyToId: body.comment?.in_reply_to_id ?? null,
  };
}

export function isGitHubWebhookPayload(
  payload: unknown,
): payload is GitHubWebhookPayload {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const candidate = payload as Partial<GitHubWebhookPayload>;
  return (
    typeof candidate.deliveryId === "string" &&
    typeof candidate.eventName === "string" &&
    (typeof candidate.installationId === "number" ||
      candidate.installationId === null) &&
    (typeof candidate.repositoryId === "number" ||
      candidate.repositoryId === null) &&
    !!candidate.body &&
    typeof candidate.body === "object"
  );
}

export function getGitHubSignatureHeader(
  req: PlatformWebhookRequest,
): string | null {
  return getHeader(req, "x-hub-signature-256");
}

function getRequiredHeader(req: PlatformWebhookRequest, name: string): string {
  const value = getHeader(req, name);
  if (!value) {
    throw new Error(`Missing GitHub webhook header ${name}`);
  }
  return value;
}

function getHeader(req: PlatformWebhookRequest, name: string): string | null {
  const value = req.headers[name];
  const resolved = Array.isArray(value) ? value[0] : value;
  return typeof resolved === "string" && resolved.length > 0 ? resolved : null;
}
