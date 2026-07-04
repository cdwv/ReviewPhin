# ReviewPhin publication workflow plan

## Problem and approach

ReviewPhin needs GitHub-native publication workflows for the public release path while leaving Happy Changelog responsible for changelog and version updates. The release path should publish the static homepage and docs to `https://reviewphin.com`, publish the Docker image as `cdwv/reviewphin`, and keep Docker Hub's README aligned with the published docs.

The safest approach is to add normal pull request/main CI for contributor feedback, then use a single ordered release workflow for tag publication. A single release workflow avoids impossible cross-workflow `needs` dependencies and makes the tag path explicit: test first, then publish docs, then publish/push the Docker image, then update Docker Hub metadata.

## Required dependency gates

Two dependencies are mandatory:

1. Happy Changelog tag creation on `main` must happen only after the default-branch `test` and `security` gates pass.
2. Pull requests must be mergeable only after the same `test` and `security` gates pass.

GitHub Actions cannot make a job in one workflow depend on jobs from another workflow with `needs`. To enforce the first dependency, the Happy Changelog update workflow must include the prerequisite jobs directly, or call reusable workflows as jobs, and then run the Happy Changelog job with `needs: [test, security]`.

The required shape for `.github/workflows/update-changelog.yml` is:

- Trigger: `push` to `main`.
- Job `test`: run the full test gate.
- Job `security`: run the default-branch security gate.
- Job `update`: call `happy-changelog/happy-changelog-workflow/.github/workflows/update-changelog.yml@v1.6.1` with `needs: [test, security]`.

This means tag creation cannot start until both gates pass for the merged commit on `main`.

The required shape for pull requests is:

- Trigger: `pull_request`.
- Job `test`: run the same test gate.
- Job `security`: run the PR-safe security gate.
- Branch protection on `main`: require `test`, `security`, and `Validate PR Changelog`.

Branch protection is what enforces PR merge blocking. The workflow files only create check runs; repository settings must require them.

## Implementation phases

### Phase 1: Canonical public URL and generated README behavior

Goal: make every generated artifact point at `https://reviewphin.com` before publication automation is added.

Files to update:

- `docs/astro.config.mjs`
  - Change the default `REVIEWPHIN_DOCS_SITE` from `https://reviewphin.com` to `https://reviewphin.com`.
  - Keep `REVIEWPHIN_DOCS_BASE` defaulting to `/` for root-domain GitHub Pages.

- `README.md`
  - Replace public docs links that currently point to `https://reviewphin.com` with `https://reviewphin.com`.
  - Keep Docker Hub badge pointing at `https://hub.docker.com/r/cdwv/reviewphin`.

- `scripts/build-docker-readme.cjs`
  - Continue converting relative repository links for Docker Hub.
  - Add explicit rewriting of old docs hosts to `https://reviewphin.com`.
  - Use `PUBLIC_REPO_URL_PREFIX` as an absolute GitHub blob URL during release, not `./`.

Validation:

- Run the Docker Hub README generator locally.
- Check `DOCKERHUB_README.md` contains `https://reviewphin.com` docs links and no `https://reviewphin.com` links.
- Remove the generated `DOCKERHUB_README.md` unless it becomes an intentional artifact.

### Phase 2: Contributor CI

Goal: create public GitHub status checks equivalent to the useful parts of the existing GitLab `test` job.

File to add:

- `.github/workflows/ci.yml`

Triggers:

- `pull_request`
- `push` to `main`

Jobs:

- `test`
  - Checkout.
  - Set up Node 22.
  - Enable Corepack and pnpm.
  - Install with `pnpm install --frozen-lockfile`.
  - Run `pnpm lint`.
  - Run `pnpm typecheck`.
  - Run `pnpm build`.
  - Run `pnpm docs:build` with:
    - `REVIEWPHIN_BUILD_HOMEPAGE=true`
    - `REVIEWPHIN_DOCS_SITE=https://reviewphin.com`
    - `REVIEWPHIN_DOCS_BASE=/`
  - Run `pnpm test --coverage`.
  - Upload coverage artifacts.

- `security`
  - Run PR-safe security checks that are stable enough to block merges.
  - Include gitleaks.
  - Include dependency review on pull requests.
  - Include CodeQL if repository visibility and GitHub Advanced Security support it.
  - Skip or separate checks that are only meaningful on `main` or on a schedule, such as OpenSSF Scorecard.

Branch protection recommendation:

- Require `test`.
- Require `security`.
- Require `Validate PR Changelog` from Happy Changelog.

This is the merge gate for pull requests. A PR cannot merge unless the `test` and `security` checks pass.

### Phase 2b: Gated Happy Changelog update

