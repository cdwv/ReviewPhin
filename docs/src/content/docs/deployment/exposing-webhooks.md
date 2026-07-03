---
title: Exposing webhooks
description: Give platforms a public HTTPS URL for a local, Docker, or cluster instance.
---

ReviewPhin receives platform events over HTTPS at `/webhooks/<platform>`. The platform must be able to reach that route, and `PUBLIC_URL` must match the address it uses. This page covers how to get a reachable URL for each environment, then how to point a webhook at it.

```text
GitLab / GitHub  --HTTPS-->  public URL  -->  ReviewPhin /webhooks/<platform>
```

## Set PUBLIC_URL

Whatever public address you obtain, set it as `PUBLIC_URL` in the worker environment:

```ini
PUBLIC_URL=https://reviewphin.example.com
```

GitHub App setup bakes callback and webhook URLs from this value, and GitLab webhook instructions rely on it. It also preserves reverse-proxy path prefixes such as `https://host/reviewphin`.

## Tunnels for local and Docker

A machine running the worker locally or in Docker is usually not reachable from your GitLab or GitHub instance. A tunnel gives you a temporary public HTTPS URL that forwards to `localhost:3000`.

```bash
# cloudflared (no account needed for one-off tunnels)
cloudflared tunnel --url http://localhost:3000

# or ngrok
ngrok http 3000
```

Each prints a public HTTPS URL. Set it as `PUBLIC_URL`, restart the worker if it was already running, then use the same URL when configuring the webhook.

:::caution
Ephemeral tunnel URLs change every time you restart the tunnel. When the URL changes you must update `PUBLIC_URL` and the platform webhook (and, for GitHub, recreate the App connection, since its URLs are fixed at creation). Use a named cloudflared tunnel or a reserved ngrok domain for anything long-lived.
:::

For durable production, prefer a TLS-terminating reverse proxy or the cluster ingress below instead of a tunnel.

## Ingress for Kubernetes

On a cluster, the chart's Ingress (or Gateway API `HTTPRoute`) is what exposes the worker to the internet. The whole app is served from `/`, so a single prefix path covers the webhook routes. See [Run on Kubernetes](../kubernetes/#2-expose-it-with-an-ingress) for a full TLS ingress example.

## GitLab webhook

GitLab webhooks are configured by hand on the project. In the project's **Settings → Webhooks**, add:

| Field | Value |
| --- | --- |
| URL | `https://your-host/webhooks/gitlab` |
| Secret token | the value passed as the tenant's `--webhook-secret` |
| Trigger | **Note events** only |

Save, then use **Test → Note events** to confirm ReviewPhin receives the delivery and returns `202 Accepted`. The older `/webhooks/gitlab/note` path is still accepted for existing setups; use `/webhooks/gitlab` for new webhooks.

The webhook secret is set per tenant — see [tenants](../../management/tenants/#gitlab).

## GitHub webhook

GitHub does not need a manual webhook. The generated GitHub App configures its own webhook at `https://your-host/webhooks/github` during the manifest setup flow, using `PUBLIC_URL`. Keep the app installed on every repository you register as a tenant. See [platform connections](../../management/platform-connections/#github).

## Verify

```bash
curl https://your-host/healthz
# {"status":"ok"}
```

If health passes but reviews never start, re-check that `PUBLIC_URL` matches the address the platform calls and that the webhook secret matches the tenant.
