# Code review platform providers

ReviewPhin connects to a code review platform to receive webhooks, read code review data, and write back bot-owned discussions. The app routes those responsibilities through platform adapter modules. GitLab and GitHub are built-in platforms, and additional provider modules can be loaded at runtime.

---

## GitLab

Register a GitLab platform
connection before adding tenants. Connections hold reusable API credentials,
base URL, and bot identity; tenants hold project and webhook-specific data.

A GitLab tenant registration needs the following pieces of information - reducing the number of steps required to onboard a project is on the roadmap.

- **GitLab access token** - personal, group, or project access token. Must have the `api` scope (used for reading code review data, creating/updating/resolving bot-owned discussions, and cloning the repository over Git-over-HTTPS) and the token's user must have at least the **Developer** role on the project.
- **Bot username** - discovered during platform connection add/update.
- **Bot user ID** - discovered during platform connection add/update.
- **GitLab base URL** - e.g. `https://gitlab.example.com`.
- **GitLab project ID** - the numeric ID of the project to support.
- **Webhook + webhook secret** - point the GitLab project webhook at `https://<reviewphin-instance-host>/webhooks/gitlab`. A webhook secret is required to protect against malicious traffic burning your tokens. The older `/webhooks/gitlab/note` path is still accepted as a compatibility alias for existing setups.

GitLab project memory uses the project wiki only when GitLab project metadata
reports the wiki feature enabled. If the project wiki is disabled, memory uses
the configured ReviewPhin storage provider. If wiki is later enabled and a
store-backed memory row exists, the GitLab wiki wins and the store row is
deleted without copying it into the wiki.

