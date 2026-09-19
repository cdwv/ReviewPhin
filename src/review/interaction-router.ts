import { LeaseLostError } from "../storage/storage-helpers.js";
import { z } from "zod";
import { renderPrompt } from "../prompts/instruction-renderer.js";
import type { HarnessSessionRuntime } from "../harness/session.js";
import type {
  HarnessModelConfig,
  HarnessRunLoggingContext,
} from "../harness/types.js";
import type {
  ChatterBatchResult,
  InteractionPlan,
  InteractionRequestContext,
  PriorReviewFindingContext,
  ProviderDiscussionContext,
  ResponseTarget,
} from "./types.js";

const decisionSchema = z
  .object({
    requestId: z.string().min(1),
    review: z.boolean(),
    memory: z.boolean(),
    reply: z.boolean(),
    reason: z.string().min(1).max(300),
  })
  .strict();
export const routingResultSchema = z
  .object({ decisions: z.array(decisionSchema).min(1).max(32) })
  .strict();
export type RoutingDecision = z.infer<typeof decisionSchema>;
export interface RoutingInput {
  requests: InteractionRequestContext[];
  previousReviewExists: boolean;
  priorFindings: ReadonlyArray<Pick<PriorReviewFindingContext, "status">>;
  memoryEnabled: boolean;
  discussions?: ReadonlyArray<ProviderDiscussionContext>;
}
export interface InteractionRoutingResult {
  decisions: RoutingDecision[];
  source: "model" | "chatter";
  model?: string | null | undefined;
  reasoningEffort?:
    HarnessModelConfig["textGenerationReasoningEffort"] | undefined;
  fallbackReason?: string | undefined;
}

export class InteractionRouter {
  public constructor(
    private readonly runtime: Pick<HarnessSessionRuntime, "run">,
  ) {}

