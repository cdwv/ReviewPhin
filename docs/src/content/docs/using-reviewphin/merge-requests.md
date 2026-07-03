---
title: Merge requests
description: GitLab merge request workflow.
---

GitLab merge requests are the primary ReviewPhin workflow. You drive everything from merge request comments and the merge request description.

:::note[Media placeholder — GitLab review in action]
**Suggested clip (~30s):** post `@reviewphin review this` on a merge request, then show the bot-owned discussions and summary comment appearing. Add a short caption pointing at the summary at the top of the discussion list.
:::

## Trigger a review

Comment on the merge request, mentioning the bot:

```text
@reviewphin review this
```

Use the bot username discovered from the GitLab access token. The first run is a full review of all changed files; later runs are incremental.

## Force a full re-scan

To ignore prior incremental context and rescan more broadly:

```text
@reviewphin full review
```

Other accepted phrasings: `full rescan`, `fresh full review`, `full review from scratch`, `rescan everything`.

## Override the model for one merge request

Add a directive to the merge request **description** (not a comment):

```text
/reviewphin-profile byok-gpt5.4
```

That named profile wins over the tenant profile, the database default, and the Copilot CLI fallback for every run on this merge request. See [model profiles](../../management/model-profiles/) for how profiles are defined and resolved.

## Teach a convention

```text
@reviewphin for future reference, prefer functional React components over class components
```

Other triggers include `remember`, `please remember`, `going forward`, `in the future`, `team policy`, `stable preference`, `always prefer`, and `please prefer`. The convention is stored in project memory and applied to future reviews.

## Where reviews arrive

Findings post as bot-owned discussions, one per finding, plus a single summary comment at the top of the discussion list. Replying inside any bot-owned discussion continues that finding. For the shared command list across platforms, see [comments and triggers](../comments-and-triggers/).

:::tip
The webhook that delivers your comment to ReviewPhin is configured once by an operator. If reviews never start, the project webhook or its secret is the first thing to check — see [tenants](../../management/tenants/#gitlab) and [exposing webhooks](../../deployment/exposing-webhooks/).
:::
