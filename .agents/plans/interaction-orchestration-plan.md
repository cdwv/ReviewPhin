# Interaction orchestration plan

## Goal

Split interaction handling into a deterministic router plus two LLM roles:

- **reviewer** for code-review artifacts
- **chatter** for local human-facing replies and memory extraction

The goal is to keep the heavy reviewer focused on review work while preserving conversation at the exact location where the human commented.

## Status after recent internal changes

This plan still points in the right direction, but it needs to be grounded in the architecture that now exists in the codebase:

- interaction terminology has already shifted from a review-only vocabulary to interaction jobs/runs
- Copilot session creation is now centralized in `HarnessSessionRuntime`
- tool and subagent registration is centralized in `src/harness/registry.ts`
- model-profile resolution already produces one reusable `HarnessModelConfig`
- prompts now flow through the instruction registry and prompt builders
- project memory writes and consolidation already flow through `ProjectMemoryService`

So the remaining work is mostly **orchestration refactoring and capability split**, not inventing a second parallel provider stack.

This plan also assumes **only one interaction run executes at a time**, so the initial design does not need claim coordination or parallel batch orchestration.

## Dependencies

This plan depends on the earlier interaction rename and centralized harness-session work being the baseline.

That dependency now appears effectively satisfied in the current code, so this plan should refine and extend the existing seams rather than reintroduce bespoke review/session creation paths.

## Current architecture constraints

The current implementation already has several concrete seams that this plan should build on:

- `src/jobs/review-worker.ts` still hydrates full merge-request context and materializes a workspace before it decides whether a heavy review is needed
- `src/review/trigger.ts` classifies webhook triggers and builds a review-centric trigger context, but it does not yet expose a general reply target / interaction plan
- `src/review/harness-review-provider.ts` launches review sessions through `HarnessSessionRuntime`
- `src/harness/registry.ts` controls available tools and subagents centrally
- `src/storage/types.ts` already persists both `model` and `textGenerationModel` on `InteractionRunRecord`
- `ProjectMemoryService` already serializes durable memory writes and performs post-write consolidation when needed

The orchestration plan should therefore target the **worker, trigger typing, planner, harness registry/runtime usage, and prompt split** as the primary change surfaces.

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
- technical handoff content for chatter when a human-facing reply must accompany a review pass

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

This is now easier to enforce because tool exposure is centralized in `src/harness/registry.ts`.

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
- `responseTargets`
- `replyStyle`
- `rerunReason`

For the next version of this plan, `responseTargets` should be treated as a list rather than a single field.

That gives the plan a clean path for:

- grouped comments that arrive close together and can share one review pass
- older unanswered comments that should be answered during a later successful run

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

### Practical refinement

Because `ReviewWorker` currently calls `hydrator.hydrate(...)` early, this plan should explicitly include either:

- a lighter pre-router data fetch path, or
- a split hydrator API with a lightweight phase and a full workspace/materialization phase

Without that split, the no-review path will keep paying for the exact work this plan is trying to avoid.

### Run grouping refinement

Run grouping fits this plan **reasonably well** if we keep one parent interaction run and allow multiple response targets/results inside it.

Recommended shape:

- one interaction run = one orchestration/review decision for one merge request state
- zero or one reviewer pass inside that run
- zero or one chatter pass inside that run
- the chatter pass may generate replies for multiple specific note/discussion targets in one batch

This is a moderate extension, not a separate architecture:

- the reviewer side still wants a single shared review context
- the router/planner needs to widen from singular trigger handling to a list of pending response candidates
- chatter needs one batch prompt that covers all included response targets instead of assuming one target

The main complication is not the LLM call itself. It is deciding **which pending comments are eligible to be grouped into the same run** and making that decision deterministic.

Recommended eligibility rules for the first version:

1. only group pending comments from the same tenant + merge request
2. do not mix bot-owned finding-thread replies with general chatter targets; existing finding-thread follow-up should stay on the current reviewer path
3. allow one run to answer multiple standalone mentions and summary-follow-up questions
4. allow backfilling older unanswered comments only when they still map to an open response target and were not superseded by a newer bot reply

