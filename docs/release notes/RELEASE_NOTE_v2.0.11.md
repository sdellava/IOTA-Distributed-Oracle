# v2.0.11 — RPC consistency and durable daemon recovery

This release addresses stale reads and event-cursor failures exposed by the Testnet RPC upgrade. It does not use a 15-second alert grace period: polling errors and recovery states remain immediately visible.

## Changes

- Transactions are built, signed, submitted and checked on one selected RPC client. Endpoint rotation occurs between operations, not midway through signing/submission. A load-balanced URL may still route requests to different backend servers.
- Transaction effects are checked for success. Successful submissions without a checkpoint are polled until checkpointed, with a bounded timeout. A digest alone is no longer treated as proof of success.
- Subsequent object reads enforce minimum versions obtained from transaction effects and previous reads. Stale snapshots are retried at 250 ms intervals for up to eight attempts, then fail explicitly. Version floors are shared across configured RPC endpoints in the daemon process; the latest transaction effects are restored from the wallet journal after restart.
- Gas selection refreshes object references and balances directly, including when multiple coins are needed. Same-wallet writes remain serialized within one process.
- Before submission, the daemon records the transaction digest and operation fingerprint in a private atomic journal. If a response is lost or indexing times out, later calls first resolve that digest. They cannot submit a new transaction while its outcome remains unknown. A recovered result is returned only to the matching operation.
- Event cursors, the original replay boundary and successful processing receipts persist across container recreation. Missing cursors trigger a scan of retained history. Durable event IDs suppress duplicate delivery, including across restarts, without discarding late-indexed events merely because their timestamps are older.
- A failed event handler does not advance the cursor past that event. Explicit pruning errors persist as `historyGap` and keep health degraded; successful empty reads cannot hide a known historical gap.
- Public `/health` and authenticated `/status` expose synthetic per-listener diagnostics: state, last successful read, read age, failure duration, failed-read count and known history gaps. Provider errors and endpoint URLs are not exposed. Recovery or polling failures cause immediate HTTP 503; stalled reads are detected after 60 seconds or ten polling intervals, whichever is longer.
- Docker build contexts exclude `.env` files and wallet keys.

## Upgrade and storage

Rebuild and restart the daemon with the updated Compose file. It adds the named `oracle_node_state` volume at `/app/storage`. No new environment variables, keys or Move contract deployment are required. Custom deployments must preserve `STORAGE_DIR` across restarts. Keep a single daemon writer per node/wallet; separate processes sharing a wallet are not coordinated by the process-local queue.

Event receipts accumulate for replay deduplication. Preserve them together with their checkpoint files and monitor volume usage; this release does not automatically prune them. Deleting journals or receipts can cause replay or duplicate submissions and must not be used to silence alerts.

If a submitted digest cannot be found on any configured RPC, the daemon fails closed. Investigate that digest and the journal before any manual reset. Historical data removed by providers requires an archival RPC and operator reconciliation; the daemon cannot reconstruct unavailable events. A known history-gap flag requires investigation and deliberate checkpoint reconciliation.

Handlers must remain idempotent: a crash between an external side effect and writing its receipt can replay the handler. Processing receipts cannot guarantee exactly-once external effects. Polling health does not prove that a real task completed.

## Validation

36 daemon tests and TypeScript compilation passed. Coverage includes stale object versions, permanently stale backends, pinned submission clients, lost-response recovery without duplicate submission, on-chain failures, restart recovery, late-indexed events, handler failures, explicit pruning and health diagnostics, plus existing security regressions. Live deployment and end-to-end checks are reported separately.