See the [Adding tenants](../README.md#adding-tenants) section of the README for the step-by-step setup, and the [`tenant` CLI commands](CLI.md#tenant-commands) for registration details.

---

## GitHub

GitHub connection registration uses the GitHub App manifest flow. Set
`PUBLIC_URL` to the externally reachable ReviewPhin URL, then run:

```bash
reviewphin platform connection add \
  --platform github \
  --name main-github \
  --owner example-org
```

The command stores a one-hour setup token and prints
`<PUBLIC_URL>/setup/github/<token>`. The setup page previews the manifest and
builds the callback, `/webhooks/github`, and `/favicon.png` URLs from the
configured `PUBLIC_URL`, preserving any reverse-proxy path prefix.
`PUBLIC_URL` is not editable on the setup page. A
successful registration callback validates the returned owner,
stores the app credentials, and redirects to the GitHub App installation page.
GitHub then returns to the manifest `setup_url` with an installation ID.
ReviewPhin authenticates as the app, verifies that installation through the
GitHub API, validates the installation account, and confirms installation-token
access by listing repositories. Only then does it invalidate the setup token
and mark the connection `ready`.

For template review during local development, `pnpm dev` also serves and logs
`http://localhost:<PORT>/github/setup/samples`. That gallery renders the
GitHub setup pages with example data and is intentionally outside
`/setup/github`, so viewing it does not require a setup token, read or mutate
storage, contact GitHub, or advance a connection through the setup flow. The
sample gallery is not mounted by the production server.

GitHub project memory uses the configured ReviewPhin storage provider. It does
not read or write repository wiki pages for memory, and the generated GitHub
App does not request repository contents write access for memory.

GitHub does not expose an App Manifest field or REST endpoint for assigning the
app badge. The setup success page therefore links directly to
`<PUBLIC_URL>/favicon.png` and explains how to upload it manually from the
generated app's **Settings > Developer settings > GitHub Apps** page. GitHub
accepts PNG, JPG, or GIF files under 1 MB and recommends a square image around
200 by 200 pixels.

GitHub tenant registration, authenticated `check_run.requested_action`
ingestion, review hydration, publication, and reconciliation are implemented.
ReviewPhin validates the App-owned Check Run, resolves exactly one pull request
at the same head SHA, creates a deduplicated commentless review job, and
updates the Check Run as the job moves through its lifecycle.

New inline findings are created in one pending pull request review and
submitted with the `COMMENT` event. Eligible new-side findings use GitHub
suggested-change blocks. Findings without a valid new-side line anchor use
marked issue comments. Follow-up ReviewPhin responses to those fallback
findings are published as additional issue comments linked by a hidden marker,
because GitHub issue comments are not natively threaded. File-level review
comments remain follow-up work pending verification of GitHub's batch-review
behavior. The updateable review summary is also an issue comment. Review thread
identity and resolve/unresolve state use GitHub GraphQL.
Retries recover ReviewPhin-owned pending or submitted publications by stable
markers instead of duplicating comments.

### Manual review trigger

GitHub Apps cannot register custom slash commands in ordinary issue or pull
request comments, and their bot identities do not provide reliable mention
autocomplete. The native trigger contract is a GitHub Check Run action button
labeled **Run Review**. Clicking it delivers a
`check_run.requested_action` webhook that ReviewPhin now validates and queues.
ReviewPhin provisions the neutral Check Run when a pull request is opened or
reopened and creates a new one when the pull request head changes. Repeated
events reuse the existing Check Run for that pull request and head, preserving
completed review output and the action button. Check Runs created for older
heads cannot start a review against the current pull request revision.
Adding a GitHub tenant also scans its existing open pull requests and
idempotently provisions any missing Run Review Check Runs.

The provisioned Check Run is owned by the manual trigger lifecycle. GitHub
automatic review triggers are not currently implemented; if added later, they
must coordinate with this manual Check Run without replacing its action.

This requires `checks: write` permission and the `check_run` event in the app
manifest. ReviewPhin also accepts `/reviewphin review`, `@reviewphin review`,
and mentions of the generated App slug in pull request comments. These are
compatibility triggers and do not appear in GitHub's slash-command or mention
autocomplete. Human replies inside ReviewPhin-owned inline review threads are
treated as follow-up triggers without requiring another command.

### Removing the connection

Recreating or removing the ReviewPhin connection prints provider-owned cleanup
instructions but does not clean up GitHub automatically:

1. Remove tenants that reference the connection.
2. Uninstall the generated ReviewPhin GitHub App from the personal or
   organization account under **Settings > GitHub Apps**.
3. Delete the dedicated GitHub App registration from the owning account under
   **Settings > Developer settings > GitHub Apps > Advanced**.
4. Remove the local connection with `reviewphin platform connection remove`.

Deleting an app registration automatically removes its remaining
installations. Uninstalling first is still recommended because it makes the
affected account and repository access explicit before deleting the dedicated
registration.

GitLab lifecycle output likewise reminds operators to remove obsolete project
webhooks and revoke dedicated access tokens. These remote resources are not
deleted automatically.

---

## Loading Platform Modules

Set `PLATFORM_MODULES` to a comma-separated list of provider module specifiers. If it is unset or empty, ReviewPhin loads the built-in `gitlab` and `github` providers.

```env
PLATFORM_MODULES=gitlab,github,./providers/internal-platform.js
```

Each entry can be one of:

- `gitlab` - built-in GitLab provider shorthand.
- `github` - built-in GitHub provider shorthand.
- A relative path, such as `./providers/github-platform.js`.
- An absolute path to a JavaScript module.
- A package or bare module specifier resolvable by Node.js, such as `@acme/reviewphin-platform`.

Relative paths are resolved from the process working directory and then loaded as file URLs. Package and bare specifiers are passed directly to dynamic `import()`.

Every provider module must export a factory as either `createPlatform(context)` or a default function. The factory receives:

- `context.env` - the process environment, including provider-specific variables.
- `context.logger` - a child logger when one is available.

The factory must return an `IPlatform` implementation. Platform slugs must be unique across all loaded modules; startup fails if two providers return the same slug.

Providers expose separate tenant and connection registration schemas.
Runtime methods receive resolved tenant and connection context.

Review publication uses the semantic
`PlatformReviewPublicationAdapter` contract. Providers implement four
operations:

- `loadDiscussions` loads normalized live review discussions.
- `mutateDiscussion` updates, replies to, resolves, or reopens an existing
  bot-owned discussion.
- `publishFindings` publishes a batch using the provider's native transaction
  and retry model.
- `upsertSummary` creates or updates the marked ReviewPhin summary.

Draft notes, pending reviews, submission calls, marker recovery, and cleanup
are provider implementation details. The central reconciler owns finding
identity, reconciliation policy, persistence, and operation ordering.

---

## Setup Routes

Providers can expose optional setup or onboarding flows by implementing `getSetupHandler()`. When present, ReviewPhin mounts one setup handler per platform under both:

- `/setup/<platform>`
- `/setup/<platform>/*`

For example, a provider with slug `github` receives requests for `/setup/github` and `/setup/github/install/callback`.

The handler receives a setup context containing:

- `pathSuffix` - the route suffix after `/setup/<platform>/`; it is `""` for the base route.
- `rawBody` - the raw request body bytes captured before parsing.
- `storage` - storage helpers when the app setup route has storage available.

Providers that need multiple setup pages or callbacks should route internally based on `pathSuffix`. ReviewPhin does not register individual setup sub-routes for providers.

The built-in GitHub sample gallery at `/github/setup/samples` is not a provider
setup handler. It is a dev-server-only template preview route for operators and
UI review, separate from the token-backed `/setup/github/<token>` flow.

---

## Future Built-In Providers

The following platforms are not yet supported as built-in providers. They can be added as built-in adapters or supplied as external platform modules.

| Platform      | Notes                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| **Bitbucket** | Possibly not first-class from the start, but a good candidate to showcase a custom code-review-platform module. |

Contributions welcome - see [CONTRIBUTORS.md](../CONTRIBUTORS.md).
