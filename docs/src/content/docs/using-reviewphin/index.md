---
title: Using ReviewPhin
description: How ReviewPhin fits into merge request and pull request work.
---

This area is for developers who interact with ReviewPhin from a merge request or pull request. It covers how to trigger reviews, hold follow-up conversations, and teach the bot durable conventions. Setting up connections and tenants lives in [Management](../management/); running the worker lives in [Deployment](../deployment/).

## What happens when you trigger a review

1. You open or update a merge request or pull request.
2. You (or a platform action) trigger ReviewPhin.
3. ReviewPhin hydrates the repository and review context.
4. The review worker runs the selected model profile.
5. Findings, summaries, replies, and status updates are reconciled back to the code review.

```text
you comment  ->  ReviewPhin hydrates the review  ->  model runs  ->  findings + summary posted back
```

## General rules

These hold across GitLab and GitHub.

- **First run is a full review.** The first pass over a code review covers all changed files. Later passes are incremental and focus on what changed since the last run.
- **Replies continue the thread.** Replying inside a ReviewPhin-owned discussion continues that finding without a new top-level trigger.
- **You can force a fresh pass.** A full review ignores prior incremental context and rescans more broadly.
- **You can pin a model per review.** A `/reviewphin-profile <name>` directive in the code review description selects a named [model profile](../management/model-profiles/) for every run on that review.

## Pick your platform

- [Merge requests](merge-requests/) — GitLab, the primary workflow.
- [Pull requests](pull-requests/) — GitHub, using the **Run Review** check run.
- [Comments and triggers](comments-and-triggers/) — the shared command vocabulary.

## Follow-up conversations

When someone replies inside a ReviewPhin-owned discussion, the worker treats that reply as context for the next response. Use it for clarification, small corrections, or asking for a narrower re-check.

## Project memory

Project memory stores durable conventions learned from review conversations. Where it is stored depends on the platform, and operators configure that behavior — see [platform connections](../management/platform-connections/#project-memory). As a developer, you only need to know that teaching a convention makes it stick for future reviews.
