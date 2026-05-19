# Code review platform providers

ReviewPhin connects to a code review platform (currently GitLab) to receive webhooks, read merge request data, and write back bot-owned discussions. A future API expansion may allow additional first-class adapters as well as custom platform modules.

---

## GitLab

GitLab is currently the only supported platform. A tenant registration needs the following pieces of information - reducing the number of steps required to onboard a project is on the roadmap.

- **GitLab access token** - personal, group, or project access token. Must have the `api` scope (used for reading the merge request, creating/updating/resolving bot-owned discussions, and cloning the repository over Git-over-HTTPS) and the token's user must have at least the **Developer** role on the project.
- **Bot username** - the username associated with the token. Required so ReviewPhin can recognise mentions.
- **Bot user ID** - to Identify our bot in past comments, even if it changes name.
- **GitLab base URL** - e.g. `https://gitlab.example.com`.
- **GitLab project ID** - the numeric ID of the project to support.
- **Webhook + webhook secret** - point the GitLab project webhook at `https://<reviewphin-instance-host>/webhooks/gitlab/note`. A webhook secret is required to protect against malicious traffic burning your tokens.

See the [Adding tenants](../README.md#adding-tenants) section of the README for the step-by-step setup, and the [`tenant` CLI commands](CLI.md#tenant-commands) for registration details.

---

## Future providers

The following platforms are not yet supported as first-class providers. Adding them likely also means extending the API so that custom code-review-platform modules can be plugged in the same way as custom storage adapters.

| Platform      | Notes                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **GitHub**    | Probably as a first-class adapter based on GitHub App registration. Though GitHub already does code reviews with Copilot, you might still want to connect custom models in your private network or use one of the future harnesses to do a review on GitHub. |
| **Bitbucket** | Possibly not first-class from the start, but a good candidate to showcase a custom code-review-platform module.                                                                                                                                              |

Contributions welcome - see [CONTRIBUTORS.md](../CONTRIBUTORS.md).
