# Interaction orchestration plan

## Goal

Split interaction handling into a deterministic router plus two LLM roles:

- **reviewer** for code-review artifacts
- **chatter** for local human-facing replies and memory extraction

The goal is to keep the heavy reviewer focused on review work while preserving conversation at the exact location where the human commented.

## Dependencies

This plan depends on:

1. the interaction rename plan
2. the centralized harness session creation plan

It should not start from the old review-only vocabulary or from bespoke session creation paths.

## Agent boundaries

This design assumes **two LLM agents**, not three:

- **reviewer** = LLM agent using the resolved model profile's `reviewModel`
- **chatter** = LLM agent using the same resolved model profile's `textGenerationModel` (falling back to `reviewModel` when `textGenerationModel` is unset)
- **router** = deterministic application logic, not an LLM in the base plan

If a routing model is ever added later, it should get explicit dedicated configuration rather than silently reusing reviewer/chatter model selection.

## Model profile integration

For every interaction, resolve **one effective model profile** using the existing precedence:

1. merge request override via `/reviewphin-profile <name>`
2. tenant-assigned model profile
3. database default model profile
4. plain Copilot CLI fallback

The orchestration path should pass that single resolved profile/config object into whichever components run for the interaction.

Role mapping inside the resolved profile:

- reviewer uses `reviewModel`
- chatter uses `textGenerationModel`
- if `textGenerationModel` is unset, chatter uses `reviewModel`
- any model-driven memory coalescing/write judgment that remains should follow the chatter-side model selection

Chatter-only interactions must still resolve the effective profile so provider/auth/model selection and logging stay observable even when no heavy review phase runs.

The deterministic router should not depend on model profiles in the base plan.

## Responsibilities

### Reviewer

The reviewer should own only:

- findings
- prior thread dispositions for existing bot-owned finding threads
- summary note updates
- review-state refinement after durable memory changes

The reviewer should stop being the primary place where non-thread human conversation is expressed.

### Chatter

The chatter should own:

- replies to standalone trigger comments
- replies on the summary-note discussion
- acknowledgement of instructions
- short explanations of what happened
- memory extraction / persistence from conversational comments

Chatter should be a small, low-context component with minimal tool usage and no repository inspection by default.

### Memory ownership

Memory should be owned by chatter, not by the main reviewer.

Reviewer role after this change:

- read `projectMemory`
- do not call `add_memory_entry`

Chatter role after this change:

- may call `add_memory_entry`
- may reply without review
- may update memory first and then trigger review when the new memory should refine findings

## Cheap router heuristic

The router should run before workspace hydration and before any heavy Copilot review session.

### Inputs

- webhook trigger kind
- trigger note text
- whether the trigger is inside an existing bot-owned finding thread
- whether a previous completed interaction/review exists
- whether open prior findings exist
- whether the trigger is on the summary-note discussion

### Outputs

The router should compute:

- `memoryCandidate: boolean`
- `reviewNeeded: boolean`
- `replyNeeded: boolean`
- `replyTarget`
- `replyStyle`
- `rerunReason`

### Base heuristic rules

1. existing bot-owned finding thread reply -> keep current follow-up-thread behavior; do not use chatter
2. pure review commands -> review only, no chatter
3. clear direct questions/conversational requests -> reply required, review only when reassessment is requested
4. wording/tone/summary refinement requests -> reply required, review only when new evaluation is requested
5. durable memory-style guidance -> memory candidate, reply required, review when prior review output should be refined
6. mention-only noise -> avoid chatter; only run review for actual review commands

Important principle:

- keep the router intentionally small and explicit
- do not let it become a second hidden policy engine

## Reviewer output reuse for chatter

When both `reviewNeeded = true` and `replyNeeded = true`, chatter should not invent fresh technical reasoning from scratch.

Use reviewer-produced reply/explanation content as the authoritative technical handoff.

That handoff should support:

- explaining why a finding still applies
- explaining why a finding was dismissed or changed
- answering technical follow-up questions about reported findings
- producing a human-facing summary that stays faithful to the reviewer's reasoning

If the current review result shape proves insufficient for that handoff, explicitly extend it rather than relying on an underspecified compact summary.

## Runtime order

### Path A - no review needed

1. classify trigger
2. run router
3. if `memoryCandidate`, let chatter persist memory
4. run chatter reply
5. stop

No workspace hydration. No reviewer session.

### Path B - review needed, no local reply needed

1. classify trigger
2. run router
3. if `memoryCandidate`, let chatter persist memory first
4. hydrate full review context
5. run reviewer
6. reconcile findings + summary
7. stop

### Path C - review and local reply both needed

1. classify trigger
2. run router
3. if `memoryCandidate`, let chatter persist memory first
4. hydrate full review context using updated memory
5. run reviewer
6. reconcile findings + summary
7. capture reviewer-produced reply/explanation content from the same review pass
8. run chatter with:
   - trigger comment
   - response target
   - memory outcome
   - reviewer-produced reply/explanation content
   - compact review result / outcome summary when useful as extra context
9. publish local reply

