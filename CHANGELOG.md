# Reviewphin Changelog

Reviewphin uses [Happy Changelog](https://happy-changelog.github.io/happy-changelog-website/) for changelog automation. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

## v1.4.2 - 2026-07-15
### Security
- GitHub setup pages now reject unsafe link and image URL schemes.
- Repository automation now uses immutable dependencies and narrower
token permissions.

### Changed
- Container images now use Node 24 LTS and pnpm to install the included
Copilot CLI.

## v1.4.1 - 2026-07-15
### Added
- Contributors and security researchers now have structured public
templates and a private vulnerability-reporting path.

### Changed
- The README now explains configured-provider data flows, human review
responsibility, GitHub setup, CI status, and security guidance more
clearly.

### Fixed
- Docker Hub README generation now rejects descriptions that exceed the
platform's 25,000-character limit.

## v1.4.0 - 2026-07-15
### Added
- GitHub users can attach images to pull request comments and
descriptions for ReviewPhin to inspect with vision-capable models.

## v1.3.0 - 2026-07-14
### Added
- CLI commands can now return terminal-friendly, plain-text, or
structured JSON output through `--output`, with `--json` available as a
shortcut.

### Changed
- Pretty CLI output now uses clearer visual hierarchy, semantic status
styling, and grouped help.
- Watched reviews now use an aligned self-refreshing dashboard that
adapts to terminal width and wraps recent activity without truncating
it.

## v1.2.0 - 2026-07-13
### Added
- Administrators can authorize a GitHub maintainer for new or existing
GitHub connections through the setup flow or CLI.
- Administrators can check whether a GitHub connection is ready to
resolve review threads.

### Fixed
- ReviewPhin now closes resolved GitHub review conversations on the pull
request instead of updating only its internal review summary.

### Changed
- Existing GitHub Apps must add the ReviewPhin user authorization
callback URL and complete a one-time maintainer authorization after
upgrading.

## v1.1.0 - 2026-07-12
### Added
- Operators can submit merge request and pull request reviews from the
CLI without exposing a webhook.

## v1.0.1 - 2026-07-11
### Changed
- Repository security scans now use CodeQL Action 4.36.3.

## v1.0.0 - 2026-07-11
### Added
- Review jobs remain queued across worker restarts and automatically
recover after an interrupted attempt.
- Administrators can configure job polling, lease duration, maximum
queue age, and whether a process runs jobs.
- Model profiles can set reasoning effort separately for reviews and
text generation.

### Changed
- Custom storage adapters must implement the storage-v005 claim
operations, and administrators must stop all v004 ReviewPhin processes
before starting upgraded workers.
- Flotiq deployments may run only one job-runner process, while
additional replicas must disable their job runner.

## v0.13.3 - 2026-07-06
### Changed
- Make official page discoverable by bots

## v0.13.2 - 2026-07-05
### Changed
- Dependency, workflow action, and Docker base image versions were
refreshed from the open Dependabot updates.

### Fixed
- Compatibility issues with Zod 4, Vitest 4, stricter TypeScript test
typings, and Node 26 container builds were fixed.

## v0.13.1 - 2026-07-05
### Fixed
- explicitly tell posthog to capture pageview

## v0.13.0 - 2026-07-05
### Added
- Optional PostHog analytics can now be enabled on self-hosted instance

## v0.12.0 - 2026-07-04
### Changed
- Dockerhub readme will now have github badge instead of docker badge

## v0.11.0 - 2026-07-04
### Added
- Docs now have links to github and to changelog

## v0.10.4 - 2026-07-04
### Updated
- Add dockerhub readme as artifact

### Removed
- Old GitLab pipeline was removed from repo

## v0.10.3 - 2026-07-04
### Fixed
- Docs homepage will now correctly bump its version

## v0.10.2 - 2026-07-04
### Fixed
- Homepage radar will no longer cause horizontal scrollbar to appear from time to time
- Fix missing favicon.png for published docs

## v0.10.1 - 2026-07-04
### Fixed
- Fixed publication workflow

## v0.10.0 - 2026-07-04
### Added
- GitHub Actions workflows for CI, release publication, and security
scanning for the public GitHub repository.
- Maintainer documentation for the GitHub-based release publication
flow.

### Changed
- Docker Hub README generation now rewrites local assets and links for
the public site and is covered by automated tests.

### Fixed
- GitHub review threads are now correctly marked as resolvable based on
actual viewer permissions, fixing cases where resolvable threads
appeared locked.

## v0.9.1 - 2026-07-03
### Added
- Happy changelog workflow

## v0.9.0 - 2026-07-03
### Added
- Official documentation site now ships inside the ReviewPhin container and is served at `/docs`.
- Quickstart guides for GitLab and GitHub — step-by-step setup from zero to first review.
- Dedicated pages for configuring model profiles (Copilot CLI, OpenAI-compatible, Azure, Anthropic).
- Storage provider guides: SQLite (default), Flotiq, and writing a custom adapter.
- CLI command reference, organized by command group.
- Deployment guide covering the container image and docs serving.
- Architecture overview explaining how platform, model, and storage providers fit together.

### Changed
- All documentation links in README, CONTRIBUTING, and Docker Hub description now point to the new docs site.
- Legacy standalone Markdown docs (`docs/code-review-platform-providers.md`, `docs/model-providers.md`, `docs/storage-providers.md`) replaced by the structured docs site.

## v0.8.0 - 2026-06-28
### Added
- helm chart now supports httproute and ingress apis

## v0.7.2 - 2026-06-26
### Fixed
- Helm chart will no longer fail to instal with invalid container name

## v0.7.1 - 2026-06-26
### Changed
- Minor helm chart rename

## v0.7.0 - 2026-06-26
### Changed
- Package now correctly is called ReviewPhin instead of old test project name

## v0.6.2 - 2026-06-26
### Added
- Added secret detection to release pipeline

## v0.6.1 - 2026-06-21
### Added
- ReviewPhin developers now can preview how GitHub Platform looks like without adding new platform registration over and over again.

## v0.6.0 - 2026-06-21
### Added
- *GitHub platform support** — ReviewPhin can now be connected to GitHub repositories via an App Manifest registration flow; no manual credential wiring required.
- *GitHub App setup wizard** — A guided setup page walks through creating and installing a GitHub App for your organization or personal account, including webhook and redirect URL pre-population.
- *"Run Review" action on GitHub** — A neutral check run is created on every pull request, giving reviewers a one-click button to trigger a ReviewPhin review directly from the GitHub Checks tab.
- *GitHub comment commands** — Mention `@ReviewPhin` (or use `/reviewphin`) in a PR comment to trigger or direct a review from GitHub itself.
- *Project memory in database** — ReviewPhin can now read and write project-level memory to the dedicated table in database, which gives good fallback for platforms without the support (or where support is hard to implement like in GitHub).

### Changed
- Review publication interface unified across GitLab and GitHub
- `favicon.png` is now served as a static asset (used as the GitHub App icon URL hint on the setup page).

## v0.5.0 - 2026-06-06
### Breaking change
- Storage schema was bumped to `v002`

### Added
- Connections to GitLab are now saved under separate entity - `PlatformConnectionRecord`. Platform connection must be added before tenant is registered for given platform. Multiple tenants can use the same connection. For GitLab that means, that multiple tenants can be configured using one gitlab token.
- Platform connections can now be managed through CLI
- Support for `--help` argument in all cli commands/subcommands

### Changed
- Existing tenants connections params are grouped and auto-assigned to new connections during migration.
- CLI now filters help message down to matching commands only.

### Fixed
- Flotiq adapter relation filtering was changed from broken `includes` filter to `overlaps`. This must stay until `includes` filter is fixed.

## v0.4.0 - 2026-06-05
### Added:
- Platform provider dynamic loading
- Platform setup route handling

### Changed:
- Variable and storage properties unification

## v0.3.0 - 2026-05-27

### Changed

- Review worker can now use generic platform API in order to update data in GitLab
- Storage interfaces no longer mention GitLab-specific names in most of column/properties
- allow any platform config to be part of tenant configuration
- Generalize concept naming throughout the app (codeReview instead of mergeRequest etc)

## v0.2.0 - 2026-05-22

### Changed

- `--bot-user-id` and `--bot-username` are no longer required and will be fetched from GitLab's user api upon tenant registration

## v0.1.2 - 2026-05-19

### Added

- Inspiration & Motivation section is now added to the docs. It specifically gives thanks to the tools and teams behind them that inspired ReviewPhin

### Changed

- Make sure ReviewPhin is mentioned with consistent letter casing in docs
- Clarify Code Review Platforms state and possible future expansion in docs
- Docs now correctly describe OpenAI-compatible model providers as features of GitHub Copilot Harness

## v0.1.1 - 2026-05-18

### Fixed

- make sure .gitlab-ci.yml won't end up in docker image

## v0.1.0 - 2026-05-18

### Added

- Automated dockerhub publishing

## v0.0.1 - 2026-05-18

### Added

- Initial release version
- Versioning with Happy Changelog
