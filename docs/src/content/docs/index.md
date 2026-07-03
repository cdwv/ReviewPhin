---
title: ReviewPhin documentation
description: Self-hosted agentic review for GitLab merge requests and GitHub pull requests.
---

ReviewPhin is a self-hosted worker that reviews merge requests or pull requests and publishes results back to the code review platform. You deploy it once, connect a project, and trigger reviews from the places your team already works.

The docs are split into four areas. Pick the one that matches what you are trying to do.

## The four areas

| Area | For | Start here |
| --- | --- | --- |
| **Using ReviewPhin** | Developers who comment on and read reviews | [Using ReviewPhin](using-reviewphin/) |
| **Management** | Operators who register connections, tenants, and model profiles | [Management](management/) |
| **Deployment & instance management** | Operators who run and expose the worker | [Deployment](deployment/) |
| **Development** | Contributors and provider authors | [Development](development/) |

## First run, end to end

New here? Follow this path once. Each step links to its canonical page, so nothing is repeated.

1. **Deploy the worker.** Run it [locally](deployment/run-locally/), with [Docker](deployment/docker/), or on [Kubernetes](deployment/kubernetes/).
2. **Expose it publicly.** Give the platform an HTTPS URL with a [tunnel or ingress](deployment/exposing-webhooks/) and set `PUBLIC_URL`.
3. **Add a platform connection.** Store reusable [GitLab or GitHub credentials](management/platform-connections/).
4. **Add a tenant.** Attach one [project or repository](management/tenants/) to that connection.
5. **Trigger the first review.** Comment on a [merge request or pull request](using-reviewphin/).

:::note[Media placeholder — end-to-end setup walkthrough]
**Suggested clip (~90s):** deploy with Docker Compose, open a tunnel, run `platform connection add` and `tenant add`, then trigger a first review on a real merge request. This is the highest-value recording for the whole site.
:::

## What ReviewPhin operates

ReviewPhin stores reusable platform credentials as a **platform connection**. A **tenant** attaches one project or repository to a connection. Review jobs are created from webhooks or manual triggers and processed by the review worker.

GitLab is the primary setup path today. GitHub is supported through a GitHub App registration flow. Custom platform and storage providers can be loaded at runtime.
