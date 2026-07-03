---
title: Providers
description: How platform and storage providers extend ReviewPhin.
---

Providers keep platform-specific and storage-specific details out of the review worker. The worker speaks in semantic operations; providers translate those to and from native APIs.

## Platform providers

A platform provider receives webhooks, loads review context, builds publication adapters, and exposes optional setup routes.

Built-ins:

- `gitlab`
- `github`

Custom providers are loaded from `PLATFORM_MODULES`. To add one, see [custom platform providers](../custom-platforms/).

## Storage providers

A storage provider implements the shared entity store contract and reports the storage contract revision it supports.

Built-ins:

- SQLite
- Flotiq

Custom providers are loaded from `STORAGE_PROVIDER_MODULE`. To add one, see [custom storage adapters](../custom-storage/).

## The shared rule

Providers can hide native platform details, but they must preserve ReviewPhin's semantic contracts:

- stable tenant identity,
- deduplicated jobs,
- review publication identity,
- storage contract compatibility.

The central reconciler owns finding identity, reconciliation policy, persistence, and operation ordering. Draft notes, pending reviews, submission calls, and marker recovery are provider implementation details.

## Future built-ins

Bitbucket is not currently built in. It can be added as a built-in adapter or supplied as an external platform module.
