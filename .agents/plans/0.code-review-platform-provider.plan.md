# Plan: Code Review Platform Provider

## Goal

Make the code review platform fully pluggable so the app can support more than GitLab without
hardcoding provider-specific behavior into webhook handling, tenant registration, review execution,
or setup flows.

---

## Current state

The codebase already has the core platform boundary in place:

- `src/platforms/IPlatform.ts` defines the provider contract for webhook parsing, tenant key
  derivation, request authorization, trigger classification, interaction job creation, review
  runtime creation, tenant registration validation, and optional setup routes.
- `src/platforms/gitlab/` contains the GitLab implementation behind that platform boundary.
- `src/app.ts` registers webhook routes per platform via `getPlatforms()`.
- `src/tenants/tenant-registry.ts` resolves tenants by `platform` and provider-derived tenant key,
  then delegates request authorization to the platform.
- `src/jobs/review-worker.ts` already delegates trigger classification, interaction job creation,
  and review runtime creation to the platform implementation.
- `storage-v001` is active and tenants are stored as `platform` + `platformConfigJson`.
- `tenant add` and `tenant list` already work with platform-aware tenant data.

---

## Remaining work

1. **Provider loading**
   Replace the hardcoded platform registry with dynamic loading similar to storage providers, so
   built-in shorthands and external/custom platform modules can be configured instead of being
   compiled directly into `src/platforms/platform-registry.ts`.

2. **Setup route wiring**
   `IPlatform.getSetupRoutes()` exists, but `src/app.ts` does not yet register provider-declared
   setup endpoints. Wire those routes into the app so providers can expose setup and onboarding
   flows.

3. **Raw webhook body support**
   Extend the webhook request contract to include raw request bytes. This is required for providers
   that validate signatures using HMAC or other raw-body-based mechanisms.

4. **Provider-specific webhook path support**
   Keep the wildcard webhook route behavior after `/webhooks/<platform>/...` and make it part of the
   supported provider contract, so providers that cannot derive tenant identity from the payload can
   extract a tenant identifier from the route suffix instead.

5. **Provider-native interaction job data**
   Review whether `InteractionJobRecord` needs an additional provider-native payload field or a more
   generic identifier model before supporting another platform cleanly.

6. **Tenant config expectations**
   Confirm whether keeping secrets inside `platformConfigJson` remains sufficient once HMAC-based or
   OAuth-style providers are added. If not, adjust tenant storage before introducing another
   provider.

---

## Recommended implementation order

1. Add raw webhook body support and provider-declared setup route registration.
2. Make provider-specific webhook path suffixes a supported and documented part of tenant
   identification.
3. Replace the hardcoded platform registry with configurable module loading.
4. Review any remaining contract or schema cleanup needed before the GitHub provider follow-up plan
   starts implementation.

---

## Done when

- Platforms can be loaded without editing `platform-registry.ts`.
- Providers can validate raw-body webhook signatures.
- Providers can register setup routes through the app.
- Providers can resolve tenant identity either from the payload or from the wildcard webhook path
  suffix.
- The platform API is ready for the follow-up GitHub provider plan in
  `.agents/plans/github-provider-with-app-manifest-flow.plan.md`.
