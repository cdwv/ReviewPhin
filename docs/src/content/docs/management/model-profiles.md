---
title: Model profiles
description: Configure Copilot CLI, OpenAI-compatible endpoints, Azure OpenAI, and Anthropic.
---

ReviewPhin selects models through named profiles stored in the database. When no profile is active, it uses the bundled GitHub Copilot CLI.

A model profile changes how the Copilot CLI harness talks to a backend. Today ReviewPhin has one supported harness: the GitHub Copilot CLI wrapper. OpenAI-compatible, Azure OpenAI, and Anthropic profiles configure that harness with different provider settings; they do not switch to a different runtime.

Examples use `reviewphin` for readability — see [running the CLI](../#running-the-cli).

## Resolution order

1. `/reviewphin-profile <name>` in the code review description.
2. The tenant profile set with `tenant set-profile`.
3. The database default profile.
4. Plain Copilot CLI fallback.

## Copilot CLI profile

When no model profile is active, ReviewPhin uses native Copilot access. For non-interactive runs, set one GitHub token variable:

```ini
GH_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
# or
GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
# or
COPILOT_GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The token owner needs GitHub Copilot access. If Copilot access comes through an organization or enterprise, Copilot CLI must also be enabled by policy. For local interactive runs, `copilot auth login` can be used instead of a PAT.

Create a native Copilot profile when you want to pin a model while keeping Copilot's own backend:

```bash
reviewphin model-profile add \
  --name copilot-gpt5.4 \
  --review-model gpt-5.4 \
  --text-generation-model gpt-5.4-mini \
  --routing-model gpt-5.6-luna \
  --routing-reasoning-effort low \
  --default
```

Before pinning a model, list the catalog available to the current Copilot identity:

```bash
reviewphin model-profile available-models
```

The catalog comes from GitHub Copilot at command time. It can vary by token, account, organization policy, and date. To inspect the credentials stored in a native profile, use `--model-profile`:

```bash
reviewphin model-profile available-models --model-profile copilot-team-a
```

To check a GitHub token before creating a profile, pass it directly:

```bash
reviewphin model-profile available-models --auth-token github_pat_xxxxxxxxxxxxxxxxxxxx
```

The direct token is used only for that catalog request. ReviewPhin does not store or display it. `--model-profile` and `--auth-token` cannot be used together.

The table includes the model ID, display name, supported reasoning efforts, default effort, and vision support. Use `--output plain` for tab-separated rows or `--output json` for structured output.

## OpenAI-compatible endpoint

Any provider that exposes an OpenAI-compatible API can be used with `--provider-type openai`.

```bash
reviewphin model-profile add \
  --name byok-llama \
  --base-url http://vllm-host:8000/v1 \
  --provider-type openai \
  --review-model meta-llama/Llama-3.1-8B-Instruct \
  --ignore-missing-model
```

No `--auth-token` is needed when the endpoint runs without an API key. If the endpoint requires one, add `--auth-token <key>`.

For OpenAI's hosted API, use `https://api.openai.com/v1`:

```bash
reviewphin model-profile add \
  --name openai-gpt5.4 \
  --base-url https://api.openai.com/v1 \
  --provider-type openai \
  --auth-token sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --review-model gpt-5.4 \
  --text-generation-model gpt-5.4-mini \
  --ignore-missing-model \
  --default
```

## Azure OpenAI

Use the deployment name as `--review-model`.

```bash
reviewphin model-profile add \
  --name azure-gpt5.4 \
  --base-url https://my-resource.openai.azure.com \
  --provider-type azure \
  --auth-token your-azure-api-key \
  --review-model my-gpt5.4-deployment \
  --text-generation-model my-gpt5.4mini-deployment \
  --ignore-missing-model
```

## Anthropic

```bash
reviewphin model-profile add \
  --name anthropic-claude \
  --base-url https://api.anthropic.com \
  --provider-type anthropic \
  --auth-token sk-ant-xxxxxxxxxxxx \
  --review-model claude-opus-4.8 \
  --text-generation-model claude-sonnet-4.6 \
  --ignore-missing-model
```

Use `--wire-api completions` only for compatibility endpoints that do not support the default Responses-style API.

## Review and text models

For cost efficiency, configure a stronger review model and a lighter text-generation model:

```bash
reviewphin model-profile add \
  --name production \
  --review-model gpt-5.4 \
  --text-generation-model gpt-5.4-mini \
  --routing-model gpt-5.6-luna \
  --routing-reasoning-effort low \
  --default
```

When `--text-generation-model` is omitted, ReviewPhin uses the review model for text generation. The text-generation model is used for lighter work such as memory coalescing and reply text.

## Routing collected requests

Every comment request is classified by a model before ReviewPhin chooses review, memory work, replies, or a combination. The router reads the collected comments together and returns a decision for each one. It has no tools or subagents.

Our Copilot examples use `gpt-5.6-luna` with `low` reasoning for routing. Add it to an existing profile:

```bash
reviewphin model-profile add \
  --name production \
  --routing-model gpt-5.6-luna \
  --routing-reasoning-effort low
```

The router uses the profile's provider and credentials. Check `model-profile available-models` with those credentials before selecting a model. Custom endpoints and Azure deployments must supply a model they actually serve; they can inherit the chatter settings instead.

When `routing-model` is unset, the router uses the chatter (text-generation) model. When `routing-reasoning-effort` is unset, it uses the chatter reasoning setting. These defaults are independent: you can select a routing model and inherit chatter reasoning, or override reasoning while using the chatter model. If chatter itself has no explicit model, its existing review-model or harness default also applies to routing. The review reasoning setting is not inherited.

If the selected router fails, ReviewPhin tries the chatter model and its reasoning setting, provided that would be a different model or setting. If that also fails, the job is retried under the normal retry policy. ReviewPhin never substitutes keyword rules for a model decision. Each model attempt has a 20-second response budget shared across output correction attempts; startup and cleanup can add time. Input above 48,000 characters fails visibly without dropping requests. Successful routing and any reason for switching models are recorded in the run's `orchestration/routing.json` artifact.

Clearing `routing-model` with `--clear-routing-model` also clears its reasoning override and restores chatter defaults. Use `--clear-routing-reasoning-effort` to restore only chatter reasoning. Explicit model IDs are checked when saving a profile.

Existing profiles retain their stored model settings during migration. The new routing fields start empty, so those profiles automatically route with their chatter model and reasoning.

## Reasoning effort

Set reasoning effort with `--review-reasoning-effort`, `--text-generation-reasoning-effort`, and `--routing-reasoning-effort`. Accepted values are `low`, `medium`, `high`, and `xhigh`.

```bash
reviewphin model-profile add \
  --name gpt56-review \
  --review-model gpt-5.6 \
  --review-reasoning-effort high \
  --text-generation-model gpt-5.6-mini \
  --text-generation-reasoning-effort low \
  --routing-model gpt-5.6-luna \
  --routing-reasoning-effort low \
  --default
```

Chatter reasoning does not inherit review reasoning, even when chatter uses the review model. Routing reasoning inherits chatter reasoning unless explicitly overridden.

When review or chatter effort is left unset (or cleared), the harness keeps its own default. Unset routing effort inherits chatter effort; if both are unset, the router also uses the harness default.

Clear a previously set effort with the matching clear flag:

```bash
reviewphin model-profile add --name gpt56-review --clear-review-reasoning-effort
reviewphin model-profile add --name gpt56-review --clear-text-generation-reasoning-effort
```

If a review or chatter model does not support the chosen reasoning effort, ReviewPhin reports the provider error. Routing first tries the chatter model and reasoning setting, as described above; if that also fails, the job retries.

:::note[Model availability]
GPT-5.6 models are shown as examples. Availability depends on the account or organization entitlement of the token or key backing the profile — not every account can use every model or effort.
:::

## Save-time model validation

When you create or update a profile, ReviewPhin resolves the complete result first. It then checks every explicit native Copilot model against the catalog for that profile's credentials before changing storage. This includes stored model values retained during a partial update.

If an explicit model is missing, or the catalog cannot be loaded, the command fails and leaves both the profile and the current default unchanged. An unset native review model is valid: `null` tells Copilot CLI to choose its default and does not require a catalog lookup. An unset text-generation model inherits the review model, so the explicit review model is checked once.

Custom providers do not share one reliable model-discovery endpoint or metadata format. ReviewPhin therefore cannot verify their model IDs. Use `--ignore-missing-model` when you have verified a custom provider separately and want to save it anyway, as shown in the examples above. The flag still attempts validation where discovery is supported and prints a warning explaining whether a model was missing or availability could not be verified.

Validation happens only when `model-profile add` writes a profile. Selecting a stored profile with `model-profile set-default`, assigning it to a tenant, or starting a review does not query the catalog again. If availability changes later, the provider's existing session error and retry behavior applies.

## Updating profiles

Re-run `model-profile add` with the same `--name` to update fields. Nullable fields can be cleared:

```bash
reviewphin model-profile add --name my-profile --clear-base-url
reviewphin model-profile add --name my-profile --clear-auth-token
```

`--clear-base-url` also clears the stored provider type and wire API. You cannot set new values for provider type or wire API in the same command that clears the base URL.

Updates also validate the effective stored model values. If you deliberately need to retain an unavailable or unverifiable model, include `--ignore-missing-model` on that update.

Full flags for `model-profile` commands are in the [CLI reference](../cli-reference/#model-profile-commands).
