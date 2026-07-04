---
title: Run on Kubernetes
description: Deploy with the Helm chart, ingress, and Gateway API.
---

For cluster deployments, use the published Helm chart from GHCR. It deploys one `Deployment`, one `Service` on port `3000`, and one `PersistentVolumeClaim` for `/app/data` and `/app/tmp`. Local checkouts can also install the chart from `.chart/`.

## 1. Install the chart

```bash
REVIEWPHIN_VERSION=0.12.0
REVIEWPHIN_CHART=oci://ghcr.io/cdwv/charts/reviewphin

kubectl create namespace reviewphin
kubectl create secret generic reviewphin-env \
  --namespace reviewphin \
  --from-env-file=.env.production
helm upgrade --install reviewphin "${REVIEWPHIN_CHART}" \
  --namespace reviewphin --create-namespace \
  --version "${REVIEWPHIN_VERSION}" \
  --set application.envSecret=reviewphin-env \
  --set persistence.size=1Gi
```

The chart defaults to `cdwv/reviewphin` with a tag matching the chart `appVersion`. It requires `application.envSecret`; put `PUBLIC_URL`, model authentication such as `GH_TOKEN` or `COPILOT_GITHUB_TOKEN`, and any storage settings in `.env.production` before creating the secret. To use separate GitHub tokens per project, omit the token from this secret and configure [model profiles](../../management/model-profiles/) instead.

The examples below assume `REVIEWPHIN_CHART` and `REVIEWPHIN_VERSION` are still set in your shell.

## 2. Expose it with an Ingress

Ingress is an opt-in chart feature and is disabled by default. Enabling it is what makes `/webhooks/*` reachable from GitLab or GitHub over the internet, so this is the step that turns webhooks on for a cluster.

The quickest form uses `--set`:

```bash
helm upgrade --install reviewphin "${REVIEWPHIN_CHART}" \
  --namespace reviewphin --create-namespace \
  --version "${REVIEWPHIN_VERSION}" \
  --set application.envSecret=reviewphin-env \
  --set persistence.size=1Gi \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=reviewphin.example.com
```

For anything with TLS and controller annotations, a values file is clearer. This example terminates TLS with cert-manager and an NGINX ingress class:

```yaml title="reviewphin-values.yaml"
application:
  envSecret: reviewphin-env

persistence:
  size: 1Gi

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: reviewphin.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: reviewphin-tls
      hosts:
        - reviewphin.example.com
```

```bash
helm upgrade --install reviewphin "${REVIEWPHIN_CHART}" \
  --namespace reviewphin --create-namespace \
  --version "${REVIEWPHIN_VERSION}" \
  --values reviewphin-values.yaml
```

Set `PUBLIC_URL=https://reviewphin.example.com` in the env secret so it matches the ingress host. The whole app is served from `/`, so a single `/` prefix path exposes docs, the setup flow, and webhook routes together.

:::tip[Verify the webhook path]
After the ingress is live, confirm the receiver is reachable before configuring a platform:

```bash
curl https://reviewphin.example.com/healthz
```

Then point the GitLab webhook or GitHub App at `https://reviewphin.example.com/webhooks/<platform>`. See [exposing webhooks](../exposing-webhooks/).
:::

## Gateway API instead of Ingress

If your cluster uses the Gateway API, attach an `HTTPRoute` instead of an Ingress:

```bash
helm upgrade --install reviewphin "${REVIEWPHIN_CHART}" \
  --namespace reviewphin --create-namespace \
  --version "${REVIEWPHIN_VERSION}" \
  --set application.envSecret=reviewphin-env \
  --set persistence.size=1Gi \
  --set httpRoute.enabled=true \
  --set httpRoute.parentRefs[0].name=main-gateway \
  --set httpRoute.hostnames[0]=reviewphin.example.com
```

## Persistence

The chart provisions one `PersistentVolumeClaim` mounted for `/app/data` and `/app/tmp` via subpaths. Keep `persistence.enabled=true` (the default) in production so the SQLite database and run logs survive pod replacement, or point `persistence.existingClaim` at a claim you manage. If you move to an external [storage adapter](../storage/), only `/app/tmp` needs to persist for in-flight workspaces.