## Tool and hydration efficiency

### Reviewer

Keep the current tool-enabled review flow only when `reviewNeeded = true`.

### Chatter

Chatter should default to:

- no repository inspection tools
- no code-reading subagents
- no workspace hydration
- small prompt
- small context

Allowed tool:

- `add_memory_entry` only when `memoryCandidate = true`

If chatter needs grounding from the review, provide reviewer-produced output and compact review context instead of repository tools.

### API efficiency

Reuse data already fetched during trigger classification and lightweight merge-request metadata reads where possible.

The no-review path should avoid:

- workspace materialization
- changed-file hydration
- reviewer Copilot session

## Concrete code changes

### `src/jobs/review-worker.ts`

Turn this into the orchestrator of:

- router
- shared model-profile resolution
- optional memory write
- optional review
- reviewer-output-to-chatter handoff
- optional local reply

Planned changes:

- resolve the effective model profile/config once before branching
- load only the minimum state needed for the router
- compute an interaction plan
- run memory update before review when required
- skip hydration entirely when `reviewNeeded = false`
- when `reviewNeeded = true` and `replyNeeded = true`, pass reviewer-produced reply/explanation content into chatter instead of publishing it directly
- run chatter after review when `replyNeeded = true`

### `src/review/trigger.ts`

Extend trigger context so non-thread triggers carry explicit response-target information.

Likely additions:

- `responseTarget.kind`
- `responseTarget.noteId`
- `responseTarget.discussionId`
- `responseTarget.locationType`

This should distinguish:

- summary-discussion reply target
- standalone merge-request note target
- existing bot-owned review-thread target

### New file suggestion: `src/review/interaction-plan.ts`

Create a deterministic planner responsible for:

- normalizing trigger text
- applying the heuristic rules
- producing `reviewNeeded`, `replyNeeded`, `memoryCandidate`, and `responseTarget`

### `src/review/model-profiles.ts`

Keep using the existing model-profile resolution entry point and precedence rules.

Planned change:

- make the resolved profile/config reusable by both reviewer and chatter orchestration
- avoid creating a second chatter-specific profile lookup path
- preserve current fallback semantics for `textGenerationModel`

### `src/review/types.ts`

Add types for:

- `ResponseTarget`
- `InteractionPlan`
- `ReplyStyle`

Add any explicit reviewer-to-chatter handoff shape needed if the current review result is not sufficient.

### Prompt and instruction changes

Add dedicated chatter prompt fragments/templates in `src/prompts/instruction-registry.ts`, for example:

- `reply/chatter.md`
- `reply/summary-follow-up.md`
- `reply/direct-mention.md`
- `reply/review-result.md`
- optional `reply/memory-update.md`

Suggested registered templates:

- `reply.direct-mention`
- `reply.summary-follow-up`
- `reply.direct-mention.after-review`
- `reply.summary-follow-up.after-review`

Add a separate prompt builder in `src/prompts/prompt-builders.ts`, for example `buildReplyPrompt(...)`, independent from `buildReviewPrompt(...)`.

Narrow the reviewer prompts so non-thread conversational replies are treated as outside the review artifact path except for existing bot-owned finding threads.

Review prompt changes should explicitly cover:

- `prompts/review/summary-follow-up.md`
- `prompts/review/main.md`
- `prompts/review/review-author.md`

### Memory flow

Ownership decision:

- chatter owns memory writes

When memory is written:

1. router says `memoryCandidate = true`
2. chatter receives the trigger comment and current memory snapshot
3. chatter either writes a durable memory entry or decides no durable memory should be written

When review runs after memory:

- if memory changed and a previous review exists, run incremental re-review so findings and summary can be refined using the new memory

When no review runs:

- persist memory
- reply locally confirming it
- do not pay for review

## Tests

Plan tests for:

- heuristic classification for pure review commands
- heuristic classification for question-only comments
- heuristic classification for memory-only comments
- memory-change-triggered re-review decision
- no-review path skips workspace hydration
- review-only path skips chatter
- review-plus-reply path runs both in the right order
- review-plus-reply path reuses reviewer-produced reply/explanation content before chatter runs
- chatter reply remains faithful to reviewer-produced output for finding explanations
- chatter-only path still resolves model profile using existing precedence
- chatter uses `textGenerationModel` and falls back to `reviewModel`
- chatter inherits provider/auth settings from the resolved profile rather than using ad hoc config
- summary-follow-up reply target correctness
- standalone note reply target correctness
- reviewer prompt no longer implies general conversational output
- chatter prompt registration / prompt-builder coverage

## Final recommendation

Implement this as a bounded hybrid:

1. deterministic router first
2. resolve one shared model profile/config for the whole interaction
3. chatter owns memory and final local replies, using the resolved chatter-side model selection
4. reviewer runs only when needed, using the resolved review model
5. when review and reply are both needed, chatter refines or directly uses the reviewer’s output instead of posting it unchanged
6. reviewer prompts become narrower, not broader
7. the shared Copilot session entrypoint from the session plan is reused by reviewer and chatter flows
