---
title: Review flow
description: From webhook to published review.
---

ReviewPhin turns platform events into idempotent review work. The review worker uses three logical roles — Router, Reviewer, and Chatter — across the pipeline below.

```text
Platform event -> /webhooks/<platform> -> validate + classify
CLI request    -> mr review             -> resolve + construct trigger
  -> tenant resolution          map trigger to a configured tenant
  -> collected comment batch    deduplicated, persisted; manual actions stay separate
  -> job runner                 claim the job before preparing its workspace
  -> shared checkout            current head, after collection
  -> request router             model classification; inherits chatter settings when unset
  -> memory phase               once, then refresh memory without another checkout
  -> model harness              Reviewer (context-analyst -> review-author)
  -> finding reconciliation     apply the review result
  -> chatter                    answer each requested question
  -> platform publication       publishing reviews: create/update/resolve/reply
                                local tests: skipped
```

## 1. Receive

The app captures raw request bodies for `/webhooks/*` and `/setup/*`, then asks the platform provider to parse the payload. The platform adapter validates the signature and classifies the trigger. Storage deduplicates provider events and collects comment requests. No model calls happen in webhook admission.

## 2. Resolve

The tenant registry maps the platform event to a configured tenant.

## Interaction jobs and the runner

Webhooks, provider-owned actions, and `mr review` write persisted interaction jobs; they never enqueue process-local work. The persisted queue is the source of truth. The CLI uses the configured platform connection to verify a selected comment. Publishing reviews preserve that platform's normal trigger lifecycle; local tests submitted with `--no-publish` or `--no-comment` deliberately skip lifecycle synchronization and all other platform mutations. See the [`mr review` CLI reference](../../management/cli-reference/#mr-review) for local-test output and storage behavior.

A CLI text selector creates a local manual-review trigger instead of a synthetic comment. Its instruction is included in review scope and prompt context. It always requests review work and never requests a trigger-comment reply. By default, it publishes normal findings and a summary; in no-publish mode, it stores the completed result without publishing either.

Each enabled runner process polls for work, while storage permits only one active review:

- It polls storage every `REVIEWPHIN_JOB_POLL_INTERVAL_MS` (default `2000`) and claims one job at a time.
- A claim holds a lease of `REVIEWPHIN_JOB_LEASE_MS` (default `120000`). The runner renews it on a heartbeat derived internally as one third of the lease.
- If a heartbeat cannot renew before the lease deadline, the claim context is aborted so another runner can recover the work.
- On startup and every poll, the runner first reconciles already-orphaned runs. Claiming then recovers expired job leases; any run orphaned by that recovery is reconciled on a later poll.
- Worker-failure retries preserve backoff across restarts: a retried job stays queued with a future `availableAt` (`RETRY_BACKOFF_MS` scaled by attempt), and the runner — not an in-memory timer — decides when it becomes eligible. Lease recovery requeues immediately while retries remain.
- Jobs that stay queued past `REVIEWPHIN_MAX_QUEUED_JOB_AGE_MS` (default `21600000`, 6 hours from the original enqueue time) are expired rather than run. A previously retried job can therefore expire after earlier attempts.
- `REVIEWPHIN_JOB_RUNNER_ENABLED=false` starts a copy that accepts webhooks but never executes jobs. Extra copies accepting comment webhooks require storage that coordinates writes between copies, such as SQLite; the Flotiq adapter requires one copy for both receiving comments and executing jobs.

On shutdown, ReviewPhin first stops accepting and drains HTTP requests. It then stops the runner from taking new claims, keeps the active attempt's heartbeat alive until it settles, and finally closes storage. A second signal terminates the process and leaves the unfinished lease for another runner to recover.

Whether one review runs globally at a time depends on the storage claim mode — see [storage](../../deployment/storage/).

:::note[Architecture: project-memory fencing]
Project-memory consolidation writes are intentionally outside the v005 claim fencing. The session checks ownership before and after, but an in-flight memory write may still finish after lease loss. Review findings, run state, and job transitions are fenced; project memory is the one accepted exception.
:::

## 3. Classify