This keeps grouped replies bounded and avoids turning the router into cross-thread policy soup.

### Mixed-batch refinement

if any of batch targets needs code review, we run code review first for entire batch. If any of batch targets need reply, we run one chatter reply for whole batch.

### Pending-target discovery

The plan now talks about `responseTargets`, but it should say more clearly **where they come from**.

Pending targets should come from lightweight GitLab note/discussion state inspection during routing.

Because the worker only executes **one run at a time**, the initial grouped-run design does **not** need:

- response-target claiming
- concurrent batch coordination
- overlap prevention between parallel parent runs

That keeps the first implementation focused on routing and grouped response generation rather than concurrency control.

## Reviewer output reuse for chatter

When both `reviewNeeded = true` and `replyNeeded = true`, chatter should not invent fresh technical reasoning from scratch.

Use reviewer-produced reply/explanation content as the authoritative technical handoff.

That handoff should support:

- explaining why a finding still applies
- explaining why a finding was dismissed or changed
- answering technical follow-up questions about reported findings
- producing a human-facing summary that stays faithful to the reviewer's reasoning

Refinement after recent changes:

- do not overload `overview.summary` for this purpose
- add an explicit reviewer-to-chatter handoff shape, either inside `ReviewResult` or alongside it
- keep the handoff structured enough that chatter can stay lightweight and avoid repository tools

For grouped replies, the handoff should use:

- one shared technical handoff
- one grouped reply input that lists all included targets/questions clearly

That keeps the first batch implementation simple while still letting chatter generate distinct replies for each target.

### Grouped chatter response contract

This is the main detail that should be locked in now.

The grouped chatter pass should return a structured payload shaped as:

- `memory`: optional memory-write decision/outcome for the batch
- `replies`: array of reply items, one per included target

Each reply item should include at least:

- target identity (`noteId` and/or `discussionId`, plus target kind)
- `replyBody`

Optional per-reply fields can be added later if needed, but the first version should stay minimal.

Recommended rule:

- chatter must return at most one reply item per included target
- chatter must not invent extra targets that were not present in the grouped input
- publish logic should depend only on this explicit structured output, not on freeform parsing heuristics

## Runtime order

### Path A - no review needed

1. classify trigger
2. gather lightweight router inputs only
3. resolve model profile/config
4. run router
5. build the list of eligible response targets
6. if `memoryCandidate`, let chatter persist memory
7. run one chatter pass for the grouped reply batch
8. stop

No workspace hydration. No reviewer session.

### Path B - review needed, no local reply needed

1. classify trigger
2. gather lightweight router inputs only
3. resolve model profile/config
4. run router
5. if `memoryCandidate`, let chatter persist memory first
6. hydrate full review context
7. run reviewer
8. reconcile findings + summary
9. stop

### Path C - review and local reply both needed

1. classify trigger
2. gather lightweight router inputs only
3. resolve model profile/config
4. run router
5. build the list of eligible response targets
6. if `memoryCandidate`, let chatter persist memory first
7. hydrate full review context using updated memory
8. run reviewer
9. reconcile findings + summary
10. capture reviewer-produced reply/explanation content from the same review pass
11. run one grouped chatter pass with:
    - the list of included trigger comments / pending targets being answered
    - response target metadata for each target
    - memory outcome
    - reviewer-produced reply/explanation content
    - compact review result / outcome summary when useful as extra context
12. publish all successful local replies
13. stop

### Path D - grouped backfill without new review

This path matters for older unanswered comments.

1. classify the current trigger or recovery event
2. gather lightweight router inputs plus unresolved pending reply targets
3. resolve model profile/config
4. run router
5. decide whether grouped pending questions can be answered from existing review state without a fresh review
6. run one grouped chatter pass for the eligible pending targets
7. stop

No workspace hydration. No reviewer session.

## Harness and runtime integration

This is the largest plan refinement required by the recent internal changes.

### Shared runtime

Both reviewer and chatter should run through `HarnessSessionRuntime`.

That keeps:

- provider/auth handling
- session logging
- Copilot CLI / SDK wiring
- durable memory tooling

