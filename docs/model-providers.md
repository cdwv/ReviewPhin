# Model providers

ReviewPhin selects a model through **named profiles** stored in the database. When no profiles exist, it uses the GitHub Copilot CLI, assuming it is already authenticated. When profiles exist, the effective profile for a review run is resolved in this order:

1. `/reviewphin-profile <name>` directive in the code review description (the merge request description in GitLab today)
2. the tenant's assigned profile (`tenant set-profile`)
3. the database default profile (`model-profile set-default`)
4. plain Copilot CLI fallback (no profile)

Manage profiles with the [`model-profile` CLI commands](CLI.md#model-profile-commands).

## Harnesses

A **harness** is the CLI/SDK that ReviewPhin shells out to in order to actually run a model. Today there is only one supported harness - the **GitHub Copilot CLI** - and the sections below describe how to point it at different backends (GitHub Copilot's own models, an OpenAI-compatible endpoint, Azure OpenAI, or Anthropic).

Other harnesses that may be added in the future:

- **Cursor** - Cursor subscriptions expose a wide range of models. If it can be driven from a CLI environment, it will probably be added as another first-class harness.
- **Codex** - probably the best next-in-line harness to support.
- **Claude Code** - given recent changes to how programmatic tools are billed in Claude Code, there is little point in supporting it as a built-in harness. It might still serve as a good example of a custom harness if the API is extended to accept custom JS modules.

---

### GitHub Copilot CLI (default harness)

When no model profile is active, ReviewPhin drives review sessions through the bundled GitHub Copilot CLI. No `--base-url` or `--provider-type` is needed.

The subsections below all describe the *same harness* - the Copilot CLI - configured to talk to different backends. Selecting OpenAI / Azure / Anthropic does not switch harnesses; it just tells the Copilot CLI where to send requests.

#### Requirements

- A GitHub account with an active **GitHub Copilot** entitlement (individual, organization, or enterprise).
- If Copilot access comes from an organization or enterprise, **Copilot CLI** must be enabled by org/enterprise policy.
- A **fine-grained PAT** with the **Copilot Requests** permission, or an interactive `copilot auth login` for local runs.

#### Authentication

Set exactly one of:

```env
GH_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
# or
GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
# or
COPILOT_GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

For local runs without a PAT, run `copilot auth login` once before starting the worker.

#### Pinning a specific model

Create a profile with a `--review-model` but no `--base-url`:

```bash
reviewphin model-profile add \
  --name copilot-claude \
  --review-model claude-sonnet-4.6 \
  --text-generation-model claude-haiku-4.6 \
  --default
```

Available model names depend on your Copilot plan and the models exposed through the Copilot API.

---

#### OpenAI-compatible endpoints (BYOK)

Any provider that exposes an OpenAI-compatible API can be used. Set `--provider-type openai` and provide the `--base-url`.

##### Self-hosted vLLM

```bash
reviewphin model-profile add \
  --name byok-llama \
  --base-url http://vllm-host:8000/v1 \
  --provider-type openai \
  --review-model meta-llama/Llama-3.1-8B-Instruct
```

No `--auth-token` is needed when vLLM runs without an API key. If your vLLM instance requires one, add `--auth-token your-vllm-key`.

##### OpenAI (api.openai.com)

```bash
reviewphin model-profile add \
  --name openai-gpt4 \
  --base-url https://api.openai.com/v1 \
  --provider-type openai \
  --auth-token sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --review-model gpt-4.1 \
  --text-generation-model gpt-4.1-mini \
  --default
```

---

#### Azure OpenAI

Use `--provider-type azure` for `*.openai.azure.com` endpoints. The `--review-model` value must be the **deployment name**, not the base model name.

```bash
reviewphin model-profile add \
  --name azure-gpt4 \
  --base-url https://my-resource.openai.azure.com \
  --provider-type azure \
  --auth-token your-azure-api-key \
  --review-model my-gpt4-deployment \
  --text-generation-model my-gpt4-mini-deployment
```

---

#### Anthropic

```bash
reviewphin model-profile add \
  --name anthropic-claude \
  --base-url https://api.anthropic.com \
  --provider-type anthropic \
  --auth-token sk-ant-xxxxxxxxxxxxxxxxxxxx \
  --review-model claude-opus-4 \
  --text-generation-model claude-haiku-4
```

---

#### Wire API mode

The `--wire-api` flag controls the request/response wire format sent to the provider:

| Value         | When to use                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------- |
| `responses`   | Default for BYOK profiles. Use for providers that support the newer Responses API format.    |
| `completions` | Use for older or compatibility-mode endpoints that only support the Chat Completions format. |

```bash
reviewphin model-profile add \
  --name legacy-openai \
  --base-url https://api.openai.com/v1 \
  --provider-type openai \
  --wire-api completions \
  --auth-token sk-xxx \
  --review-model gpt-4
```

---

## Two-model setup: review model vs. text-generation model

For cost efficiency, configure a lighter model for lightweight text tasks (memory coalescing, chatter replies) and a stronger model for code review:

```bash
reviewphin model-profile add \
  --name production \
  --base-url https://api.openai.com/v1 \
  --provider-type openai \
  --auth-token sk-xxx \
  --review-model gpt-4.1 \
  --text-generation-model gpt-4.1-mini \
  --default
```

When `--text-generation-model` is omitted, the review model is used for all tasks.

---

## Updating or clearing profile fields

Re-run `model-profile add` with the same `--name` to update fields. To clear a nullable field:

```bash
# Remove the stored base URL (reverts to Copilot CLI mode)
reviewphin model-profile add --name my-profile --clear-base-url

# Clear just the auth token (useful if you moved the key to an env var)
reviewphin model-profile add --name my-profile --clear-auth-token
```

`--clear-base-url` also clears the stored provider type and wire API unless you explicitly set new values in the same command.

Contributions welcome - see [CONTRIBUTORS.md](../CONTRIBUTORS.md).
