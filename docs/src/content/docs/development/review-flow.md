---
title: Review flow
description: From webhook to published review.
---

ReviewPhin turns platform events into idempotent review work. The review worker uses three logical roles — Router, Reviewer, and Chatter — across the pipeline below.

```text
Platform event
  -> /webhooks/<platform>      Router: parse + validate signature
  -> tenant resolution          map event to a configured tenant
  -> trigger classification     review? follow-up? lifecycle? ignore?
  -> interaction job            deduplicated, enqueued
  -> review worker
  -> model harness              Reviewer (context-analyst -> review-author)
  -> finding reconciliation     Chatter: replies + memory
  -> platform publication       create/update/resolve/reply
```

## 1. Receive

The app captures raw request bodies for `/webhooks/*` and `/setup/*`, then asks the platform provider to parse the payload. The Router validates the platform signature and deduplicates concurrent jobs. No model calls happen here.

## 2. Resolve

The tenant registry maps the platform event to a configured tenant.

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

All code and data stay on your infrastructure. The worker calls only the configured model API and the connected platform API.