on one existing runtime path.

### Reviewer runtime policy

Reviewer should keep the current tool-enabled review flow only when `reviewNeeded = true`, but reviewer sessions should stop exposing `add_memory_entry`.

### Chatter runtime policy

Chatter should run through the same runtime with:

- `model = resolvedConfig.textGenerationModel ?? resolvedConfig.reviewModel ?? undefined`
- no workspace directory unless a future reply mode explicitly needs one
- no repository inspection tools by default
- no code-reading subagents by default

### Logging and artifacts

Keep one parent interaction run for the webhook or grouped batch, but organize child harness session logs clearly.

The current harness logging shape already has the right hooks for this:

- `sessionKind`
- `pathSegments`
- `parentInteractionRunId`

Use those rather than inventing a second unrelated logging stack.

For grouped reply runs:

- one interaction run should remain the parent durable record
- reviewer and chatter sessions can still be logged as child harness sessions beneath that run
- if chatter answers multiple targets, the artifact directory should persist a machine-readable grouped reply payload plus per-target publish outcomes
- artifacts should also preserve the planner's inclusion/exclusion decisions so grouped-run behavior is explainable after the fact

## Tool and hydration efficiency

### Reviewer

Keep the current tool-enabled review flow only when `reviewNeeded = true`.

After the split, reviewer should use read-only repo tools only:

- `glob`
- `rg`
- `view`

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

## Persistence considerations

The current storage model already records enough provider/model metadata for reviewer + chatter model selection, so no schema change is required just to persist `textGenerationModel`.

The open question is the **result shape** for chatter-only interactions:

- `InteractionRunRecord.resultJson` is currently review-result-shaped in practice
- chatter-only paths should not fabricate empty review findings just to fit that shape

Preferred refinement:

- keep `resultJson` nullable for non-review runs
- persist orchestration/reply details in run artifacts first
- add a structured storage field only if later reporting requirements clearly need database queries over chatter outcomes

That keeps the first orchestration pass smaller and avoids premature schema expansion.

### Grouped-response persistence

Grouped reply support adds one new planning concern: a single interaction run may produce multiple reply attempts with different outcomes.

Recommended first step:

- keep `interaction_runs` as the parent execution record
- persist grouped reply planning and outcomes in run artifacts as structured JSON
- only add database tables after the product needs querying/reporting/retry behavior over individual response targets

If that later becomes necessary, the natural next table is something like a child `interaction_response_targets` record keyed by parent `interaction_run_id`.

That sequence keeps this extension moderate instead of forcing an immediate schema redesign.

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
- gather only the minimum state needed for the router before full hydration
- create an `InteractionPlan`
- allow `InteractionPlan` to contain multiple planned response actions, not just one
- separate per-target routing decisions from aggregate batch execution decisions
- preserve existing interaction-run / run-artifact / reaction handling
- skip workspace hydration entirely when `reviewNeeded = false`
- when `reviewNeeded = true` and `replyNeeded = true`, pass reviewer-produced reply/explanation content into chatter instead of publishing it directly
- run chatter after review when `replyNeeded = true`
- publish and record grouped reply outcomes without turning each target into a separate parent run

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

For grouped runs, add a second layer above raw trigger classification:

- one incoming trigger still identifies the initiating event
- the planner should be able to gather additional eligible pending response targets for the same merge request

### New file suggestion: `src/review/interaction-plan.ts`

Create a deterministic planner responsible for:

- normalizing trigger text
- applying the heuristic rules
- producing `reviewNeeded`, `replyNeeded`, `memoryCandidate`, and `responseTargets`
- producing one aggregate batch plan
- deciding which pending comments can be answered in the same parent run
- marking some pending comments ineligible when they require a separate review or belong to the reviewer-only finding-thread flow

### `src/review/types.ts`

Add types for:

- `ResponseTarget`
- `PlannedResponseAction`
- `InteractionPlan`
- `ReplyStyle`
- `ReviewerReplyHandoff` (or equivalent explicit reviewer-to-chatter payload)

Add any explicit orchestration result typing needed for chatter-only runs.

For grouped runs, prefer:

