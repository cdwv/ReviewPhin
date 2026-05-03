# Centralized harness session creation plan

## Goal

Refactor the current Copilot session setup into one shared harness/session entrypoint that can be reused by reviewer and chatter-style flows.

This plan should centralize how sessions are created without changing higher-level product behavior yet.

## Scope

Introduce one shared Copilot session factory / runner that:

- keeps provider/auth/session/logging behavior centralized
- receives caller-selected model, prompt, tools, and subagents
- translates typed tool and subagent identifiers into actual harness registration
- preserves current reviewer behavior while making future chatter-style flows reuse the same entrypoint

## Non-goals

- introducing the router / chatter / reviewer orchestration split
- changing when review runs
- changing prompt families beyond what is needed to support the shared entrypoint shape
- moving memory ownership from reviewer to chatter in this plan

## Core design

### One shared entrypoint

Refine `src/review/copilot-provider.ts` so it stops being a reviewer-specific construction path and becomes a shared session factory / runner for this harness.

The important split is:

- orchestrators choose **which model**, **which prompt**, **which tools**, and **which subagents**
- the shared entrypoint decides **how to register and run** those choices in Copilot

### Typed tool and subagent selection

Prefer typed tool/subagent identifiers over a broad capability object.

Planned shape:

- typed `tools` selection
- typed `subagents` selection
- model chosen by the caller
- prompt chosen by the caller

That keeps the shared entrypoint mechanical and portable while higher-level orchestration remains domain-driven.

### Memory tool naming

Rename the caller-facing memory tool from `update_project_memory` to `add_memory_entry`.

Important note:

- this is a naming improvement, not a semantic split of multiple memory-write modes
- the existing implementation may still perform page rewrite / coalescing internally
- callers should think of it as adding durable project memory, not editing the full memory document directly

## Concrete code changes

### `src/review/copilot-provider.ts`

Refactor this file into the shared session entrypoint.

Planned changes:

- accept model selection from the caller instead of assuming review-only usage
- accept prompt input from the caller instead of assuming review-only prompt construction
- accept typed `tools` and `subagents` configuration
- map typed IDs to actual tool registration and agent registration
- keep centralized provider/auth/session/logging wiring
- preserve existing review session behavior through a reviewer-shaped wrapper or compatibility path during the refactor

### `src/review/provider.ts`

Adjust the provider/session interfaces so the shared entrypoint is reusable by multiple flows.

Likely changes:

- keep resolved profile/config types reusable
- introduce a session-run configuration type for prompt/model/tools/subagents
- avoid baking review-specific assumptions into the lowest harness interface

### Memory tool wiring

Update shared tool registration so the renamed `add_memory_entry` tool maps to the current memory persistence implementation.

Preserve existing behavior until the orchestration plan changes who is allowed to call it.

### Tests

Add or update tests for:

- typed tool selection -> actual tool allowlist registration
- typed subagent selection -> actual custom-agent registration
- provider/auth wiring remains intact
- explicit provider config still disables config discovery as today
- renamed `add_memory_entry` tool still reaches the existing memory persistence implementation
- reviewer behavior stays unchanged after the refactor

## Acceptance criteria

- one shared Copilot session entrypoint is used for session construction
- callers provide model/prompt/tool/subagent choices explicitly
- the shared entrypoint owns the harness-specific registration details
- reviewer behavior remains unchanged after the refactor
- the caller-facing memory tool name is `add_memory_entry`

## Dependencies

This plan should follow the interaction rename plan so it can adopt interaction-centric runtime vocabulary where needed.

The router/chatter/reviewer orchestration plan should depend on this plan rather than introducing a second Copilot session construction path.
