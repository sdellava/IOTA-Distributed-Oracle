# v2.0.10 — Oracle daemon recovery and monitoring

## Changes

- Event listeners restart an ascending scan of retained history when an RPC rejects an existing cursor as missing, invalid or pruned. Recovery does not jump to the newest event. Timestamp watermarks and event IDs suppress already processed events during replay. Missing historical data cannot be reconstructed by the daemon.
- The public `/health` endpoint and authenticated `/status` now return HTTP 503 with `status: "degraded"` and `listenersDegraded: true` when event polling fails or has no successful response for 60 seconds (or ten polling intervals, whichever is larger). Empty successful polls count as healthy; recovery rescans remain degraded until caught up. Registration alone no longer guarantees a green health response.
- Transactions built through the daemon retry helper refresh gas references through `getObject` before each signing attempt. If the largest coin cannot cover the configured budget, SDK multi-coin selection is preserved.
- Transactions using the same signer are serialized inside one daemon process. This does not coordinate independent containers, CLI tools or other processes sharing a wallet. Use separate wallets for independent writers.

## Upgrade

Rebuild and restart the oracle daemon using the release sources through the normal deployment procedure. No new `.env` settings or private keys are required. Existing monitor authentication settings remain required for `/status`; `/health` remains public and returns only synthetic health information.

Monitoring clients must accept `degraded` as an unhealthy state and treat HTTP 503 as a failure. The additive `listenersDegraded` field is available on both endpoints. After restart, verify registration, listener recovery and a real task result; registration and scheduler transaction submission alone do not establish end-to-end processing.

This daemon fix is separate from the Webview upstream-capacity fix released in v2.0.9. It does not require changes to Move contracts or a new on-chain deployment.

## Validation

27 daemon tests passed, including cursor recovery and deduplication, listener failure/stall detection, public health degradation/recovery, fresh gas references and same-wallet serialization. TypeScript compilation passed. No live transaction or production daemon deployment was performed during these checks.
