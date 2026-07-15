---
title: Pull requests
description: GitHub pull request workflow.
---

GitHub pull request support is centered on a GitHub App and a **Run Review** check run. The check run is the native trigger; comment commands exist for compatibility.

:::note[Media placeholder — GitHub Run Review]
**Suggested clip (~25s):** open a pull request's ReviewPhin check run, click **Run Review**, and show the pending review with inline findings and the summary comment. A screenshot of the check run panel also works well here.
:::

## Native trigger: Run Review

Click **Run Review** on the ReviewPhin check run. GitHub sends a `check_run.requested_action` webhook, and ReviewPhin validates the app-owned check run before queuing work.

ReviewPhin creates a neutral check run when a pull request is opened, reopened, updated with a new head commit, or registered during tenant backfill. A check run created for an older head cannot start a review against the current pull request revision.

## Compatibility triggers

Pull request comments also accept:

```text
/reviewphin review
@reviewphin review
```

Mentions of the generated App slug are accepted too. These are compatibility triggers and do not appear in GitHub slash-command or mention autocomplete.

## Ask about an image

Attach an image to the comment that triggers ReviewPhin, or add one to the pull request description. ReviewPhin recognizes standard Markdown images such as `![screenshot](URL)` and HTML images such as `<img src="URL">`. It downloads only GitHub-hosted attachment URLs; links to other websites are not fetched.

Up to 10 referenced images and 25 MiB of image data are downloaded for one run. Each downloaded image also has a 10 MiB limit. Before sending an image, ReviewPhin checks the selected model's vision limits and resizes or re-encodes the image when necessary. If an image is unsupported, exceeds a download limit, cannot be processed within the model's limit, or cannot be downloaded, the run continues with the available text and images. The model is told which referenced images were unavailable so it does not claim to have inspected them.

A model must support image input to inspect attachments. When the selected model does not support images, ReviewPhin continues with text and tells the model that the images were omitted.

## Override the model for one pull request

Add a directive to the pull request **description**:

```text
/reviewphin-profile byok-gpt5.4
```

See [model profiles](../../management/model-profiles/) for how profiles are defined and resolved.

## How findings are published

New inline findings are submitted in a pending pull request review when GitHub can anchor them to new-side lines, using suggested-change blocks where eligible. Findings without a valid new-side anchor fall back to marked issue comments, because GitHub issue comments are not natively threaded. The updateable review summary is also an issue comment.

Replies inside a ReviewPhin-owned inline review thread continue that finding. For the shared command vocabulary, see [comments and triggers](../comments-and-triggers/).
