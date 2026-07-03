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
  --default
```

## OpenAI-compatible endpoint

Any provider that exposes an OpenAI-compatible API can be used with `--provider-type openai`.

```bash
reviewphin model-profile add \
  --name byok-llama \
  --base-url http://vllm-host:8000/v1 \
  --provider-type openai \
  --review-model meta-llama/Llama-3.1-8B-Instruct
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
  --text-generation-model my-gpt5.4mini-deployment
```

## Anthropic

```bash
reviewphin model-profile add \
  --name anthropic-claude \
  --base-url https://api.anthropic.com \
  --provider-type anthropic \
  --auth-token sk-ant-xxxxxxxxxxxx \
  --review-model claude-opus-4.8 \
  --text-generation-model claude-sonnet-4.6
```

Use `--wire-api completions` only for compatibility endpoints that do not support the default Responses-style API.

## Review and text models

For cost efficiency, configure a stronger review model and a lighter text-generation model:

```bash
reviewphin model-profile add \
  --name production \
  --base-url https://api.openai.com/v1 \
  --provider-type openai \
  --auth-token sk-xxx \
  --review-model gpt-5.4 \
  --text-generation-model gpt-5.4-mini \
  --default
```

When `--text-generation-model` is omitted, ReviewPhin uses the review model for all model-backed tasks. The text-generation model is used for lighter work such as memory coalescing and reply text.

## Updating profiles

Re-run `model-profile add` with the same `--name` to update fields. Nullable fields can be cleared:

```bash
reviewphin model-profile add --name my-profile --clear-base-url
reviewphin model-profile add --name my-profile --clear-auth-token
```

`--clear-base-url` also clears the stored provider type and wire API. You cannot set new values for provider type or wire API in the same command that clears the base URL.

Full flags for `model-profile` commands are in the [CLI reference](../cli-reference/#model-profile-commands).
