---
title: Release publication
description: Public release workflow and repository settings for maintainers.
---

ReviewPhin publishes public releases through GitHub Actions after Happy Changelog updates the version and creates the release tag. Happy Changelog remains responsible for changelog and version changes; the release workflow publishes the website, Docker image, and Docker Hub README.

## Workflow shape

Pull requests and pushes to `main` run the public `test` and `security` jobs from `CI`. The Happy Changelog update workflow repeats those same gates on `main`, then runs the version update only after both jobs pass in the same workflow.

Release tags matching `v*` run `Release`:

1. `verify` runs lint, typecheck, application build, docs build, and coverage.
2. `publish-docs` builds the static homepage and docs for `https://reviewphin.com`, writes `CNAME`, and deploys with GitHub Pages.
3. `build-and-smoke-test-image` builds a local amd64 image, checks `/healthz`, and verifies the image-provided `reviewphin` CLI.
4. `publish-docker` publishes `cdwv/reviewphin` to Docker Hub with the release tag, safe semver aliases, and `latest`.
5. `update-dockerhub-readme` generates `DOCKERHUB_README.md` and pushes it to Docker Hub.

## Required repository settings

Configure these before the first public release:

- Enable GitHub Pages and set the source to GitHub Actions.
- Configure DNS and the Pages custom domain for `reviewphin.com`.
- Add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets with write access to `cdwv/reviewphin`.
- Enable GitHub native secret scanning when available.
- Run a one-time full-history secret scan from a maintainer machine before public launch.
- Configure branch protection or repository rules for `main` after the first CI run creates check names.

Require these checks for protected pull requests:

- `test`
- `security`
- `Validate PR Changelog`

Require branches to be up to date before merging if maintainers want merge commits tested against the current `main`.

## Tag trigger requirement

GitHub does not trigger downstream workflows from tags created with the default `GITHUB_TOKEN`. Configure Happy Changelog to create tags with a maintainer PAT or GitHub App token, or dispatch `Release` explicitly after the gated Happy Changelog update job completes.

The tag or dispatch step must stay downstream of the Happy Changelog `update` job. Branch protection alone is not enough because the update workflow runs after a push to `main`.

## Security automation

The blocking `security` job runs dependency review on public pull requests. The separate `Security` workflow adds CodeQL, dependency review, and OpenSSF Scorecard coverage.

CodeQL, dependency review, and Scorecard availability depends on repository visibility and GitHub Advanced Security. The committed workflows run those checks automatically for public repositories; private repositories with GitHub Advanced Security can remove the visibility guards.

Before public launch, run a full-history secret scan from a maintainer machine or a trusted workflow and rotate any exposed credentials before publishing history.
