# iota_oracle_client

Creates oracle Tasks on IOTA devnet against the current multi-module package `oracle_tasks + oracle_task_config + oracle_task_runtime + oracle_task_store`.

## Setup

```bash
npm i
cp .env.example .env
```

## Create a direct one-shot task

```bash
npm run create -- examples/task_weather.json
```

This signs and executes the transaction with the local client key and uses:

```move
oracle_tasks::create_and_submit_direct_task
```

Use this path when the task must run once immediately. The task is created,
assigned to registered nodes, and submitted for execution in the same
transaction. It does not enter the scheduler queue and it does not pay the
scheduler fee.

Other task examples can be submitted in the same way:

```bash
npm run create -- examples/task_storage.json
npm run create -- examples/task_price_feed.json
```

## Prepare a scheduled task

Scheduled tasks use:

```move
oracle_tasks::create_task
```

Use this path when the task must run more than once. The task is funded up
front, stored in the task registry, and later processed by scheduler task `0`.
Each scheduled run consumes the normal task payment plus the template scheduler
fee.

The client exposes the same transaction-preparation flow used by the webview.
Use future, minute-aligned timestamps for `startAt` and `endAt`:

```bash
npm run create -- prepare-task-schedule-webview examples/task_weather.json '{"startAt":"2030-01-01T12:00:00.000Z","endAt":"2030-01-01T12:05:00.000Z","interval_ms":300000,"initial_funds_iota":10}' 0xYOUR_WALLET_ADDRESS
```

Equivalent schedule JSON file:

```json
{
  "startAt": "2030-01-01T12:00:00.000Z",
  "endAt": "2030-01-01T12:05:00.000Z",
  "interval_ms": 300000,
  "initial_funds_iota": 10
}
```

Then call:

```bash
npm run create -- prepare-task-schedule-webview examples/task_weather.json examples/schedule_5m_two_runs.json 0xYOUR_WALLET_ADDRESS
```

The command prints a JSON payload containing `serializedTransaction`,
`executionMode`, `targetFunction`, `requiredPayment`, `requiredPerRun` and
`estimatedRuns`. The wallet/webview signs and submits that serialized
transaction.

If `interval_ms` is `0`, missing, or does not represent at least two effective
runs, the prepared transaction falls back to `create_and_submit_direct_task`.
For a real scheduled task, use an interval of at least `300000` ms and an end
time that allows two or more runs.

## Required task JSON fields

The client expects at least:

- `template_id`
- `type`
- `requested_nodes` or legacy `nodes`

For `STORAGE` tasks it also expects:

- `retention_days`
- `source.url`
- optional `declared_download_bytes`

If `declared_download_bytes` is omitted for `STORAGE`, the client probes the source URL and computes it before submitting the task.

## Direct one-shot vs scheduled runs

The default client create command submits a one-shot task through:

```move
oracle_tasks::create_and_submit_direct_task
```

This creates the task, assigns registered nodes immediately, and emits the first run without adding the task to the scheduler registry.

The wallet/webview schedule preparation chooses between the two Move entries
automatically:

- no interval, `interval_ms = 0`, or an interval/end pair that only represents
  one run: use `create_and_submit_direct_task`;
- interval with at least two effective runs: use `create_task` so task `0` can
  schedule each run.

## Notes for the current Move version

- `create_task` now writes `Task`, `TaskConfig` and `TaskRuntime` separately
- the client reads `retention_days`, `declared_download_bytes`, `mediation_mode` and runtime mediation fields from those companion objects
- the client computes STORAGE payment including extra download bytes above the template included quota
- the task creation event is now `TaskLifecycleEvent` with `kind=1`

Required envs: `ORACLE_TASKS_PACKAGE_ID`, `ORACLE_SYSTEM_PACKAGE_ID`, `ORACLE_STATE_ID`, `ORACLE_TREASURY_ID`, `IOTA_RANDOM_OBJECT_ID`, `IOTA_CLOCK_ID`.

## Authenticated Webview API client

The direct CLI submission above is independent of the Webview and unchanged.
If you use the Webview preparation API instead, obtain a short-lived session:

```bash
npm run auth:webview -- https://oracle.example.com testnet
```

The command signs a personal message with the local client key and returns a
bearer session as JSON; it does not send the key or a blockchain transaction.
Protect the printed token as a credential. See
[Webview API authentication](../docs/WEBVIEW_API_AUTHENTICATION.md) for request
format, renewal, limits and the reusable `authenticateWebview` helper.
