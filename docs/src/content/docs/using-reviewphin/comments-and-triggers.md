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
<summary><strong>Full review (ignore prior context)</strong></summary>

```text
@reviewphin full review
```

Use a full review when you want ReviewPhin to ignore prior incremental context and rescan the code review more broadly. Also accepts `full rescan`, `fresh full review`, `full review from scratch`, and `rescan everything`.

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

## Platform notes

| Command | GitLab | GitHub |
| --- | --- | --- |
| `@reviewphin review this` | Native mention trigger | Compatibility trigger (no autocomplete) |
| `/reviewphin review` | — | Compatibility trigger (no autocomplete) |
| **Run Review** check run | — | Native trigger |
| Reply in bot discussion | Continues the finding | Continues the finding |
| `/reviewphin-profile <name>` | In MR description | In PR description |

GitHub's primary trigger is the **Run Review** check run action; comment commands are compatibility paths that GitHub does not autocomplete.
