# Code review platform providers

ReviewPhin connects to a code review platform to receive webhooks, read code review data, and write back bot-owned discussions. The app now routes those responsibilities through an internal platform adapter layer, but GitLab is still the only built-in platform exposed to users today.

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

## Future providers

The following platforms are not yet supported as built-in providers. The internal adapter boundary is in place, but additional built-in adapters and any external module-loading story are still future work.

| Platform      | Notes                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **GitHub**    | Probably as a first-class adapter based on GitHub App registration. Though GitHub already does code reviews with Copilot, you might still want to connect custom models in your private network or use one of the future harnesses to do a review on GitHub. |
| **Bitbucket** | Possibly not first-class from the start, but a good candidate to showcase a custom code-review-platform module.                                                                                                                                              |

Contributions welcome - see [CONTRIBUTORS.md](../CONTRIBUTORS.md).
