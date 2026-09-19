import type {
  InteractionRouter,
  RoutingDecision,
} from "../../src/review/interaction-router.js";

// Each orchestration test supplies a model decision; no text classification here.
export function fixtureRouter(
  actions: Partial<Pick<RoutingDecision, "review" | "reply" | "memory">> = {},
): Pick<InteractionRouter, "route"> {
  return {
    route: async ({ requests }) => ({
      source: "model",
      decisions: requests.map(({ id }) => ({
        requestId: id,
        review: true,
        reply: false,
        memory: false,
        ...actions,
        reason: "Model response supplied by test",
      })),
    }),
  };
}