- one `initiatingTrigger`
- many `responseTargets`
- many `responseOutcomes`

instead of overloading the original singular trigger fields.

### `src/review/model-profiles.ts`

Keep using the existing model-profile resolution entry point and precedence rules.

Planned change:

- keep the resolved `HarnessModelConfig` reusable by both reviewer and chatter orchestration
- avoid creating a second chatter-specific profile lookup path
- preserve current fallback semantics for `textGenerationModel`

### New file suggestion: `src/review/harness-chatter.ts`

Add a small chatter runner that reuses `HarnessSessionRuntime` but returns reply/memory outcomes instead of review findings.

This should stay lighter than `HarnessReviewProvider`:

- no review JSON schema
- no review subagents by default
- no repo tools by default
- text-generation model selection from the shared resolved config

For grouped replies, this runner should support either:

- one chatter session per target, or
- one chatter session that receives the grouped reply batch and returns a list of outputs

The preferred first step is **one chatter call for the entire grouped batch** so review reasoning, memory context, and grouped targets stay together in one response-generation pass.

Its output contract should match the grouped chatter response contract above: one optional batch-level memory outcome plus one explicit reply item per included target.

### `src/review/harness-review-provider.ts`

Keep review-specific prompt construction and JSON parsing here, but narrow responsibilities to review work.

Planned changes:

- stop exposing `add_memory_entry` to reviewer sessions
- keep reviewer session logs clearly marked as review sessions
- if helpful, extract any reusable harness-launch helper shared with chatter without creating a second provider stack

### `src/harness/types.ts`

Add or refine types needed for chatter runs, for example:

- reply-oriented session kind values
- optional parent/child run metadata conventions if they are not already sufficient

Do not fork model configuration types just for chatter.

Grouped runs should also standardize target correlation data in logs/artifacts so each published reply can be traced back to its specific note/discussion target.

### `src/harness/registry.ts`

Adjust centralized runtime registration:

- reviewer path should expose read-only repo tools only
- chatter path should expose no repo tools by default
- `add_memory_entry` should be reachable from chatter, not reviewer
- add a chatter-specific agent/subagent registration only if the runtime benefits from explicit agent routing

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

Use the existing `ProjectMemoryService` path; do not create a second write path outside the harness tool.

For grouped runs, memory should be treated as a **batch-level side effect**, not a per-target side effect.

Recommended rule:

- collect all memory-candidate targets first
- perform at most one memory-write phase before any shared review
- let the one grouped chatter pass be the single source of any memory updates for that parent run

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
- reviewer no longer receives `add_memory_entry`
- chatter receives `add_memory_entry` only when memory is enabled
- summary-follow-up reply target correctness
- standalone note reply target correctness
- reviewer prompt no longer implies general conversational output
- chatter prompt registration / prompt-builder coverage
- grouped chatter output parses into the locked structured reply contract
- chatter-only run persistence does not require fabricated review findings
- grouped reply planning can produce multiple response targets in one parent run
- grouped reply execution can publish multiple successful replies after one review pass
- grouped chatter can return multiple target-specific replies from one batch pass
- partial grouped publish failure does not erase successful sibling replies from the same parent run
- stale/superseded unanswered comments are excluded from grouped backfill
- grouped backfill can answer older eligible comments without forcing a fresh review
- mixed batches with both review-needed and no-review targets produce one aggregate execution plan
- if any eligible target needs review, the grouped run performs one shared review and uses it for all grouped responses
- grouped memory candidates do not trigger duplicate competing memory writes inside one parent run

## Final recommendation

Implement this as a bounded hybrid:

1. deterministic router first
2. resolve one shared model profile/config for the whole interaction
3. chatter owns memory and final local replies, using the resolved chatter-side model selection
4. reviewer runs only when needed, using the resolved review model
5. when review and reply are both needed, chatter refines or directly uses the reviewer’s output instead of posting it unchanged
6. reviewer prompts become narrower, not broader
7. the shared harness runtime, registry, and model-profile path are reused rather than duplicated
8. grouped replies should be introduced by widening `InteractionPlan` to multiple response targets while keeping one parent interaction run
