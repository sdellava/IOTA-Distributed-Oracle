# Release Note

## Overview

This release describes the capabilities introduced by the current `scheduler-v2` branch compared with `main`, which is intended to be replaced by this version.

The branch has continued to evolve after the first draft of this note. In addition to the original scheduler and node-management work, it now includes the latest updates around scheduled task cancellation/deletion, richer lifecycle handling, wallet-based schedule controls, and several frontend/backend refinements.

This update represents a major evolution of the IOTA Distributed Oracle platform and introduces five main areas of progress:

- support for on-chain scheduled tasks;
- direct node and proposal management from the interface;
- full wallet-driven control of scheduled tasks, including cancellation/deletion flows;
- expanded application capabilities with new LLM tasks and supporting backend endpoints;
- operational and network packaging improvements for devnet and testnet.

## Key Enhancements

### 1. On-chain task scheduling

The most significant addition in this release is a full on-chain scheduling system for recurring task execution.

Specifically, this release adds:

- new Move modules for scheduled tasks (`oracle_scheduled_tasks.move`);
- a shared scheduler queue across nodes with processing rounds and handover logic;
- support for scheduled task states such as `ACTIVE`, `SUSPENDED`, `DEPLETED`, `CANCELLED`, `ENDED`, and `COMPLETED`;
- dedicated balance funding for scheduled tasks;
- tracking for `start`, `end`, `interval`, `next run`, `last run`, `inactive since`, and the last scheduler node that processed the task;
- dedicated on-chain events for creation, funding, depletion, suspension, reactivation, completion, deletion, and queue progression.

On the node side, the release introduces:

- a dedicated scheduler handler;
- scheduler state reading and due-task discovery;
- workers and services for scheduling rounds, queue reconciliation, and execution submission;
- watchdog logic to abort runs that remain open for too long;
- transaction updates so node-side finalization remains aligned with the evolved Move entrypoints.

Result: the system is no longer limited to manual or event-driven execution, and can now orchestrate recurring tasks natively.

### 2. Scheduled task lifecycle, cancellation, and deletion

Since the first version of this release note, the scheduled-task lifecycle has been extended significantly.

New behavior now includes:

- explicit differentiation between `DEPLETED`, `ENDED`, and `COMPLETED` tasks;
- automatic transition to `DEPLETED` when a scheduled execution cannot proceed because the task balance is not sufficient;
- `TaskDepleted`, `TaskCompleted`, and richer `TaskFunded` events with post-action status details;
- top-up logic that can restore a depleted task and reconcile its status back into the active scheduling flow when appropriate;
- support for reactivation of suspended or depleted tasks;
- support for suspension of tasks that are active, ended, or depleted when an operator needs to stop them explicitly;
- support for deleting scheduled tasks once they are in a terminal/manually stopped state, including the latest fix that enables deletion for completed tasks rather than only suspended ones.

Operationally, this matters because task cancellation is no longer just a UI concern. The branch now models the difference between:

- a task that is manually suspended;
- a task that naturally reached the end of its schedule;
- a task that completed all its planned executions;
- a task that stopped because funds ran out.

This improves both operator control and on-chain observability.

### 3. Scheduled task UI and wallet controls

The webview now includes a dedicated experience for scheduled tasks, and that experience has grown beyond simple listing.

New additions include:

- a `Task Schedules` page;
- retrieval of existing schedules from the backend;
- visibility into status, interval, time windows, executed runs, available balance, and last scheduler;
- wallet actions for `Suspend`, `Restart`, `Delete`, and `Add funds`;
- automatic detection of owner caps and delegated controller caps to determine which actions the connected wallet can perform;
- support for controller-cap based management by supervisors and owner-based management by task creators;
- UI handling for the newer task states (`DEPLETED`, `COMPLETED`, `ENDED`) so actions are shown only when valid for the current lifecycle phase.

On the API/client side, this release also adds:

- a dedicated webview preparation flow for scheduled-task wallet actions;
- server endpoints to prepare schedule-control transactions;
- transaction building for schedule management actions, including the latest alignment of the funding action with registry and clock requirements.

