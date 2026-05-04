# Centralized harness session creation plan

## Goal

Refactor the current Copilot setup into a shared harness runtime with explicit boundaries between:

- worker/orchestrator concerns
- harness/session mechanics
- memory backend implementation
- memory consolidation orchestration

The purpose is not only to centralize session creation, but to stop session callers from knowing anything about memory implementation details.

## Scope

Introduce one shared harness session entrypoint that:

- keeps provider/auth/session/logging behavior centralized
- receives caller-selected model, prompt, tools, subagents, and only shared infrastructure context structurally
- translates typed tool and subagent identifiers into actual harness registration
- instantiates memory support internally from tenant/profile context instead of asking callers to pass memory implementation details
- supports nested harness usage for memory consolidation without exposing that nesting to the surrounding caller
- preserves current reviewer behavior while making later harness-based flows reuse the same entrypoint

This plan also moves non-harness memory callers to the same backend abstraction rather than leaving them on direct helper functions.

## Non-goals

- introducing the router / chatter / reviewer orchestration split
- changing when review runs
- changing prompt families beyond what is needed to support the shared harness boundary
- introducing multiple memory providers in the same refactor
- changing durable memory semantics beyond the interface split and tool rename

## Refined responsibility split

### Worker / task orchestrator

The worker knows the task being done.

It decides:

- which prompt to use
- which tool IDs and subagent IDs should be enabled
- which model/profile should be used
- which domain data should be passed into the run

It does **not** decide:

- how Copilot sessions are created
- how tools are registered
- how memory is stored
- whether a memory consolidation step is implemented as another harness session

### Harness runtime (`src/harness`)

The harness runtime is task-agnostic.

It knows:

- how to create and run a session for a tenant + model/profile
- how to register tools and custom agents from typed IDs
- how to wire logging, provider config, permissions, and session lifecycle
- how to create the memory backend needed by harness-owned tools
- how to invoke memory consolidation as an internal concern when the memory flow requires it

It does **not** know:

- reviewer-specific prompt rules
- reviewer-specific result schemas
- why a given tool/subagent set was chosen

### Memory backend

Extract wiki-backed memory behavior into a separate backend interface and concrete implementation.

The backend owns:

- loading durable memory for a tenant/project
- adding or updating entries
- persisting the underlying representation

The concrete first implementation is still the GitLab wiki page, but the harness depends on the backend abstraction rather than on wiki helpers directly.

### Memory consolidator

Memory consolidation becomes a separate concern that receives:

- tenant context
- resolved model/profile context
- a memory backend instance
- consolidation input

It decides how to run consolidation, including creating another harness session if needed.

The surrounding harness should only know that it asked for consolidation, not that consolidation itself is another harness session.

In this codebase, it is worth treating the memory consolidator conceptually as another worker/orchestrator concern with a narrower task. It prepares the consolidation prompt and session shape, while the harness still only provides execution mechanics.

## Architecture direction

### One shared harness entrypoint

Refine `src/review/copilot-provider.ts` into a reusable harness session implementation under `src/harness`.

The important split is:

- orchestrators choose **what task to run**
- the harness runtime decides **how that task is executed in Copilot**

### Typed runtime selections

Prefer typed identifiers over broad capability bags.

Planned shape:

- typed `tools`
- typed `subagents`
- explicit prompt input
- explicit model/profile input
- only infrastructure context passed structurally at the harness boundary

Task-specific data should be passed into session creation through the prompt rather than through dedicated harness-level task payload structures. The only structured inputs the harness should accept directly are shared runtime concerns such as tenant context, resolved model/profile context, and run/job metadata needed for logging or tracing.

If later implementation work reveals a task-specific need that does not fit this prompt-only boundary cleanly, that should be treated as a design exception and confirmed before expanding the harness API.

This keeps the harness mechanical and lets worker-level code remain domain-driven.

### Memory tool behavior

Rename the caller-facing memory tool from `update_project_memory` to `add_memory_entry`.