Goal: ensure version updates and tag creation happen only after `test` and `security` pass on `main`.

File to update:

- `.github/workflows/update-changelog.yml`

Required structure:

- Keep the existing `push` to `main` trigger.
- Add a `test` job that runs the same commands as the PR test gate.
- Add a `security` job that runs the default-branch security gate.
- Change the existing Happy Changelog `update` job so it has:
  - `needs: [test, security]`
  - the existing `uses: happy-changelog/happy-changelog-workflow/.github/workflows/update-changelog.yml@v1.6.1`
  - the existing changelog inputs.

Default-branch `security` gate:

- Run gitleaks.
- Run CodeQL if supported.
- Run any other security checks that should block release tagging.
- Do not rely on dependency review on `push` to `main`; it is primarily a pull request check.

Design note:

- To avoid duplicating long shell steps, extract common setup/test/security command sequences into local composite actions or reusable workflows if the YAML becomes noisy. The important requirement is that the Happy Changelog `update` job has same-workflow `needs` on `test` and `security`.

### Phase 3: Ordered release workflow

Goal: publish docs and Docker image from one ordered tag workflow so failed verification blocks all release outputs.

File to add:

- `.github/workflows/release.yml`

Triggers:

- `push` tags matching `v*`
- `workflow_dispatch`

Tag trigger decision:

- Recommended path: configure Happy Changelog to create tags with a maintainer PAT or GitHub App token so `push: tags` workflows run normally.
- Fallback path: add an explicit dispatch step to the changelog workflow after version/tag creation.
- Avoid relying on tags created with `GITHUB_TOKEN`, because GitHub suppresses downstream workflow triggers for those events.
- The dispatch or tag-push step must remain downstream of the gated Happy Changelog `update` job, which itself needs `test` and `security`.

Jobs:

1. `verify`
   - Same command set as CI.
   - Upload coverage and build artifacts.

2. `publish-docs`
   - Needs `verify`.
   - Build static site with `pnpm docs:build`.
   - Use `REVIEWPHIN_BUILD_HOMEPAGE=true`, `REVIEWPHIN_DOCS_SITE=https://reviewphin.com`, and `REVIEWPHIN_DOCS_BASE=/`.
   - Add `dist-docs-container/CNAME` with `reviewphin.com`.
   - Upload Pages artifact.
   - Deploy with `actions/deploy-pages`.

3. `smoke-test-image`
   - Needs `verify`.
   - Build a local `linux/amd64` Docker image with `REVIEWPHIN_BUILD_HOMEPAGE=true`.
   - Run the container.
   - Probe `http://127.0.0.1:<mapped-port>/healthz`.
   - Run `reviewphin --help` or another safe CLI command from the image.
   - Stop the container by container ID.

4. `publish-docker`
   - Needs `smoke-test-image`.
   - Log in to Docker Hub.
   - Set metadata for `cdwv/reviewphin`.
   - Publish tag-based image tags and `latest`.
   - Prefer multi-platform `linux/amd64,linux/arm64`; if QEMU arm64 proves too slow, start with amd64 and track arm64 as a follow-up.

5. `update-dockerhub-readme`
   - Needs `publish-docker`.
   - Generate `DOCKERHUB_README.md`.
   - Set `PUBLIC_REPO_URL_PREFIX=https://github.com/${{ github.repository }}/blob/main/`.
   - Publish with `peter-evans/dockerhub-description`.

Permissions and secrets:

- `contents: read` for verification and Docker jobs.
- `pages: write` and `id-token: write` for Pages deploy.
- `DOCKERHUB_USERNAME`.
- `DOCKERHUB_TOKEN`.
- Optional maintainer PAT or GitHub App token for Happy Changelog tag-trigger chaining.

### Phase 4: Security and dependency automation

Goal: cover the high-value checks listed in `public/todo.html` without blocking release setup on lower-priority polish.

Files to add:

- `.github/workflows/security.yml`
- `.github/workflows/secrets.yml`
- `.github/dependabot.yml`

`security.yml`:

- CodeQL on pull requests, `main`, and weekly schedule.
- Dependency review on pull requests.
- OpenSSF Scorecard on `main` and weekly schedule.
- Note in the plan/PR that CodeQL and dependency review availability depends on repository visibility and GitHub Advanced Security.
- If this remains a separate workflow, expose a stable blocking check named `security` for branch protection, or keep the blocking `security` job in `ci.yml` and reserve this workflow for scheduled/deeper security checks.

`secrets.yml`:

- Gitleaks on pull requests, `main`, and weekly schedule.
- Add a one-time maintainer instruction for full-history scanning before public launch.

`dependabot.yml`:

- `npm` ecosystem for package updates.
- `github-actions` ecosystem for workflow action updates.
- `docker` ecosystem for Dockerfile base image updates if Dependabot supports the current file layout.