This significantly improves usability for demos, operations, and troubleshooting, and turns the webview into a real operator console for scheduled tasks.

### 4. Node management and template governance

The webview now includes a dedicated node administration area.

New capabilities include:

- a dedicated `Node Management` page;
- updating the templates supported by each node;
- support for enabling the scheduler role through a dedicated template;
- viewing and approving template proposals;
- wallet integration for signed on-chain management actions.

Recent UI refinements also improved the reliability of this page:

- template checkbox selections are no longer unintentionally reset by periodic UI refreshes while an operator is still editing the node configuration;
- local selection state now remains stable until the operator saves or the on-chain state genuinely changes.

This makes node operations much easier to manage without relying exclusively on scripts or CLI workflows.

### 5. New LLM Open Question task

A new `LLM_OPEN_QUESTION` handler has been added, together with related examples in the node, client, and webview layers.

This task:

- accepts an open-ended question;
- builds a deterministic prompt;
- requires canonical JSON output;
- is designed for use cases where a short, current answer is needed.

This extends the existing LLM template catalog and enables more flexible use cases.

### 6. Backend, validation, and operational tooling improvements

This release also strengthens the surrounding application infrastructure:

- new server services for `taskSchedules`, `scheduledTasks`, `nodeManagement`, `oracleClient`, `oracleStatus`, and market data;
- expanded task inspection and validation routes in the webview backend, including task snapshot/event streaming support;
- updates to the task validator and task-detail views so newer status/event information is surfaced consistently;
- updates to `.env` configurations and devnet/testnet examples;
- new scripts for testnet deployment, node registration, validator-cap minting, and environment updates;
- packaging and folder reorganization for testnet Move projects;
- addition of EULA/Terms content in the webview.

## Platform impact

With this release, the platform moves from a model focused mainly on oracle task execution to a more complete operating model that includes:

- recurring task orchestration;
- explicit lifecycle management for scheduled tasks;
- wallet-driven suspension, restart, funding, and deletion of scheduled tasks;
- operational node control;
- greater autonomy through the frontend;
- a broader set of supported templates.

In practical terms, the version intended to replace `main` is much closer to a complete operational console than to a simple task testing environment.

## Areas affected

The changes span all major blocks of the project:

- `iota_oracle_move`
- `iota_oracle_node`
- `iota_oracle_webview`
- `iota_oracle_client`

The delta versus `main` is substantial: `176` files changed, with approximately `20,427` lines added and `3,282` lines removed on the committed branch. The current working tree also contains a few further in-progress updates on top of that baseline.

## Operational note

The branch also contains some generated files, environment updates, and a few conflict-derived snapshot copies. These do not change the functional message of the release note, but they should still be reviewed for cleanup before definitively replacing `main`.

## v2.0.3 scheduler refinement

After the scheduler-v2 merge, release `v2.0.3` refines the runtime behavior of scheduler task `0`.

The scheduler now calls `systemState::prune_oracle_nodes_if_epoch_changed` only when the node owns the scheduler turn, meaning it is the current scheduler queue head or has successfully taken over from a timed-out head node. Non-head scheduler nodes still inspect the queue so they can detect takeover eligibility, but they no longer submit the validator-committee prune transaction before it is their turn.

The empty-turn path has also been tightened. When the current scheduler node finds no due tasks, it advances the scheduler queue and returns without opening and closing an empty scheduler round. This avoids unnecessary `start_scheduler_round` and `complete_scheduler_round` transactions when there is no task to assign.

Release `v2.0.3` also removes the unused devnet `oracle_tasks_legacy.move` module and an obsolete devnet publish report that had been kept under the testnet task package.

## Executive summary

`scheduler-v2` no longer just introduces on-chain scheduling. It now delivers a broader operational model: scheduled task creation, lifecycle tracking, balance-aware execution, task suspension/restart/deletion, node governance from the webview, and a new `LLM_OPEN_QUESTION` capability. Compared with `main`, this is a structural release that materially expands automation, governance, and day-to-day operability across Move, node, client, and webview layers.
