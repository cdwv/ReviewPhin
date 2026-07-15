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

## Ask about an image

Attach an image to the comment that triggers ReviewPhin, or add one to the merge request description. ReviewPhin recognizes standard Markdown images such as `![screenshot](URL)` and HTML images such as `<img src="URL">`. It downloads only images hosted by the configured GitLab instance; links to other websites are not fetched.

Up to 10 referenced images and 25 MiB of image data are included in one run. Each image also has a 10 MiB limit. A failed or omitted image does not stop the run: ReviewPhin continues with the available text and images, and limit omissions are reported as unavailable.

A model must support image input to inspect attachments. When the selected model does not support images, ReviewPhin continues with text and tells the model that the images were omitted.

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
