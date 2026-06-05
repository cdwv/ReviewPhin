# Code review platform providers

ReviewPhin connects to a code review platform to receive webhooks, read code review data, and write back bot-owned discussions. The app routes those responsibilities through platform adapter modules. GitLab is the default built-in platform, and additional provider modules can be loaded at runtime.

---

## GitLab

GitLab is currently the only supported platform. `reviewphin tenant add` accepts `--platform gitlab`, but that flag is optional because GitLab is the default today.

A GitLab tenant registration needs the following pieces of information - reducing the number of steps required to onboard a project is on the roadmap.

- **GitLab access token** - personal, group, or project access token. Must have the `api` scope (used for reading code review data, creating/updating/resolving bot-owned discussions, and cloning the repository over Git-over-HTTPS) and the token's user must have at least the **Developer** role on the project.
- **Bot username** - usually discovered automatically from the GitLab token during `tenant add`. You can still pass it explicitly as an override if auto-discovery fails or you want to avoid the extra API lookup.
- **Bot user ID** - usually discovered automatically from the GitLab token during `tenant add`. You can still pass it explicitly as an override if auto-discovery fails or you want to avoid the extra API lookup.
- **GitLab base URL** - e.g. `https://gitlab.example.com`.
- **GitLab project ID** - the numeric ID of the project to support.
- **Webhook + webhook secret** - point the GitLab project webhook at `https://<reviewphin-instance-host>/webhooks/gitlab`. A webhook secret is required to protect against malicious traffic burning your tokens. The older `/webhooks/gitlab/note` path is still accepted as a compatibility alias for existing setups.

See the [Adding tenants](../README.md#adding-tenants) section of the README for the step-by-step setup, and the [`tenant` CLI commands](CLI.md#tenant-commands) for registration details.

---

## Loading Platform Modules

Set `PLATFORM_MODULES` to a comma-separated list of provider module specifiers. If it is unset or empty, ReviewPhin loads the built-in `gitlab` provider.

```env
PLATFORM_MODULES=gitlab,@acme/reviewphin-github-platform,./providers/internal-platform.js
```

Each entry can be one of:

- `gitlab` - built-in GitLab provider shorthand.
- A relative path, such as `./providers/github-platform.js`.
- An absolute path to a JavaScript module.
- A package or bare module specifier resolvable by Node.js, such as `@acme/reviewphin-platform`.

Relative paths are resolved from the process working directory and then loaded as file URLs. Package and bare specifiers are passed directly to dynamic `import()`.

Every provider module must export a factory as either `createPlatform(context)` or a default function. The factory receives:

- `context.env` - the process environment, including provider-specific variables.
- `context.logger` - a child logger when one is available.

The factory must return an `IPlatform` implementation. Platform slugs must be unique across all loaded modules; startup fails if two providers return the same slug.

CLI commands that need platform registration, such as `tenant add --platform <slug>`, use the same `PLATFORM_MODULES` setting from the environment. Load a custom provider module before registering tenants for that provider.

---

## Setup Routes

Providers can expose optional setup or onboarding flows by implementing `getSetupHandler()`. When present, ReviewPhin mounts one setup handler per platform under both:

- `/setup/<platform>`
- `/setup/<platform>/*`

For example, a provider with slug `github` receives requests for `/setup/github` and `/setup/github/install/callback`.

The handler receives a setup context containing:

- `pathSuffix` - the route suffix after `/setup/<platform>/`; it is `""` for the base route.
- `rawBody` - the raw request body bytes captured before parsing.

Providers that need multiple setup pages or callbacks should route internally based on `pathSuffix`. ReviewPhin does not register individual setup sub-routes for providers.

---

## Future Built-In Providers

The following platforms are not yet supported as built-in providers. They can be added as built-in adapters or supplied as external platform modules.

| Platform      | Notes                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **GitHub**    | Probably as a first-class adapter based on GitHub App registration. Though GitHub already does code reviews with Copilot, you might still want to connect custom models in your private network or use one of the future harnesses to do a review on GitHub. |
| **Bitbucket** | Possibly not first-class from the start, but a good candidate to showcase a custom code-review-platform module.                                                                                                                                              |

Contributions welcome - see [CONTRIBUTORS.md](../CONTRIBUTORS.md).
