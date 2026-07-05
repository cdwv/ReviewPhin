---
title: Release publication
description: Public release workflow and repository settings for maintainers.
---

ReviewPhin publishes public releases through GitHub Actions after Happy Changelog updates the version and creates the release tag. Happy Changelog remains responsible for changelog and version changes; the release workflow publishes the website, Docker image, Helm chart, and Docker Hub README.

## Workflow shape

Pull requests run `Quality Gates` and `Validate PR Changelog`. `Quality Gates` exposes the `test`, `CodeQL`, and `Dependency Review` checks on public pull requests; `Validate PR Changelog` calls the Happy Changelog reusable validation job.

Pushes to `main` run `Update Changelog`. That workflow calls the reusable `Quality Gates` workflow as `quality-gates`, then runs the Happy Changelog `update` job only after those gates pass. On `main`, dependency review stays disabled because it is a pull-request-only check.

`Scheduled Security` runs weekly and from `workflow_dispatch`. It calls `Quality Gates` as `security-analysis` with tests and dependency review disabled, and keeps CodeQL and OpenSSF Scorecard coverage on a schedule.

Release tags matching `v*` run `Release`:

1. `verify` runs lint, typecheck, application build, docs build, and coverage.
2. `publish-helm-chart` lints and packages `.chart/`, uploads the packaged chart as a workflow artifact, and pushes the OCI chart to `ghcr.io/<owner>/charts/reviewphin`.
3. `publish-docs` builds the static homepage and docs for `https://reviewphin.com`, writes `CNAME`, and deploys with GitHub Pages.
4. `build-and-smoke-test-image` builds a local amd64 image, checks `/healthz`, and verifies the image-provided `reviewphin` CLI.
5. `publish-docker` publishes `cdwv/reviewphin` to Docker Hub with the release tag, safe semver aliases, and `latest` for stable `x.y.z` releases.
6. `update-dockerhub-readme` generates `DOCKERHUB_README.md` and pushes it to Docker Hub.

## Required repository settings

Configure these before the first public release:

- Enable GitHub Pages and set the source to GitHub Actions.
- Configure DNS and the Pages custom domain for `reviewphin.com`.
- Add `REVIEWPHIN_POSTHOG_KEY` as a GitHub repository or Pages environment variable for the public site. Add `REVIEWPHIN_POSTHOG_HOST` only when the project does not use the default US Cloud host.
- Add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets with write access to `cdwv/reviewphin`.
- Allow the release workflow to publish GitHub Packages with `GITHUB_TOKEN`; the chart job requests `packages: write` and publishes to GHCR.
- Enable GitHub native secret scanning when available.
- Run a one-time full-history secret scan from a maintainer machine before public launch.
- Configure branch protection or repository rules for `main` after the first pull request run creates check names.

Require these checks for protected pull requests:

- `test`
- `CodeQL`
- `Dependency Review`
- `Validate PR Changelog / validate`

Do not require `security-analysis / ...` checks from `Scheduled Security` or `quality-gates / ...` checks from `Update Changelog` for pull request branch protection. Those workflows run outside the pull request path.

Require branches to be up to date before merging if maintainers want merge commits tested against the current `main`.

## Tag trigger requirement

GitHub does not trigger downstream workflows from tags created with the default `GITHUB_TOKEN`. Configure Happy Changelog to create tags with a maintainer PAT or GitHub App token, or dispatch `Release` explicitly after the gated Happy Changelog update job completes.

The tag or dispatch step must stay downstream of the Happy Changelog `update` job. Branch protection alone is not enough because the update workflow runs after a push to `main`.

## Security automation

Pull request security gates live in `Quality Gates`: `CodeQL` runs on public pull requests, and `Dependency Review` blocks moderate-or-higher dependency findings there. `Scheduled Security` provides scheduled and manually triggered CodeQL and OpenSSF Scorecard coverage outside the pull request path.

CodeQL, dependency review, and Scorecard availability depends on repository visibility and GitHub Advanced Security. The committed workflows run those checks automatically for public repositories; private repositories with GitHub Advanced Security can remove the visibility guards.

Before public launch, run a full-history secret scan from a maintainer machine or a trusted workflow and rotate any exposed credentials before publishing history.
