# n8n-nodes-shortsintel

n8n community nodes for [ShortsIntel](https://www.shortsintel.com): research a niche, search and analyse short-form videos on TikTok, Instagram Reels, YouTube Shorts and Facebook, search the Meta and TikTok Ad Libraries, and track creators, hashtags, sounds, keywords and advertisers with Change Reports. The action node works as an AI Agent tool.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) · [Trigger](#trigger) · [Credits](#credits) · [Development](#development)

## Installation

In n8n: **Settings > Community Nodes > Install**, enter `n8n-nodes-shortsintel`. See the [n8n community nodes guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

1. Create an API key at https://www.shortsintel.com/console/keys. It starts with `sk_live_` and is shown once.
2. In n8n, add a **ShortsIntel API** credential and paste the key. n8n checks it with `GET /v1/account/balance`, which is free.

The ShortsIntel Trigger registers a webhook endpoint, which needs a key from an owner or admin of the workspace.

## Operations

The **ShortsIntel** node. Every operation also works as a tool for the n8n AI Agent.

| Resource | Operation | API |
|---|---|---|
| Research | Research a Niche | `POST /v1/research` |
| Video | Analyse | `POST /v1/videos/{platform}/{id}/intelligence` |
| Video | Look Up | `POST /v1/videos/lookup` |
| Video | Search | `POST /v1/videos/search` |
| Lookup | Get Creator | `GET /v1/creators/{platform}/{handle}` |
| Lookup | Get Hashtag | `GET /v1/hashtags/{platform}/{tag}` |
| Lookup | Get Keyword | `GET /v1/keywords/{platform}` |
| Lookup | Get Sound | `GET /v1/sounds/{platform}/{id}` |
| Ad | Get Meta Ad | `GET /v1/ads/meta/{library_id}` |
| Ad | Get TikTok Ad | `GET /v1/ads/tiktok/{ad_id}` |
| Ad | Search | `POST /v1/ads/search` |
| Tracker | Create | `POST /v1/trackers` |
| Tracker | Get | `GET /v1/trackers/{id}` |
| Tracker | Get Changes | `GET /v1/trackers/{id}/changes` |
| Tracker | Get Many | `GET /v1/trackers` |
| Tracker | Update | `PATCH /v1/trackers/{id}` |
| Collection | Add Tracker | `POST /v1/collections/{id}/members` |
| Collection | Create | `POST /v1/collections` |
| Collection | Get Many | `GET /v1/collections` |
| Run | Get | `GET /v1/runs/{id}` (free) |
| Run | Wait | `GET /v1/runs/{id}` every 5 seconds until the Run finishes (free) |
| Account | Get Balance | `GET /v1/account/balance` (free) |
| API Call | Make | Any `/v1` path on `https://www.shortsintel.com`, with the credential's key |

Creator Trackers support TikTok, Instagram and Facebook; YouTube creators are refused by the API.

**Long-running work.** Operations that start a Run take a **Wait** field (seconds, default 20). A Run that finishes in time comes back with its result; one that does not comes back with `run.status` `running` and its id. Follow it with **Run > Wait**.

**Lists.** "Get Many" and "Get Changes" page through the API's `next_cursor`. Turn on **Return All**, or set **Limit**.

## Trigger

The **ShortsIntel Trigger** node starts a workflow when a Tracker cycle produces a Change Report (`tracker.changed`). Pick one Tracker or leave it on any Tracker.

- Activating the workflow registers the workflow's webhook URL with `POST /v1/webhooks`. ShortsIntel proves the URL with a signed `webhook.test` event during that call and activates the endpoint only on a 2xx. If it does not become `active`, the node deletes it and the activation fails with the reason.
- ShortsIntel delivers only to public HTTPS URLs. A self-hosted n8n needs `WEBHOOK_URL` set to its public HTTPS address; `localhost` cannot receive events.
- Every delivery is checked against its `X-ShortsIntel-Signature` (HMAC-SHA256 with the endpoint secret, 5 minute tolerance). A bad signature gets a 401 and starts nothing.
- The node adds the Change Report's `summary` and `triggers` from the free `GET /v1/trackers/{id}/changes`.
- Deactivating the workflow deletes the endpoint. A workspace can have at most 5 webhook endpoints.

## Credits

Paid operations spend Credits from the key's workspace. Every paid operation has an **Estimate** option under Additional Fields that returns the price and spends nothing. Prices: https://www.shortsintel.com/pricing.

## Development

This package is generated from the ShortsIntel integration module list, shared with the Make and Zapier apps.

```
integrations/
  modules.json                    shared module list (Make, Zapier, n8n)
  scripts/check-modules.ts        checks modules.json and every generated app, n8n included
  n8n/
    scripts/generate.mts          modules.json + openapi.v1.json -> the two generated files below
    nodes/ShortsIntel/operations.json          generated request table (do not edit)
    nodes/ShortsIntel/OperationsDescription.ts generated node fields (do not edit)
    nodes/ShortsIntel/ShortsIntel.node.ts      action node
    nodes/ShortsIntel/GenericFunctions.ts      requests, paging, errors, dropdowns
    nodes/ShortsIntelTrigger/ShortsIntelTrigger.node.ts  webhook trigger
    credentials/ShortsIntelApi.credentials.ts
    test/node.test.js             offline tests against dist/
```

From the ShortsIntel repo root (no API calls):

```bash
pnpm dlx tsx integrations/n8n/scripts/generate.mts           # rewrite the generated files
pnpm dlx tsx integrations/n8n/scripts/generate.mts --check   # exit 1 if they are stale
pnpm dlx tsx integrations/scripts/check-modules.ts           # endpoints, copy rules, n8n coverage
```

From `integrations/n8n`:

```bash
pnpm install
pnpm lint      # n8n-node lint (strict mode)
pnpm test      # build, then node:test, offline
pnpm dev       # local n8n with the node loaded
```

## Publishing and verification

n8n verifies only packages published from GitHub Actions with npm provenance, and `@n8n/scan-community-package` lints the source repository the provenance points at. So this directory is published from its own public repository.

1. Create the public repo `n8n-nodes-shortsintel` and copy this directory's contents to its root (without `node_modules` and `dist`).
2. On npm, create the account or org and add the repo as a trusted publisher for `n8n-nodes-shortsintel` (workflow `publish.yml`), or add an `NPM_TOKEN` secret.
3. Bump `version`, tag `v<version>` and push the tag. `.github/workflows/publish.yml` lints, tests and runs `npm publish --provenance --access public`.
4. Check it: `npx @n8n/scan-community-package n8n-nodes-shortsintel`.
5. Submit it in the [n8n Creator Portal](https://creators.n8n.io).

## License

[MIT](LICENSE.md)
