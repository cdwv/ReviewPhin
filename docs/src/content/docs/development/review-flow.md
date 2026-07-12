---
title: Review flow
description: From webhook to published review.
---

ReviewPhin turns platform events into idempotent review work. The review worker uses three logical roles — Router, Reviewer, and Chatter — across the pipeline below.

```text
Platform event -> /webhooks/<platform> -> validate + classify
CLI request    -> mr review             -> resolve + construct trigger
  -> tenant resolution          map trigger to a configured tenant
  -> interaction job            deduplicated, persisted
  -> review worker              runner claims a leased job
  -> model harness              Reviewer (context-analyst -> review-author)
  -> finding reconciliation     Chatter: replies + memory
  -> platform publication       create/update/resolve/reply
```

## 1. Receive

The app captures raw request bodies for `/webhooks/*` and `/setup/*`, then asks the platform provider to parse the payload. The Router validates the platform signature and deduplicates concurrent jobs. No model calls happen here.

## 2. Resolve

The tenant registry maps the platform event to a configured tenant.

## Interaction jobs and the runner

Webhooks, provider-owned actions, and `mr review` write persisted interaction jobs; they never enqueue process-local work. The persisted queue is the source of truth. The CLI uses the configured platform connection to verify a selected comment and preserves that platform's normal trigger lifecycle.

A CLI text selector creates a local manual-review trigger instead of a synthetic comment. Its instruction is included in review scope and prompt context. It always requests review work, never requests a trigger-comment reply, and still publishes normal findings and a summary.

Each enabled runner process polls for work, while storage permits only one active review:

- It polls storage every `REVIEWPHIN_JOB_POLL_INTERVAL_MS` (default `2000`) and claims one job at a time.
- A claim holds a lease of `REVIEWPHIN_JOB_LEASE_MS` (default `120000`). The runner renews it on a heartbeat derived internally as one third of the lease.
- If a heartbeat cannot renew before the lease deadline, the claim context is aborted so another runner can recover the work.
- On startup and every poll, the runner first reconciles already-orphaned runs. Claiming then recovers expired job leases; any run orphaned by that recovery is reconciled on a later poll.
- Worker-failure retries preserve backoff across restarts: a retried job stays queued with a future `availableAt` (`RETRY_BACKOFF_MS` scaled by attempt), and the runner — not an in-memory timer — decides when it becomes eligible. Lease recovery requeues immediately while retries remain.
- Jobs that stay queued past `REVIEWPHIN_MAX_QUEUED_JOB_AGE_MS` (default `21600000`, 6 hours from the original enqueue time) are expired rather than run. A previously retried job can therefore expire after earlier attempts.
- `REVIEWPHIN_JOB_RUNNER_ENABLED=false` starts an HTTP-only replica that accepts webhooks but never claims jobs.

On shutdown, ReviewPhin first stops accepting and drains HTTP requests. It then stops the runner from taking new claims, keeps the active attempt's heartbeat alive until it settles, and finally closes storage. A second signal terminates the process and leaves the unfinished lease for another runner to recover.

Whether one review runs globally at a time depends on the storage claim mode — see [storage](../../deployment/storage/).

:::note[Architecture: project-memory fencing]
Project-memory consolidation writes are intentionally outside the v005 claim fencing. The session checks ownership before and after, but an in-flight memory write may still finish after lease loss. Review findings, run state, and job transitions are fenced; project memory is the one accepted exception.
:::

## 3. Classify

The worker decides whether the event should create review work, continue a conversation, update lifecycle state, or be ignored.

## 4. Review

The Reviewer runs as two sequential subagents inside one model session:

1. **context-analyst** — explores the hydrated workspace with `glob`, `ripgrep`, and file-read tools to gather context relevant to the changed files.
2. **review-author** — produces structured findings: severity, category, body, optional diff anchor, and optional inline suggestion.

It selects one of three modes from the trigger context:

- **first-pass-full** — first review of the code review, or an explicit full rescan.
- **incremental-rereview** — focused on files changed since the last review.
- **follow-up-discussion** — scoped to one existing discussion.

## 5. Publish

Chatter handles conversational replies and project memory decisions, using the profile's text-generation model to keep light interactions cheap. The publication adapter then creates, updates, resolves, reopens, or replies to bot-owned discussions and summaries. Retries recover bot-owned publications by stable markers instead of duplicating comments.

ReviewPhin calls the configured model API, the connected platform API, and any configured external storage provider such as Flotiq. SQLite keeps persisted review data on the ReviewPhin host; hosted adapters store it with that provider.
