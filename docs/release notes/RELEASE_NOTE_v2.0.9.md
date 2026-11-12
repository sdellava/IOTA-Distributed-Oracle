# v2.0.9 — Prevent dashboard history scans from starving operational reads

Release date: 12 November 2026. Fix for the Webview availability regression in
v2.0.8. No Move package, node registration or signing changes.

## Problem and resulting behavior

The total-event metric scanned the complete historical GraphQL connection on
cache expiry. Pagination was unbounded and concurrent dashboard requests could
duplicate the traversal. Historical work shared the upstream budget with
checkpoint, system-state and scheduler reads. A large history exhausted that
budget, producing `UPSTREAM_CAPACITY` warnings in ordinary dashboard requests.

Status responses now return operational data without waiting for historical
counts. Metrics advance in bounded background batches, share pending work and
publish a total only after a complete traversal. The UI labels initial counting,
updating and temporarily unavailable counts. Earlier complete values retain
their observation time; partial counts are never presented as complete totals.

## Bounded historical work and correct counting

- History has a default sub-budget of 60 requests/minute, capped at 10% of the
  configured global rate. Every request still passes the existing global limiter.
- Historical concurrency is at most three and leaves at least one configured
  global slot for operational work. Very small global limits can disable history
  progress rather than consume all operational capacity.
- Each metric advances at most two pages per batch by default. Each historical
  transport request has a three-second deadline. Incomplete batches resume on
  demand after ten seconds; failures back off at least thirty seconds.
- Immutable event counts retain their ascending RPC event cursor and count for
  `oracle_tasks` and `oracle_messages`. New refreshes append events after that
  cursor instead of recounting the prefix. A GraphQL snapshot cursor is not used
  as a live event subscription. Invalid/nonadvancing pages cannot commit progress.
- Task objects can be deleted, so they use complete GraphQL scan generations,
  rebuilt five minutes after a completed generation, rather than append-only totals.
- Totals describe completed traversals of the configured indexer's available
  data, not an atomic snapshot of the latest RPC checkpoint. State/cursors are
  process-local; restart triggers bounded bootstrap and large histories take time.

## Request sharing and UI compatibility

Same-network/configuration status requests share one in-flight promise and a
five-second completed-response cache. Different resolved networks remain isolated.
Frontend status/price polling shares pending requests, and old-network status
responses/errors are ignored after a network switch.

Existing numeric fields remain `number | null`. Optional `metrics.history`
metadata adds state and `asOf` observation time. New hints distinguish incomplete
or older counts. Changed backend TypeScript and checked-in JavaScript are aligned.

Authentication, SSRF/IP/DNS/redirect controls, task allowlists, audit rotation,
service limits and standalone CLI submission remain in force. Global quotas
are not raised as a workaround.

## Upgrade and .env

Existing v2.0.8 environments need no mandatory changes. Optional new variables:

```dotenv
WEBVIEW_HISTORY_PER_MINUTE=60
WEBVIEW_HISTORY_PAGES_PER_BATCH=2
```

Values must be positive integers; maxima are 600 requests/minute and ten
pages/batch. The effective history rate remains capped at 10% of
`WEBVIEW_UPSTREAM_PER_MINUTE`. Preserve network/object IDs, authentication
origin, trusted proxies, audit files/volumes and key configuration.

```bash
git fetch origin --tags
git switch --detach v2.0.9
cd webview
docker compose up --build -d
```

Use the installation's existing Compose project name and deployment method.
Only the Webview needs rebuilding/restarting. Do not restart or re-register
Oracle nodes as part of this upgrade. The previous environment migration guide
still applies to older installations:
https://github.com/sdellava/IOTA-Distributed-Oracle/blob/v2.0.8/docs/ENV_MIGRATION_v2.0.8.md

After upgrade, check checkpoint/state and schedule reads while historical metrics
show counting; test concurrent refreshes and network switching. Null historical
totals during bootstrap are expected. Publishing this release is not deployment.

## Verification and scope

All 80 automated tests pass: Webview 45, standalone client 12, node 23.
Full Webview/client TypeScript checks, frontend production build, node build and
`git diff --check` pass. Security controls are retained and their regression
suites remain green.

Regression fixtures cover large multi-batch histories, resumed cursors without
double counting, mutable-object generations, delayed/failing pages, malformed/
repeated cursors, in-flight sharing, cache/network isolation, low custom budgets
and frontend polling/labels. A complete status-service fixture holds historical
work pending/throttled while simultaneous operational requests and another
network continue returning checkpoints.

A read-only Testnet smoke of the candidate performed three refreshes in about
1.7–2.4 seconds each, without `UPSTREAM_CAPACITY` warnings and with bounded
background history requests. No transactions were signed or submitted. This
does not verify a deployed v2.0.9 installation.

Docker image/volume and browser-wallet end-to-end verification remain deployment
checks. The node manager's stale gas-coin reference/502 issue and our node's
committee eligibility are separate and are not changed by this fix.
