# Reviewer + chatter plan

## Goal

Keep the main reviewer focused on code-review artifacts while preserving conversation at the exact location where the human commented.

Chosen approach:

1. run a **cheap heuristic router**
2. decide whether the trigger needs:
   - memory update
   - code review
   - local reply
3. run the heavy reviewer only when review is actually needed
4. run a small **chatter** component for human-facing local replies

This plan intentionally drops the broader option comparison and focuses only on this path.

## Agent boundaries

This plan assumes **two LLM agents**, not three:

- **reviewer** = LLM agent - gpt-5.4 (it should be default under REVIEWPHIN_CODE_REVIEW_MODEL env)
- **chatter** = LLM agent - claude-sonnet-4.6 (it should be default under REVIEWPHIN_TEXT_GENERATION_MODEL env)
- **router** = **not** an LLM agent by default, possibly gpt-5-mini later (if added, it should be default under REVIEWPHIN_ROUTER_MODEL env)

The router should be implemented as deterministic application logic.

Reasoning:

- it runs on every relevant webhook
- it should be cheap, predictable, and fast
- its job is only to make a small routing decision, not to inspect code deeply

If later evidence shows the deterministic rules are not good enough, a tiny routing model can be introduced as a second-phase optimization. But that is explicitly **not** the starting plan.

## High-level execution model

### Main reviewer responsibilities

The reviewer should own only:

- findings
- prior thread dispositions for existing bot-owned finding threads
- summary note updates
- review-state refinement after durable memory changes

The reviewer should stop being the primary place where non-thread human conversation is expressed.

### Chatter responsibilities

The chatter should own:

- replies to standalone trigger comments
- replies on the summary-note discussion
- acknowledgement of instructions
- short explanations of what happened
- memory extraction / persistence from conversational comments

The chatter should be a small, low-context component with minimal or no tool usage.

### Memory ownership

**Memory should be owned by chatter, not by the main reviewer.**

Reasoning:

- memory requests can happen even when no review is needed
- memory comes from human conversational intent more often than from code evidence
- centralizing memory writes in chatter avoids duplicate or conflicting writes
- if memory should influence the current review, chatter can update memory **before** the reviewer runs

Reviewer role after this change:

- read `projectMemory`
- do not call `update_project_memory`

Chatter role after this change:

- may call `update_project_memory`
- may reply without review
- may update memory first and then trigger review when the new memory should refine findings

## Cheap router heuristic

The router should be deterministic and should run before workspace hydration and before any heavy Copilot review session.

It is **application logic**, not a model prompt.

### Inputs

- webhook trigger kind
- trigger note text
- whether the trigger is inside an existing bot-owned finding thread
- whether a previous completed review exists
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

### Suggested heuristic rules

#### 1. Existing bot-owned finding thread reply

If the comment is inside an existing bot-owned finding thread:

- keep current `follow-up-thread` behavior
- do **not** use chatter
- let reviewer handle the existing thread through findings / dispositions

This keeps the current strong path unchanged.

#### 2. Pure review commands

If normalized text is basically one of:

- `review`
- `re-review`
- `review again`
- `rerun review`
- `please review`
- `please re-review`
- bot mention plus one of the above and little else

Then:

- `reviewNeeded = true`
- `replyNeeded = false`
- `memoryCandidate = false`

This avoids unnecessary chatter runs.

#### 3. Clear direct question or conversational request

If the comment contains a question mark, interrogative phrasing, or explicit conversational intent such as:

- `why`
- `can you explain`
- `what do you mean`
- `is this still an issue`
- `should this be changed`
- `can you answer`
- `please clarify`

Then:

- `replyNeeded = true`

Review decision:

- `reviewNeeded = true` only if the question asks for reassessment of code, findings, or merge readiness
- otherwise `reviewNeeded = false`

#### 4. Wording / tone / summary refinement requests

If the trigger asks to:

- reword
- make more human
- make shorter
- clarify summary
- explain differently
- improve tone

Then:

- `replyNeeded = true`
- `reviewNeeded = false` by default for standalone comments and summary replies
- `reviewNeeded = true` only if the comment also requests a new evaluation of code or previous findings

#### 5. Durable memory-style guidance

If the trigger contains phrases like:

- `for future reference`
- `please remember`
- `in the future`
- `from now on`
- `our convention is`
- `team preference`
- `always`
- `never`

Then:

- `memoryCandidate = true`
- `replyNeeded = true`

Review decision:

- if a previous completed review exists, default `reviewNeeded = true` so the new memory can refine findings and summary behavior
- if no previous review exists and the comment does not ask for review, `reviewNeeded = false`

This matches the intended product behavior that memory often implies a re-review of prior output.

#### 6. Mention-only noise

If the text is effectively only:

- bot mention
- bot mention + `review`
- bot mention + very short acknowledgment with no request

Then:

- avoid chatter
- only run review when the message is an actual review command

### Important heuristic principle

The router should be intentionally small and explicit.

It should not try to become a second hidden policy engine. If it starts to accumulate too many special cases, that is the point where a tiny routing model could be reconsidered later.

## Which parts are LLM-driven

### Reviewer

Yes. This is the existing heavy LLM review path.

Use it only when `reviewNeeded = true`.

### Chatter

Yes. This is a small LLM reply generator.

Use it only when `replyNeeded = true` or when a memory candidate needs an LLM judgment about whether the comment is truly durable enough to persist.

### router

No, not in the base plan.

router should only answer small routing questions such as:

