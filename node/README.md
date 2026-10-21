# iota-oracle-node v3.1

Node runtime for the IOTA distributed oracle.

## Key update

`STORAGE` tasks are now **IPFS-only**:
- no local payload persistence
- no local manifest files
- no retention cleanup loop
- no `cleanup-expired-storage` CLI command

If `IPFS_ENABLED` is false, `STORAGE` task execution fails by design.

## Setup

```bash
npm install
cp .env.example .env
npm run build
```

## Start a node

```bash
npm run daemon -- --node 1
```

or:

```bash
npm run dev -- --node 1
```

## Test node configuration

Use the local test runner to validate the current node configuration against a sample task without starting the daemon:

```bash
npm run test -- src/tasks/examples/task_weather.json --node 1
```

You can also pass:

```bash
npm run test -- src/tasks/examples/task_IPFS_STORE1.json --node 1
npm run test -- "{\"type\":\"WEATHER\",...}" --node 1
```

The test output shows:
- resolved node id and node address
- accepted template ids loaded from `ORACLE_ACCEPTED_TEMPLATE_IDS`
- handler availability for the task type
- template policy validation result
- execution result preview and consensus numeric hints
- task-specific env checks such as `IPFS_ENABLED` and `IPFS_API_URL` for `STORAGE`

This is useful to verify node setup before running the daemon or troubleshooting a bad `.env`.
It validates local execution only: it does not prove on-chain assignment, registration, quorum, publish, or finalization.

The node now exposes a local monitoring endpoint by default:

```bash
curl http://127.0.0.1:9080/health
curl -H "Authorization: Bearer $MONITOR_AUTH_TOKEN" http://127.0.0.1:9080/status
```

`/health` returns `503` while boot is still in progress, then `200` once listeners are active.
The default listener is loopback only. `/health` exposes only process status,
`capabilitiesDegraded`, and the LLM/IPFS status strings. It performs no balance RPC call.
`/status` requires `Authorization: Bearer <MONITOR_AUTH_TOKEN>` even on localhost.
Configure a random token of at least 32 characters; without it, this endpoint
returns 503. Wrong or missing credentials return 401. Generate a token with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
and keep it out of task payloads, source control and public dashboards.

Authenticated status retains runtime details but replaces raw error strings
with stable error codes. Both routes send `Cache-Control: no-store`.
Compose explicitly listens on the container interface and publishes the monitor
only on host loopback. Do not expose it through a public reverse proxy; remote
management should use a protected network or authenticated TLS proxy.

On non-dev networks (`IOTA_NETWORK` not `dev`/`devnet`/`local`/`localnet`), registration is forced to `systemState::register_oracle_node` and requires a `systemState::DelegatedControllerCap` + signer key.
If `DELEGATED_CONTROLLER_CAP_ID` is not configured, node auto-detects an owned `systemState::DelegatedControllerCap` from the signer address.

## CLI commands

```bash
npm run cli -- accept-template-proposal --node 1 [--template-id 4]
npm run cli -- set-accepted-templates --node 1 --templates 1,2,3,4,5,6,7,8
```

## Node manager scripts

```bash
bash ./scripts/approve_template_interactive.sh --node 1
bash ./scripts/propose_template_from_json.sh --file src/tasks/examples/task_STORAGE.json --controller 0xYOUR_CONTROLLER_ADDRESS
bash ./scripts/update_supported_templates.sh --node 1
bash ./scripts/update_supported_templates.sh --node 1 --templates 1,2,3,4,5,6,7,8 --yes
bash ./scripts/list_templates.sh
bash ./scripts/list_templates.sh --pending
```

`update_supported_templates.sh` replaces the node's full accepted-template list on-chain and syncs `NODE_<id>_ORACLE_ACCEPTED_TEMPLATE_IDS`, `ORACLE_ACCEPTED_TEMPLATE_IDS`, and the network-specific accepted-template key in `.env` after a successful update.

## STORAGE task behavior

For `STORAGE` tasks, the node:
- resolves payload content (URL, base64, text, JSON)
- validates hashes/size constraints
- uploads bytes to IPFS
- returns deterministic canonical JSON including `ipfs_cid`, hash, mime type, size, and retention days

No local file is written.

## Required IPFS env

```env
IPFS_ENABLED=true
IPFS_API_URL=https://api-ipfs.objectid.io
IPFS_PIN=true
IPFS_CID_VERSION=1
```

Plus one auth method (bearer token, basic auth, or API key/secret).

## Docker

```bash
docker compose up --build -d
```

Compose now persists only:
- `./keys`

## Notes

- On-chain retention fields are still part of task economics/validation.
- Local retention lifecycle has been fully removed from node runtime.

## Task URL security

All task-controlled HTTP downloads (text, JSON, HTML, STORAGE, PDF and DID
linked-domain documents) use the mandatory task HTTP client. It accepts only
HTTP/HTTPS and GET/HEAD, rejects URL credentials and routing/connection headers,
and denies private, loopback, link-local, multicast and special-use addresses.
IPv6 is limited to native global unicast, excluding transition and documentation
ranges. DNS answers are checked and pinned to the connection. Every redirect is
revalidated, with at most five redirects; HTTPS-to-HTTP redirects are rejected.
Custom headers are discarded on cross-origin redirects. TLS certificate
verification remains enabled for task downloads even if legacy runtime TLS
overrides are set.

Downloads have a maximum 30-second total deadline and 25 MB streamed body limit
(including decompressed bytes). Task options can lower these ceilings but cannot
raise them. Failures return stable codes without response bodies or DNS details.
Non-GET/HEAD tasks and the legacy browser/IPv4 retry paths are no longer supported.
DLVC no longer falls back to a remote fetching proxy.

PDFs for the LLM Responses API are fetched through this client first and sent as
base64 file_data, never as a provider-fetched URL. Providers must support file_data.
Operator-configured LLM/IPFS endpoints remain separate and can be self-hosted;
their HTTP redirects are rejected. Their credentials are never added to task
downloads. Capability health checks remain mandatory.

Set TASK_HTTP_DENIED_HOSTS to a comma-separated list of additional domains to
block, including all their subdomains, for business services with public IPs.
This only adds restrictions. Network-level egress rules are still needed for
organization-specific public services and unusual routing/NAT configurations.
Keep oracle containers off shared management/database networks and permit only
the required connections to explicitly configured internal LLM/IPFS services.

Run offline regression checks with npm run test:security, then npm run build.
These checks do not start the daemon, containers or devnet, and do not call LLM,
IPFS or chain services. A devnet end-to-end validation remains a separate step.

Previously published task results may already exist on-chain or IPFS. This patch
does not delete them; inspect known incidents and rotate any exposed credentials.
