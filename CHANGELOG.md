# Reviewphin Changelog

Reviewphin uses [Happy Changelog](https://happy-changelog.github.io/happy-changelog-website/) for changelog automation. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)


## v0.2.0 - 2026-05-22
### Changed
* `--bot-user-id` and `--bot-username` are no longer required and will be fetched from GitLab's user api upon tenant registration

## v0.1.2 - 2026-05-19
### Added
* Inspiration & Motivation section is now added to the docs. It specifically gives thanks to the tools and teams behind them that inspired ReviewPhin

### Changed
* Make sure ReviewPhin is mentioned with consistent letter casing in docs
* Clarify Code Review Platforms state and possible future expansion in docs
* Docs now correctly describe OpenAI-compatible model providers as features of GitHub Copilot Harness

## v0.1.1 - 2026-05-18
### Fixed
* make sure .gitlab-ci.yml won't end up in docker image

## v0.1.0 - 2026-05-18
### Added
* Automated dockerhub publishing

## v0.0.1 - 2026-05-18
### Added
* Initial release version
* Versioning with Happy Changelog