Important note:

- this is a naming improvement, not a semantic split of multiple write modes
- the tool should resolve its backend internally from tenant context
- the underlying backend may still rewrite/coalesce persisted memory as part of save behavior
- callers should think in terms of durable memory entry creation, not direct document editing

## Concrete code changes

### `src/harness/**`

Create a harness-centered module boundary that owns session mechanics.

Likely contents:

- shared session factory / runner
- typed tool registry
- typed subagent registry
- runtime configuration types
- session logging and permission wiring

### `src/review/copilot-provider.ts` and `src/review/provider.ts`

Move reviewer-specific code to a thin orchestration layer that builds a reviewer run spec for the shared harness runtime.

Likely changes:

- keep resolved profile/config types reusable
- replace review-specific low-level session creation with a harness runtime call
- keep review prompt building and review result parsing in review-owned code
- preserve current review behavior through a reviewer-shaped adapter over the harness runtime

### `src\memory\**`

Split memory into:

- backend interface types
- concrete GitLab wiki backend implementation
- shared memory tool input/output types
- memory consolidation concern

Likely changes:

- move direct wiki load/save logic behind a backend class/module
- move non-harness callers such as hydration/loading onto the backend interface
- remove direct `GitLabClient` + wiki persistence knowledge from the harness session implementation

### Memory consolidation wiring

Refactor `ProjectMemoryTextCoalescer` into a memory-consolidation concern that can use the harness runtime internally.

The consolidator should:

- accept tenant/profile/backend context
- create its own consolidation session spec
- return consolidated entries or save through the backend as needed

The main harness runtime should not contain consolidation prompt logic.

### Additional clarifications worth locking down

- **Harness return shape:** the harness should return session output/events in a task-agnostic way, while review and consolidation code remain responsible for result parsing and validation.
- **Memory backend lifetime:** the backend should be created once per harness run and shared downward across harness-owned tools and consolidation flows rather than recreated independently in each tool call.
- **Consolidation trigger and failure policy:** consolidation is best-effort. Adding and saving the new memory entry remains the primary operation and should happen first. If later consolidation fails, that should be logged but should not fail the main run. Consolidation may run as a non-blocking side-job after the durable write succeeds.
- **Model selection for consolidation:** consolidation should use the resolved profile. The consolidator may decide which concrete model field from that profile to use when creating its session.
- **Nested-session observability:** nested consolidation runs should carry explicit parent run/job identifiers so logs make parent/child session relationships visible.
- **Harness task agnosticism:** it is worth stating explicitly that task agnosticism applies to both inputs and outputs; prompt construction, result parsing, and validation remain outside the core harness runtime.
- **Concurrent memory updates:** because consolidation can run asynchronously after a successful write, the backend contract should make clear how callers avoid stale-write races when multiple runs add or consolidate memory near the same time.

### Tests

Add or update tests for:

- typed tool selection -> actual tool allowlist registration
- typed subagent selection -> actual custom-agent registration
- provider/auth wiring remains intact
- explicit provider config still disables config discovery as today
- `add_memory_entry` resolves through the backend abstraction
- non-harness memory loading/saving also uses the backend abstraction
- memory consolidation can run through the shared harness path without task-specific leakage into the harness runtime
- reviewer behavior stays unchanged after the refactor

## Acceptance criteria

- one shared harness session entrypoint is used for session construction
- callers provide model/prompt/tool/subagent choices explicitly
- callers do not pass memory implementation details into harness session creation
- the harness runtime instantiates and uses the memory backend from tenant/profile context
- durable memory persistence is abstracted behind a separate backend module/class
- memory consolidation is a separate concern and may use another harness session internally
- reviewer behavior remains unchanged after the refactor
- the caller-facing memory tool name is `add_memory_entry`

## Dependencies

This plan should follow the interaction rename plan so it can adopt interaction-centric runtime vocabulary where needed.

The router/chatter/reviewer orchestration plan should depend on this plan rather than introducing a second session construction path.
