# Interaction rename plan

## Goal

Rename review-centric persisted execution concepts to interaction-centric ones so the storage model cleanly covers both review-backed and chatter-only executions.

This plan is intentionally structural. It should not change routing, prompt behavior, memory ownership, or when LLM sessions run.

## Scope

Rename the following concepts across storage, runtime naming, logs, and tests:

- `review_job` -> `interaction_job`
- `review_run` -> `interaction_run`

Meaning:

- `interaction_job` = the scheduled system reaction to an inbound trigger such as a comment webhook
- `interaction_run` = the concrete execution record for that scheduled interaction

## Non-goals

- introducing the router / chatter / reviewer split
- changing current review orchestration behavior
- changing prompt contracts
- changing model-profile resolution behavior
- changing the current Copilot session construction shape beyond terminology updates required for consistency

## Migration strategy

Treat this as a bounded rename with compatibility-aware migration handling.

Planned approach:

1. rename storage types, repositories, and runtime naming to interaction-centric terms
2. add storage migration(s) for SQLite schema/table/index/foreign-key names as needed
3. keep migration code explicit and reversible enough to tolerate partially upgraded local databases
4. preserve current data semantics so existing queued work and historical runs remain readable after migration

If implementation proves that physical table renames are riskier than expected, allow a temporary compatibility phase where runtime types/API names move first while underlying table names remain in place behind the storage layer. The plan should still end with interaction-centric external names.

## Concrete code changes

### Storage and types

Update storage types and APIs to use interaction naming, including concepts such as:

- `ReviewJobRecord` -> `InteractionJobRecord`
- `ReviewRunRecord` -> `InteractionRunRecord`
- `CreateReviewJobInput` -> `CreateInteractionJobInput`
- `CreateReviewRunInput` -> `CreateInteractionRunInput`
- `ReviewRunMetricsRecord` -> `InteractionRunMetricsRecord`
- `UpsertReviewRunMetricsInput` -> `UpsertInteractionRunMetricsInput`

Update storage interface methods accordingly, for example:

- `createOrGetReviewJob(...)` -> `createOrGetInteractionJob(...)`
- `getReviewJobById(...)` -> `getInteractionJobById(...)`
- `createReviewRun(...)` -> `createInteractionRun(...)`
- `completeReviewRun(...)` -> `completeInteractionRun(...)`
- `failReviewRun(...)` -> `failInteractionRun(...)`
- `upsertReviewRunMetrics(...)` -> `upsertInteractionRunMetrics(...)`

### Worker and runtime naming

Update runtime naming so orchestration and logs no longer imply that every execution is a full review:

- job IDs, run IDs, and logger fields
- artifact naming where appropriate
- app log messages
- run-event messages

Keep current behavior unchanged; this plan is about naming and storage shape only.

### Persistence and logging semantics

Keep the same persistence model, but describe it in interaction terms:

- chatter-only executions and review-backed executions both use `interaction_job` / `interaction_run`
- logs should still capture `modelProfileName`, `selectionSource`, `reviewModel`, `textGenerationModel`, and provider metadata

### Tests

Update all existing tests to cover for new names. Do not introduce new tests as functionally existing tests should be enough.

## Acceptance criteria

- no behavioral change in current review flow
- all persisted execution concepts exposed by the codebase use interaction-centric names
- historical data remains readable after migration
- chatter-only executions can use the same persistence vocabulary without introducing a parallel storage concept

## Dependencies

This plan should land first. The later session-refactor and orchestration plans should build on the renamed interaction vocabulary instead of adding more review-centric names.