### Phase 5: Repository settings and launch checklist

Goal: identify settings that cannot be committed as workflow files.

Manual settings:

- Enable GitHub Pages with GitHub Actions as the source.
- Configure `reviewphin.com` DNS.
- Add Pages custom domain.
- Add Docker Hub secrets.
- Enable GitHub native secret scanning if available.
- Configure branch protection after first CI run creates check names.
  - Require `test`.
  - Require `security`.
  - Require `Validate PR Changelog`.
  - Require branches to be up to date before merging if the repository wants merge commits tested against current `main`.
- Confirm Docker Hub repository ownership and write permission for `cdwv/reviewphin`.

Deferred checks:

- Markdown lint and link checking after docs URLs stabilize.
- SBOM and artifact attestations after first release workflow is working.
- Coverage badge or coverage trend once artifact location is stable.
- Stale bot automation should stay deferred.

## Release workflow

Create `.github/workflows/release.yml`.

Triggers:

- `push` tags matching `v*`.
- `workflow_dispatch` for manual retry of a specific tag.

Important trigger note:

- If Happy Changelog creates tags with the default `GITHUB_TOKEN`, GitHub will not trigger downstream `push: tags` workflows. Before implementation, verify the reusable Happy Changelog workflow's token behavior. If needed, configure Happy Changelog to push tags with a maintainer PAT or GitHub App token, or have the changelog workflow dispatch the release workflow explicitly.
- Happy Changelog tag creation must be gated in `.github/workflows/update-changelog.yml` with same-workflow `needs: [test, security]`; branch protection alone is not enough because the update workflow runs after a push to `main`.

Jobs:

1. `verify`
   - Use Node 22 and pnpm 10.18.2 via Corepack.
   - Install with `pnpm install --frozen-lockfile`.
   - Run `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm docs:build`, and `pnpm test --coverage`.
   - Build docs with `REVIEWPHIN_BUILD_HOMEPAGE=true`, `REVIEWPHIN_DOCS_SITE=https://reviewphin.com`, and `REVIEWPHIN_DOCS_BASE=/`.
   - Upload coverage and build artifacts for release diagnostics.

2. `publish-docs`
   - Needs `verify`.
   - Build with `pnpm docs:build`, not `pnpm docs:build:container`, so the Pages artifact comes from `dist-docs-container/` without mutating `public/`.
   - Set `REVIEWPHIN_BUILD_HOMEPAGE=true`, `REVIEWPHIN_DOCS_SITE=https://reviewphin.com`, and `REVIEWPHIN_DOCS_BASE=/`.
   - Write `dist-docs-container/CNAME` containing `reviewphin.com`.
   - Upload `dist-docs-container/` with `actions/upload-pages-artifact`.
   - Deploy with `actions/deploy-pages` using `pages: write` and `id-token: write`.
   - Use a Pages concurrency group with `cancel-in-progress: false`.

3. `build-and-smoke-test-image`
   - Needs `verify`.
   - Build a local `linux/amd64` image with Docker Buildx and `REVIEWPHIN_BUILD_HOMEPAGE=true`.
   - Smoke-test the image before publishing:
     - Start the container.
     - Check `GET /healthz`.
     - Check the image-provided `reviewphin` CLI is present and executable.
   - This avoids publishing an image that cannot boot.

4. `publish-docker`
   - Needs `build-and-smoke-test-image`.
   - Log in to Docker Hub using `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.
   - Publish `cdwv/reviewphin` with tags for the Git tag, semver aliases where safe, and `latest`.
   - Publish multi-architecture images for `linux/amd64` and `linux/arm64`.
   - Pass `REVIEWPHIN_BUILD_HOMEPAGE=true`.
   - Add OCI labels via `docker/metadata-action`.
   - Consider starting with `linux/amd64` if arm64 builds are too slow or fragile under QEMU, then enable arm64 once the build is proven.

5. `update-dockerhub-readme`
   - Needs `publish-docker`.
   - Generate `DOCKERHUB_README.md`.
   - Upload it with `peter-evans/dockerhub-description` or the Docker Hub API.
   - Set the repository to `cdwv/reviewphin`.
   - Use an absolute GitHub file prefix such as `https://github.com/<owner>/<repo>/blob/main/` for repository-file links.
   - Ensure every docs link points to `https://reviewphin.com`, not the old `https://reviewphin.com` host.

Repository prerequisites:

- Enable GitHub Pages with GitHub Actions as the source.
- Configure DNS and the Pages custom domain for `reviewphin.com`.
- Add Docker Hub credentials with push rights to the `cdwv/reviewphin` repository.
- Add a PAT or GitHub App token for tag-trigger chaining if Happy Changelog currently creates tags with `GITHUB_TOKEN`.