  public async route(
    input: RoutingInput,
    config: HarnessModelConfig,
    logging?: HarnessRunLoggingContext,
  ): Promise<InteractionRoutingResult> {
    const context = JSON.stringify({
      requests: input.requests,
      previousReviewExists: input.previousReviewExists,
      memoryEnabled: input.memoryEnabled,
      priorFindings: input.priorFindings
        .slice(0, 25)
        .map((finding) => ({ status: finding.status })),
      discussions: input.discussions
        ?.filter((d) =>
          input.requests.some(
            (r) => r.trigger.targetDiscussionId === d.discussionId,
          ),
        )
        .slice(0, 8)
        .map((d) => ({
          id: d.discussionId,
          title: d.title,
          body: d.body.slice(0, 1000),
          resolved: d.resolved,
          recentReplies: d.humanReplies.slice(-3).map((r) => ({
            author: r.authorUsername,
            body: r.body.slice(0, 500),
          })),
        })),
    });
    if (context.length > 48_000)
      throw new Error("Routing context exceeds 48000 characters");
    const chatter = {
      model: config.textGenerationModel ?? config.reviewModel ?? undefined,
      reasoningEffort: config.textGenerationReasoningEffort ?? undefined,
    };
    const selected = {
      model: config.routingModel?.trim() || chatter.model,
      reasoningEffort: config.routingReasoningEffort ?? chatter.reasoningEffort,
    };
    const classify = async (
      selection: typeof selected,
    ): Promise<InteractionRoutingResult> => {
      const result = await this.runtime.run({
        modelConfig: config,
        model: selection.model,
        ...(selection.reasoningEffort
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
        tools: [],
        subagents: [],
        overallTimeoutMs: 20_000,
        timeoutMs: 20_000,
        logging: {
          ...logging,
          interactionRunId: logging?.interactionRunId ?? null,
          interactionJobId: logging?.interactionJobId ?? null,
          tenantId: logging?.tenantId ?? null,
          pathSegments: ["copilot", "routing"],
          sessionKind: "routing",
        },
        prompt: [
          renderPrompt("routing.classify", {}),
          "Return JSON matching: " +
            JSON.stringify(routingResultSchema.toJSONSchema()),
          "Collected requests and context: " + context,
        ].join("\n"),
        responseFormat: {
          schema: routingResultSchema.superRefine((result, ctx) => {
            try {
              validateDecisions(input.requests, result.decisions);
            } catch {
              ctx.addIssue({
                code: "custom",
                message:
                  "Return exactly one decision for each of: " +
                  input.requests.map((r) => r.id).join(", "),
              });
            }
          }),
          looksLike: (value) => "decisions" in value,
        },
      });
      const { decisions } = routingResultSchema.parse(result.parsed);
      validateDecisions(input.requests, decisions);
      return {
        decisions: decisions.map((d) => ({
          ...d,
          memory: input.memoryEnabled && d.memory,
        })),
        source: "model",
        model: selection.model ?? null,
        reasoningEffort: selection.reasoningEffort ?? null,
      };
    };
    try {
      return await classify(selected);
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      if (
        selected.model === chatter.model &&
        selected.reasoningEffort === chatter.reasoningEffort
      )
        throw error;
      return {
        ...(await classify(chatter)),
        source: "chatter",
        fallbackReason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function validateDecisions(
  requests: InteractionRequestContext[],
  decisions: RoutingDecision[],
): void {
  const ids = new Set(requests.map((request) => request.id));
  if (
    decisions.length !== ids.size ||
    new Set(decisions.map((d) => d.requestId)).size !== ids.size ||
    decisions.some((d) => !ids.has(d.requestId))
  ) {
    throw new Error("Routing decisions must cover every request exactly once");
  }
}

export function reduceRoutingDecisions(
  requests: InteractionRequestContext[],
  decisions: RoutingDecision[],
): InteractionPlan {
  validateDecisions(requests, decisions);
  const first = requests[0];
  if (!first) throw new Error("Cannot route an empty batch");
  const replies = requests.filter(
    (r) => decisions.find((d) => d.requestId === r.id)?.reply,
  );
  const responseTargets = [
    ...new Map(
      replies.map((r) => [
        targetKey(r.trigger.responseTarget),
        r.trigger.responseTarget,
      ]),
    ).values(),
  ];
  return {
    initiatingTrigger: first.trigger,
    responseTargets,
    plannedResponses: responseTargets.map((target) => ({
      target,
      replyStyle: "direct-answer",
      reviewNeeded: decisions.some((d) => d.review),
      memoryCandidate: decisions.some((d) => d.memory),
    })),
    memoryCandidate: decisions.some((d) => d.memory),
    reviewNeeded: decisions.some((d) => d.review),
    replyNeeded: replies.length > 0,
    replyStyle: replies.length ? "direct-answer" : "none",
    rerunReason:
      decisions
        .filter((d) => d.review)
        .map((d) => d.reason)
        .join("; ") || null,
  };
}

export function targetKey(
  target: Pick<ResponseTarget, "kind" | "commentId" | "discussionId">,
): string {
  return JSON.stringify([
    target.kind,
    target.discussionId ?? null,
    target.commentId,
  ]);
}

export function validateReplyCoverage(
  requests: InteractionRequestContext[],
  result: ChatterBatchResult,
): void {
  const expected = new Map(
    requests.map((r) => [r.id, r.trigger.responseTarget]),
  );
  const covered = new Set<string>();
  for (const reply of result.replies) {
    if (!reply.replyBody.trim() || !reply.coveredRequestIds?.length)
      throw new Error("Batch reply is empty or has no request coverage");
    if (
      !requests.some(
        (r) => targetKey(r.trigger.responseTarget) === targetKey(reply.target),
      )
    )
      throw new Error("Reply target is not part of the batch");
    for (const id of reply.coveredRequestIds) {
      const target = expected.get(id);
      const sameThread =
        target &&
        target.kind === reply.target.kind &&
        target.kind !== "code-review-comment" &&
        target.discussionId === reply.target.discussionId;
      if (
        !target ||
        covered.has(id) ||
        (!sameThread && targetKey(target) !== targetKey(reply.target))
      )
        throw new Error(
          "Reply covers an unknown, duplicate, or unrelated request",
        );
      covered.add(id);
    }
  }
  if (covered.size !== expected.size)
    throw new Error("Batch replies do not answer every planned request");
}