For comments, the routing model decides whether to review, update memory, reply, combine these actions, or do nothing. It receives the ordered requests, whether a previous review exists, prior finding statuses, relevant discussion excerpts, and whether memory is enabled. It returns one decision per request: `{ requestId, review: "none" | "incremental" | "full", memory, reply, reason }`.

The router handles later corrections and cancellations before the worker combines decisions. Any remaining full-review request makes the shared review full; otherwise an incremental request makes it incremental. Questions and memory updates keep their own flags. A plain review request does not need a separate conversational reply because the review publishes its own result.

Unset router settings inherit the chatter model and reasoning. A failed router can be replaced by the chatter model; if model classification still fails, the job retries without guessing actions. Explicit manual-review commands already specify the action and go straight to review, using an incremental scope when a previous review exists.

## 4. Review

The Reviewer runs as two sequential subagents inside one model session:

1. **context-analyst** — explores the hydrated workspace with `glob`, `ripgrep`, file reads, and trusted read-only Git inspection to gather context relevant to the changed files.
2. **review-author** — produces structured findings: severity, category, body, optional diff anchor, and optional inline suggestion.

### Structured-output recovery

Review results, Chatter replies, and project-memory consolidation all request structured JSON from the model harness. The harness parses each response and validates it against the shape requested by the caller.

When a response contains malformed JSON or does not match that shape, ReviewPhin keeps the same model session open and asks the model to correct its previous response. It sends at most two correction messages after the original response, and every corrected candidate passes through the same parsing and validation checks. The first valid candidate is returned to the caller.

This bounded recovery is separate from a whole-job retry: it does not rebuild the prompt or reload the workspace. One harness session can therefore contain up to three structured-response attempts for one requested result, and the correction turns can add assistant calls to the session. Session metrics include all underlying model calls, and the run log records each candidate's attempt number, validation failure, duration, and model usage.

If the second correction is still invalid, the harness raises one terminal structured-output error with the last parsing or validation detail. Review and reply callers then follow their existing failure handling, including the worker's normal job-retry policy where applicable.

For Git-ready workspaces, ReviewPhin prepares the platform's exact comparison base and review head with their commit ancestry, derives the complete changed-file manifest from those trusted Git refs, checks out the head in detached mode, and removes the remote and authentication data before the model session starts. The starting prompt contains the complete changed-file manifest; the Reviewer uses `git_readonly` to inspect focused diffs, history, and blame against the fixed `reviewphin/base` and `reviewphin/head` revisions.

If trusted Git preparation fails, ReviewPhin uses the complete platform diff only when that fallback is available and fits the prompt budget. Otherwise the review fails clearly instead of publishing a silently partial result.

The worker passes the selected scope through the platform adapter into review-context preparation. The code upgrades an incremental request to full when no previous review exists, or when stored change signatures cannot be compared with the current format. The resulting modes are:

- **first-pass-full** — first review of the code review, or an explicit full rescan.
- **incremental-rereview** — prioritizes changed files and referenced findings while retaining the complete current change boundary and prior finding state.

Discussion references tell the Reviewer which concerns to reassess; they are not a separate review type. Every requested discussion remains available, including resolved threads. The full ordered batch remains in review context, and the reply task identifies each request that needs an answer.

The worker saves routing and completed model output in a claim-scoped batch checkpoint, so publication retries can resume without another model call. Checkpoint version 2 stores the review scope. Version 1 checkpoints are upgraded when read: `false` becomes `none`, and `true` becomes `full` because the old record did not retain scope intent. Completed model results and publication progress are preserved. This payload upgrade applies to both storage adapters and does not change the storage contract or database columns.

## 5. Publish

Chatter handles conversational replies and project memory decisions, using the profile's text-generation model to keep light interactions cheap. For publishing reviews, the publication adapter then creates, updates, resolves, reopens, or replies to bot-owned discussions and summaries. Retries recover bot-owned publications by stable markers instead of duplicating comments. Local tests still run the review and store its result, but they bypass the publication adapter and platform-backed memory writes.

ReviewPhin calls the configured model API, the connected platform API, and any configured external storage provider such as Flotiq. SQLite keeps persisted review data on the ReviewPhin host; hosted adapters store it with that provider.
