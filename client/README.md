# iota_oracle_client

Creates oracle Tasks on IOTA devnet against the current multi-module package `oracle_tasks + oracle_task_config + oracle_task_runtime + oracle_task_store`.

## Setup

```bash
npm i
cp .env.example .env
```

## Create a task

```bash
npm run create -- examples/task_weather.json
```

or:

```bash
npm run create -- examples/task_storage.json
```

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

The wallet/webview schedule preparation chooses between the two Move entries automatically:

- no interval, or an interval/end pair that only represents one run: use `create_and_submit_direct_task`;
- interval with at least two effective runs: use `create_task` so task `0` can schedule each run.

## Notes for the current Move version

- `create_task` now writes `Task`, `TaskConfig` and `TaskRuntime` separately
- the client reads `retention_days`, `declared_download_bytes`, `mediation_mode` and runtime mediation fields from those companion objects
- the client computes STORAGE payment including extra download bytes above the template included quota
- the task creation event is now `TaskLifecycleEvent` with `kind=1`

Required envs: `ORACLE_TASKS_PACKAGE_ID`, `ORACLE_SYSTEM_PACKAGE_ID`, `ORACLE_STATE_ID`, `ORACLE_TREASURY_ID`, `IOTA_RANDOM_OBJECT_ID`, `IOTA_CLOCK_ID`.
