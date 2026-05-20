# Release Note - Direct One-Shot Tasks

This development branch adds a direct task creation path inside the existing
`oracle_tasks` package.

## Behavior

One-shot task creation now uses:

```move
oracle_tasks::create_and_submit_direct_task
```

The direct path creates the task, assigns nodes immediately, opens run `1`, and
emits `TaskRunSubmitted` without inserting the task in the scheduler registry.

Scheduled task creation still uses:

```move
oracle_tasks::create_task
```

The client and webview choose this scheduled path only when the requested task
has an interval and at least two effective runs. Those tasks remain managed by
task `0` and appear in the scheduled task registry.

## Client and webview impact

- `npm run create -- <task.json>` submits a direct one-shot task.
- The webview creates a direct task when "Interval (minutes)" is empty.
- The webview creates a scheduled task when an interval is set and the computed
  budget/end window covers at least two runs.
- Direct one-shot funding uses the normal task payment without the scheduler
  fee. Scheduled runs keep using the per-run amount that includes the scheduler
  fee.

## Compatibility

Existing scheduled tasks remain compatible with the scheduler flow. The new
entry point changes only task creation behavior for new one-shot submissions.
