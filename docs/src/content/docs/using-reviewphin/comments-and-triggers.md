---
title: Comments and triggers
description: Manual comments, reruns, follow-ups, and model selection.
---

ReviewPhin accepts manual triggers from supported code review platforms. This page is the shared command vocabulary; the platform pages cover platform-specific behavior for [merge requests](../merge-requests/) and [pull requests](../pull-requests/).

## Trigger cheat sheet

Expand the action you want. Each block is a plain HTML disclosure, so it works without JavaScript.

<details>
<summary><strong>Review now</strong></summary>

```text
@reviewphin review this
```

Use an `@bot` mention on GitLab merge requests. GitHub pull request comments also accept the compatibility command `/reviewphin review`.

</details>

<details>
<summary><strong>Full review (reassess all changes)</strong></summary>

```text
@reviewphin full review
```

Use a full review when you want ReviewPhin to reassess all changed files. Existing findings remain available so the new pass can update them without creating duplicates. The routing model interprets your intent: phrases such as `review everything afresh` work too. Mentioning or quoting “full review” does not by itself request one.

</details>

<details>
<summary><strong>Follow up on a finding</strong></summary>

Reply inside a ReviewPhin-owned discussion to continue that finding. The worker uses the discussion context instead of requiring another top-level trigger.

```text
Can you suggest a more readable variable name here?
```

</details>

<details>
<summary><strong>Teach a convention</strong></summary>

```text
@reviewphin for future reference, prefer functional React components over class components
```

Also accepts `remember`, `please remember`, `going forward`, `in the future`, `team policy`, `stable preference`, `always prefer`, and `please prefer`. Stored in project memory and applied to future reviews.

</details>

<details>
<summary><strong>Pin a model for one review</strong></summary>

Add this to the code review **description**, not a comment:

```text
/reviewphin-profile byok-gpt5.4
```

Selects a named [model profile](../../management/model-profiles/) for every run on that review.

</details>

## Several comments in a row

ReviewPhin collects comment requests for the same tenant and pull or merge request before starting work. The default quiet period is 15 seconds after the latest comment, with a maximum wait of 60 seconds. A batch also closes at 32 requests or 256 KiB of trigger and payload data. An oversized individual request is retained and processed separately. Duplicate webhook deliveries do not extend the wait.

The collected requests share one branch checkout and at most one reviewer session per attempt. Chatter and memory work can use the same checkout. ReviewPhin checks the current branch head when the batch starts and again before publication. Comments arriving after a batch closes form a later batch. CLI requests and GitHub's **Run Review** action remain separate jobs.

Questions in different comment targets receive separate answers. Several questions in one discussion can share an answer that covers each request. ReviewPhin checks answer coverage before publishing replies. If one answer fails to publish, the job retries from saved output and skips replies already published. A new branch head after partial publication cancels that batch; submit a fresh request for the new revision.

A [routing model](../../management/model-profiles/#routing-collected-requests) decides whether a batch needs review, replies, memory work, or a combination. If no router override is configured, it uses the chatter model and reasoning. ReviewPhin reviews existing changes and answers questions; it does not edit code or create pull requests.

## See when ReviewPhin is working

When ReviewPhin accepts a comment, it tries to add a reaction to that comment. The reaction gives you quick visual feedback while the review runs.

| Status           | GitLab        | GitHub         |
| ---------------- | ------------- | -------------- |
| Looking at it    | 👀 Eyes       | 👀 Eyes        |
| Finished         | ✅ Check mark | 🎉 Celebration |
| Could not finish | 😖 Confounded | 😕 Confused    |

The eyes reaction stays when ReviewPhin adds the final reaction. "Could not finish" also covers reviews that were cancelled or expired.

Reactions are best-effort feedback. A reaction may be missing if the comment was deleted, permissions changed, or the platform rejected it. ReviewPhin may still process the review.

This feedback applies only when there is a platform comment to react to. GitHub's **Run Review** action uses the check run status instead. A local trigger written as plain text also has no comment reaction.

## Platform notes

| Command                      | GitLab                 | GitHub                                  |
| ---------------------------- | ---------------------- | --------------------------------------- |
| `@reviewphin review this`    | Native mention trigger | Compatibility trigger (no autocomplete) |
| `/reviewphin review`         | —                      | Compatibility trigger (no autocomplete) |
| **Run Review** check run     | —                      | Native trigger                          |
| Reply in bot discussion      | Continues the finding  | Continues the finding                   |
| `/reviewphin-profile <name>` | In MR description      | In PR description                       |

GitHub's primary trigger is the **Run Review** check run action; comment commands are compatibility paths that GitHub does not autocomplete.

Triggers can also include image attachments. See the GitLab [merge request image workflow](../merge-requests/#ask-about-an-image) or the GitHub [pull request image workflow](../pull-requests/#ask-about-an-image) for supported formats, download limits, and failure behavior.
