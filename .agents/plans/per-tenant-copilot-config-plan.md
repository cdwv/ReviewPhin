# Per-tenant Copilot config plan

## Problem

The worker already stores tenant identity and GitLab credentials in SQLite, but Copilot execution settings are still process-global. `src/config.ts` reads model/provider settings from env, `src/index.ts` builds one `CopilotReviewProvider` at startup, and jobs reuse that singleton for every tenant. That means there is currently no supported way to switch a single tenant between different model setups, no tenant-scoped model-profile selection, and no runtime reconfiguration for new jobs without changing env and restarting.

## Assumptions confirmed

- Per-tenant changes should apply immediately for new jobs.
- With no model-profile configuration in the database, the worker should run Copilot CLI as-is so local users who are already signed in can start the server and review immediately.
- Model-profile definitions, including auth tokens, should be managed as named entries in the app database via CLI instead of living only in deployment env vars.
- There may be multiple native Copilot-backed model profiles with different model selections, so there should be no implicit built-in default profile.
- If profiles are configured later, exactly one can be marked as default in the database; choosing that default should happen through CLI/profile management, not env vars.
- Multi-tenant hardening can stay pragmatic, but we should still prevent accidental cross-tenant config bleed.
- If `/reviewphin-profile <name>` appears in the merge request description, that merge request should be reviewed with that named model profile before any LLM work starts.

## Proposed approach

Add two SQLite-backed configuration layers:

1. a **model profile registry** managed by CLI, where each named profile can define:
   - profile name
   - optional base URL
   - optional provider type
   - optional auth token
   - optional review model
   - optional text-generation model
   - whether it is the default profile
2. a **tenant model-profile setting** where a tenant can optionally reference one named profile

The important behavior is:

- if there are no model profiles in the database, run Copilot CLI as-is with no forced provider/model config
- a tenant with no assigned profile uses the database default profile if one exists
- if no tenant profile is assigned and no default profile exists, fall back to plain Copilot CLI behavior
- multiple model profiles may still target the same backend/provider; "profile" is the user-facing concept and "provider" is just one field inside a profile
- default-profile selection lives in the database only, with a uniqueness rule that allows at most one default profile
- `/reviewphin-profile <name>` in the merge request description acts as a per-merge-request override and should be resolved before prompt building or any other LLM operation starts

At run time, the worker should resolve the effective model profile for each job in this order:

1. merge request description override
2. tenant-assigned profile
3. database default profile
4. unconfigured Copilot CLI fallback

Then it should construct a provider instance for that job/run instead of reusing one startup-global provider. Review runs should persist the resolved profile name plus the effective provider/model choices for auditability.

## Current distance / assessment

This is **moderately close**, not a rewrite. The foundations are already there:

- tenant records already live in SQLite and are resolved per webhook/job
- review execution already happens per job with a rich `ReviewContext`
- the Copilot SDK wrapper already accepts `model` and provider config dynamically

The missing pieces are mostly around configuration shape and wiring:

1. tenant schema has no model-profile settings yet
2. there is no model-profile registry schema or CLI for managing named profiles
3. there is no persistence for a single default profile
4. tenant CLI only supports add/list/remove, not tenant profile updates
5. merge request descriptions are not parsed for profile overrides
6. review provider is instantiated once at startup instead of per tenant/job
7. review run persistence does not record enough config detail to debug which profile/provider/model produced a result

## Todos

1. Define a SQLite-backed model-profile registry and CLI for named profiles, including optional auth/base-url/type/model fields, safe token handling, and a single-default rule.
2. Extend tenant storage/schema and CLI so each tenant can optionally reference a named model profile.
3. Add merge-request profile override parsing for `/reviewphin-profile <name>` and resolve the effective profile before any LLM work starts.
4. Refactor review-provider creation so each job resolves the effective profile dynamically and uses its settings for the run, while preserving zero-config Copilot CLI fallback.
5. Persist resolved run config and add pragmatic tenant isolation checks plus tests for switching behavior.

## Notes

- Keep auth secrets out of tenant rows; tenants should only reference model-profile names or ids.
- "Unconfigured" is now a first-class mode and should mean "do not force profile/provider/model settings; let Copilot CLI use its normal local auth/session behavior."
- Native Copilot-backed usage is no longer a single special mode; multiple model profiles may still be native and differ only in chosen models or token source.
- Default-profile selection should be stored in SQLite, not env.
- Immediate runtime switching only needs to affect newly started jobs; in-flight sessions can keep their existing config.
- The MR description override should be cheap to detect during hydration/classification and should fail clearly if it references an unknown profile.
- Minimum hardening should include: allowlisted profile references, no cross-tenant reuse of mutable provider state, masked token output in CLI/listing flows, a uniqueness rule for the default profile, and run logs/metrics that show which config was used.