## CI workflow

Create `.github/workflows/ci.yml`.

Triggers:

- `pull_request`.
- `push` to `main`.

What it does:

- Install with frozen pnpm lockfile.
- Run `pnpm lint`.
- Run `pnpm typecheck`.
- Run `pnpm build`.
- Run `pnpm docs:build` with homepage/docs production env for `https://reviewphin.com`.
- Run `pnpm test --coverage`.
- Upload coverage artifacts and test reports.

This replaces the public-facing role of the old GitLab CI checks and gives branch protection stable status checks. Name the blocking jobs `test` and `security` so branch protection can require them directly. Branch protection itself is a repository setting, not a workflow, but it must require `test`, `security`, and changelog validation.

## Docker Hub README and canonical links

Update source docs and README link behavior before enabling release publishing:

- Change README and docs references from `https://reviewphin.com` to `https://reviewphin.com`.
- Update `docs/astro.config.mjs` default `REVIEWPHIN_DOCS_SITE` to `https://reviewphin.com`.
- Update `scripts/build-docker-readme.cjs` so Docker Hub output rewrites known old docs hosts to `https://reviewphin.com`.
- Use an absolute GitHub URL for local repository files in Docker Hub output; `./` links are not safe on Docker Hub.

## Other workflows and checks from `public/todo.html`

Recommended now:

- `.github/workflows/security.yml`
  - Run CodeQL on pull requests, `main`, and a schedule.
  - Run dependency review on pull requests.
  - Run OpenSSF Scorecard on `main` and a schedule.
  - Note: CodeQL/code scanning and dependency review may require a public repository or GitHub Advanced Security, depending on repository visibility.

- `.github/workflows/secrets.yml`
  - Run gitleaks on pull requests, `main`, and a schedule.
  - Add a one-time maintainer task for a full-history scan before public launch.
  - GitHub native secret scanning should also be enabled in repository settings when available.

- `.github/dependabot.yml`
  - Track npm/pnpm dependencies.
  - Track GitHub Actions versions.
  - Track Docker base image updates where supported.

- Release smoke testing
  - Include in the release workflow before Docker push.
  - It should verify `/healthz` and the packaged CLI.

- Coverage artifact publishing
  - Include in CI and release verification.
  - Add a badge later once the public artifact/report location is stable.

Recommended after the release path is stable:

- Markdown lint and link checking for docs and README.
- Scheduled docs link checks, because public docs will accumulate external links.
- SBOM and artifact attestations for release images and Pages artifacts.
- Multi-architecture Docker publishing if not enabled in the first release workflow.

Not recommended as an immediate workflow:

- Stale bot automation. `todo.html` explicitly warns that stale bots can hurt small projects.
- npm publishing. The package is private and the requested distribution path is Docker-first.

## Todos

1. Designing release workflow
   - Add the ordered tag-based workflow for verification, Pages deployment, Docker publishing, smoke tests, and Docker Hub README updates.

2. Designing CI workflow
   - Add pull request and main-branch checks named `test` and `security`. `test` covers lint, typecheck, build, docs build, tests, and coverage. `security` covers merge-blocking security checks.

3. Gating Happy Changelog
   - Update `.github/workflows/update-changelog.yml` so the Happy Changelog `update` job runs only after same-workflow `test` and `security` jobs pass on `main`.

4. Updating canonical docs links
   - Move docs defaults and Docker Hub README generation from `reviewphin.com` to `reviewphin.com`.

5. Designing security automation
   - Add CodeQL, dependency review, OpenSSF Scorecard, and gitleaks workflows with visibility/GHAS caveats.

6. Designing dependency automation
   - Add Dependabot coverage for GitHub Actions, npm/pnpm dependencies, and Docker-related updates.

7. Documenting repository prerequisites
   - Capture required Pages settings, DNS/custom-domain setup, Docker Hub secrets, and Happy Changelog tag-trigger token requirements.

## Notes and considerations

- Keep the existing Happy Changelog workflows for versioning and release notes.
- Modify the Happy Changelog update workflow only to add same-workflow `test` and `security` prerequisites before version/tag creation.
- Prefer one release workflow over separate docs and Docker workflows so release publication does not happen if verification fails.
- Do not use `docs:build:container` for GitHub Pages. That script is for copying built docs into `public/` for the runtime image.
- The Docker image should still use `REVIEWPHIN_BUILD_HOMEPAGE=true` so the runtime image contains the homepage and docs.
- The workflow should not assume the repository owner/name forever; use `${{ github.repository }}` where possible and only hard-code `cdwv/reviewphin` for Docker Hub.
