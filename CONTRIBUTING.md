# Contributing to Reviewphin

Thank you for your interest in contributing. This document covers local development setup, how to test with a real GitLab instance, and how to submit a pull request.

---

## Local development setup

### Prerequisites

- **Node.js 22+** and **pnpm 10+**
- **Git**
- A running GitLab instance you can reach from your machine (self-hosted or gitlab.com)
- A GitHub account with an active Copilot entitlement (for default Copilot CLI mode), or any OpenAI-compatible model endpoint for BYOK mode

### 1. Fork and clone

Fork the repository on GitHub, then clone your fork:

```bash
git clone https://github.com/<your-username>/reviewphin.git
cd reviewphin
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure the worker

Copy the example environment file:

```bash
cp .env.example .env
```

Minimum `.env` for local development using GitHub Copilot:

```env
PORT=3000
LOG_LEVEL=debug
SQLITE_DATABASE_PATH=./data/review-worker.sqlite
RUN_LOG_DIR=./data/run-logs
WORKSPACE_ROOT=./tmp/review-workspaces
GH_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

For BYOK (no GitHub Copilot needed), leave `GH_TOKEN` unset and configure a model profile after startup (see [Model profiles](https://reviewphin.com/docs/management/model-profiles/)).

### 4. Start the worker in watch mode

```bash
pnpm dev
```

The worker starts on `http://localhost:3000`. Changes to source files trigger an automatic restart.

### 5. Useful development commands

| Command          | Description                         |
| ---------------- | ----------------------------------- |
| `pnpm dev`       | Start with watch mode (tsx)         |
| `pnpm build`     | Compile TypeScript to `dist/`       |
| `pnpm start`     | Run the compiled app from `dist/`   |
| `pnpm test`      | Run the full test suite (vitest)    |
| `pnpm lint`      | Run ESLint across sources and tests |
| `pnpm lint:fix`  | Apply ESLint autofixes              |
| `pnpm typecheck` | Type-check without emitting files   |

---

## Testing with a real GitLab instance

Reviewphin receives webhooks from GitLab. To test the full flow locally, you need to expose your `localhost:3000` to the internet.

### 1. Create a tunnel

```bash
# cloudflared (no account required for temporary tunnels)
cloudflared tunnel --url http://localhost:3000
```

Note the generated HTTPS URL, for example `https://random-name.trycloudflare.com`.

### 2. Register a test tenant

You need a GitLab project with a bot token. See [Adding tenants](README.md#adding-tenants) for the full guide.

```bash
pnpm cli platform connection add \
  --name local-gitlab \
  --platform gitlab \
  --base-url https://gitlab.example.com \
  --api-token glpat-xxxxxxxx

pnpm cli tenant add \
  --platform gitlab \
  --connection local-gitlab \
  --project-id 123 \
  --webhook-secret my-local-secret
```

### 3. Add the webhook in GitLab

In **Settings → Webhooks**:

- URL: `https://random-name.trycloudflare.com/webhooks/gitlab`
- Secret token: `my-local-secret`
- Trigger: **Note events** only

### 4. Trigger a test review

Open a merge request in the test project and post a comment:

```
@reviewphin-dev review this
```

Watch the worker logs (`pnpm dev` output) for hydration and reconciliation activity. New bot-owned discussion threads should appear on the merge request within a minute.

---

## Running tests

```bash
pnpm test
```

Tests use [vitest](https://vitest.dev/) and are in the `test/` directory. Most tests mock storage and GitLab/model API calls. No live GitLab instance or Copilot account is needed to run the suite.

To run a specific test file:

```bash
pnpm test test/review-trigger.test.ts
```

---

## Submitting a pull request

### Forking workflow

1. Fork the repository and create a branch from `main`:

   ```bash
   git checkout -b feat/my-feature
   ```

2. Make your changes. Keep commits focused; one logical change per commit is ideal.

3. Run tests and linting before pushing:

   ```bash
   pnpm test && pnpm lint
   ```

4. Push to your fork and open a pull request against the upstream `main` branch.

### PR description format

We use [happy-changelog](https://happy-changelog.github.io/happy-changelog-website/) for release notes. Add a changelog section to your PR description so entries can be extracted automatically.

Use the `<details>` format to keep the description readable:

```markdown
<details><summary>Changelog: minor</summary>

### Added

- Incremental re-review mode focused on files changed since the last run

### Fixed

- Discussion anchor calculation for renamed files

</details>
```

The level after `Changelog:` must be `major`, `minor`, or `patch` following [semver](https://semver.org/) semantics.

**Section headers** follow [Keep a Changelog](https://keepachangelog.com/) conventions:

| Section      | When to use                                            |
| ------------ | ------------------------------------------------------ |
| `Added`      | New user-visible feature or capability                 |
| `Changed`    | Change to existing behaviour                           |
| `Deprecated` | Functionality that will be removed in a future release |
| `Removed`    | Functionality removed in this release                  |
| `Fixed`      | Bug fix                                                |
| `Security`   | Security-relevant fix or hardening                     |

Each bullet should be one sentence describing the change from a user perspective. Breaking changes warrant `major` and should include a brief migration note in the PR body.

### PR checklist

- [ ] `pnpm test` passes
- [ ] `pnpm lint` passes with no new errors
- [ ] `pnpm typecheck` produces no new errors
- [ ] PR description follows the happy-changelog format above
- [ ] New behaviour is covered by at least one test
- [ ] Environment variable additions or CLI flag changes are reflected in the relevant `docs/` page

---

## Project structure overview

```
src/
  app.ts              HTTP server and webhook route setup
  cli.ts              CLI entrypoint (tenant, model-profile, storage, mr, metrics)
  review/             Review pipeline: trigger, scope, interaction plan, reconciler
  harness/            Copilot SDK wrapper: session, tools, subagent registry, logging
  platforms/          GitLab, GitHub, and custom platform provider code
  storage/            Storage contract, provider loader, SQLite + Flotiq adapters
  prompts/            Prompt loader, registry, and builders
  memory/             Project wiki memory service
  jobs/               Job queue and review worker orchestration
prompts/
  review/             Markdown prompt fragments for review modes and subagents
  reply/              Markdown prompt fragments for chatter/reply modes
  memory/             Memory coalescing prompt
test/                 vitest test suite
docs/            Official Astro/Starlight documentation source
```

---

## Code conventions

- TypeScript strict mode is enabled; avoid `any` and non-null assertions unless unavoidable.
- All public-facing behaviour should have a corresponding test in `test/`.
- Prompt files live in `prompts/` as plain Markdown; do not inline long prompt strings in TypeScript.
- Storage adapters must implement the contract in `src/storage/contract/` and export `createStorageProvider`.
- Follow the existing import style (`*.js` extensions in TypeScript source for ESM compatibility).