- is this basically a rerun command?
- is this obviously a direct question?
- is this obviously a memory-style request?
- is this inside an existing bot-owned finding thread?

Those are intentionally coarse decisions. The nuanced judgment stays in chatter and reviewer.

## Proposed runtime order

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

No chatter reply.

### Path C - review and local reply both needed

1. classify trigger
2. run router
3. if `memoryCandidate`, let chatter persist memory first
4. hydrate full review context using updated memory
5. run reviewer
6. reconcile findings + summary
7. run chatter with:
   - trigger comment
   - response target
   - memory outcome
   - compact review result / outcome summary
8. publish local reply

## Tool-usage minimization

This option should reduce tool usage rather than increase it.

### Reviewer

Keep current tool-enabled review flow only when `reviewNeeded = true`.

### Chatter

Chatter should default to:

- no repository inspection tools
- no code-reading subagents
- no workspace hydration
- small prompt
- small context

Allowed capability:

- `update_project_memory` only when `memoryCandidate = true`

If the chatter needs grounding from the review, provide the already-produced review result as input instead of giving it code-reading tools.

### API / hydration efficiency

Try to reuse data already fetched during trigger classification and lightweight merge-request metadata reads.

The no-review path should avoid:

- workspace materialization
- changed-file hydration
- reviewer Copilot session

## Concrete code changes

### Reviewer / worker flow

#### `src/jobs/review-worker.ts`

Add a lightweight planning phase before full hydration:

- load only the minimum state needed for router
- compute an interaction plan
- run memory update before review when required
- skip hydration entirely when `reviewNeeded = false`
- run chatter after review when `replyNeeded = true`

This file becomes the orchestrator of:

- router
- optional memory write
- optional review
- optional local reply

#### `src/review/trigger.ts`

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

#### New file suggestion: `src/review/interaction-plan.ts`

Create a small deterministic planner responsible for:

- normalizing trigger text
- applying the heuristic rules
- producing `reviewNeeded`, `replyNeeded`, `memoryCandidate`, and `responseTarget`

This keeps branching logic out of `review-worker.ts`.

#### `src/review/types.ts`

Add types for:

- `ResponseTarget`
- `InteractionPlan`
- `ReplyStyle`

Keep them separate from `ReviewResult` so review artifacts and conversation artifacts do not blur together.

### Chatter provider

#### New file suggestion: `src/review/chatter-provider.ts`

Create a dedicated small provider for local replies.

Properties:

- smaller context than reviewer
- no repo inspection tools
- optional `update_project_memory` tool
- prompt built only from trigger + memory + optional review outcome

It should produce:

- reply body
- optional memory write intent or direct memory tool call result

### Review provider changes

#### `src/review/copilot-provider.ts`

Change the main reviewer so it no longer owns memory writes for conversational triggers.

Planned change:

- remove `update_project_memory` from the main reviewer path
- keep reviewer focused on findings and summary inputs

If a temporary compatibility phase is needed, gate reviewer memory writes behind a flag and plan to remove them after chatter is live.

### Prompt registry changes

#### `src/prompts/instruction-registry.ts`

Add dedicated prompt fragments and templates for chatter.

Suggested additions:

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

This avoids overloading the current review templates with two jobs.

#### `src/prompts/prompt-builders.ts`

Add a separate prompt builder for chatter, for example:

- `buildReplyPrompt(...)`

Keep it independent from `buildReviewPrompt(...)`.

Reviewer prompt building should remain review-focused.

### Review prompt changes

#### `prompts/review/summary-follow-up.md`

Change this file so it no longer pushes the reviewer to absorb all summary replies as broad guidance only.

New framing should say:

- keep review scope bounded
- do not use findings as a substitute for local conversation on non-thread triggers
- assume local human reply will be handled separately unless this is an existing bot-owned finding thread

#### `prompts/review/main.md`

Tighten reviewer scope:

- keep the "actionable findings only" rule
- add that non-thread conversational replies are handled outside the review artifact path

#### `prompts/review/review-author.md`

Adjust the opening contract so replies are only for prior bot-owned finding threads.

That keeps current thread behavior but stops the reviewer prompt from acting like the general conversation engine.

## Memory flow

### Ownership decision

Chatter owns memory writes.

### When memory is written

1. router says `memoryCandidate = true`
2. chatter receives the trigger comment and current memory snapshot
3. chatter either:
   - writes a durable memory entry
   - decides no durable memory should be written

### When review runs after memory

Default rule:

- if memory changed and a previous review exists, run incremental re-review so findings and summary can be refined using the new memory

This preserves the product idea that future-facing guidance often should affect the current review output too.

### When no review runs

If memory changed but there is no reason to review:

- persist memory
- reply locally confirming it
- do not pay for review

## Tests to plan for

- heuristic classification for pure review commands
- heuristic classification for question-only comments
- heuristic classification for memory-only comments
- memory-change-triggered re-review decision
- no-review path skips workspace hydration
- review-only path skips chatter
- review-plus-reply path runs both in the right order
- summary-follow-up reply target correctness
- standalone note reply target correctness
- reviewer prompt no longer implies general conversational output
- chatter prompt registration / prompt-builder coverage

## Final recommendation

Implement this as a bounded hybrid:

1. deterministic router first
2. chatter owns memory and local replies
3. reviewer runs only when needed
4. reviewer prompts become narrower, not broader
5. chatter prompts are added as a separate family in `src/prompts/instruction-registry.ts`

That gives you the UX improvement you want while minimizing tool usage, prompt size, and unnecessary review runs.
