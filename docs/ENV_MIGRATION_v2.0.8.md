# Environment migration guide — v2.0.8

This guide covers upgrades from v2.0.7 and earlier releases. Merge the settings
below into existing configuration. **Do not replace your `.env` with an example
file:** preserve the correct network, package/object IDs, provider settings and
node/client identity configuration. Back up configuration securely first.

## 1. Webview configuration

Update `webview/.env` or the equivalent service/container environment. These
settings do not require wallet private keys in the Webview.

```dotenv
# Set the actual external HTTPS origin, without a path.
WEBVIEW_PUBLIC_ORIGIN=https://oracle.example.com
# Leave empty for same-origin browser access only.
WEBVIEW_ALLOWED_ORIGINS=
# Only exact trusted reverse-proxy IPs/CIDRs; empty trusts no forwarded IPs.
WEBVIEW_TRUSTED_PROXIES=

# Public API reads: health is exempt; authentication/preparation retain v2.0.7 limits.
WEBVIEW_READS_PER_MINUTE=240
WEBVIEW_READ_CONCURRENCY_PER_IP=8
WEBVIEW_READ_CONCURRENCY=64
WEBVIEW_STREAMS_PER_IP=4
WEBVIEW_STREAMS=64
WEBVIEW_STREAM_MAX_AGE_MS=300000

# Webview-process RPC/GraphQL/market/EULA transport budgets.
WEBVIEW_UPSTREAM_TIMEOUT_MS=15000
WEBVIEW_UPSTREAM_CONCURRENCY=32
WEBVIEW_UPSTREAM_PER_MINUTE=1200
WEBVIEW_UPSTREAM_MAX_BYTES=10000000

# Text file containing one JSON audit event per line.
WEBVIEW_AUDIT_ENABLED=true
WEBVIEW_AUDIT_FILE=./logs/audit.log
WEBVIEW_AUDIT_MAX_FILE_MB=10
WEBVIEW_AUDIT_MAX_FILES=5
WEBVIEW_AUDIT_STDOUT=true
# Optional stable random server-side salt for correlating pseudonymous IPs across restarts.
WEBVIEW_AUDIT_IP_SALT=

# Optional restrictions for task-controlled HTTP sources.
TASK_HTTP_ALLOWED_HOSTS=
TASK_HTTP_ALLOWED_PORTS=
# Existing optional denial list, if required.
TASK_HTTP_DENIED_HOSTS=
```

Replace `https://oracle.example.com` with your real origin. Do not use this
example literally. For native local development, use the actual browser origin
or leave the setting empty so the preserved development-proxy Host is used.

Limits must be positive integers; invalid values fail startup rather than
silently removing a bound. `WEBVIEW_AUDIT_ENABLED` and `WEBVIEW_AUDIT_STDOUT`
accept `true` or `false`. The size budget uses decimal MB (1 MB = 1,000,000 bytes).
All quotas are per process; NAT/proxy users share IP limits unless the actual
trusted proxy is configured correctly. Multiple replicas need coherent routing
and shared/distributed controls for cluster-wide guarantees.

## 2. Task destination restrictions in Webview, nodes and standalone clients

The empty allowlists preserve public HTTP/HTTPS source support. If a restricted
set of storage/data providers is intended, configure, for example:

```dotenv
TASK_HTTP_ALLOWED_HOSTS=storage.example.com,*.data.example.com
TASK_HTTP_ALLOWED_PORTS=80,443
```

Use actual provider hostnames. An exact name does not include subdomains;
`*.data.example.com` matches subdomains but not `data.example.com` itself. Include
all required redirect destinations. Denied hosts take precedence. Private and
special IP ranges remain forbidden even if a name is allowlisted, with DNS
validation/pinning and redirect checks still applied. HTTPS downgrade is blocked.

Apply the intended policy to **both** `webview/.env` and each executing node's
`node/.env`. For independent direct submissions or local preparation, configure
`client/.env` as appropriate. Explicit Webview environment policy overrides
client subprocess defaults. These variables do not restrict operator-configured
RPC, GraphQL, IPFS, EULA or provider endpoints and do not install a host/container
egress firewall.

## 3. Persistent audit storage and rotation

The default `./logs/audit.log` is relative to the Webview working directory. The
supplied Compose file mounts named volume `webview_audit` at
`/workspace/webview/logs`; the default relative file path therefore persists
across container recreation. With a custom file path, add a persistent mount for
its directory. For native operation, ensure the service account can write there.
Never put audit files inside the publicly served `dist` directory.

`WEBVIEW_AUDIT_MAX_FILES=5` includes the current file: `audit.log`, `audit.log.1`
through `audit.log.4`. Before a record would exceed 10 MB, the logger rotates the
file and removes the oldest archive. The managed audit files consume at most
about 50 MB with these settings. Lowering budgets may remove older files that
exceed the new limits; export evidence before changing retention.

`WEBVIEW_AUDIT_STDOUT=true` keeps a separate Docker-log copy. Its Docker rotation
is independently limited to five 10-MB files, so its storage is additional to
the audit-file budget. Setting it to false disables normal mirroring, but file
errors still send events to stdout and emit a throttled warning. Disabling
`WEBVIEW_AUDIT_ENABLED` disables both audit sinks.

Use one process per audit file; give separate replicas their own paths/volumes
or collect centrally. Do not run another rotation tool on the same file. The
audit writer rejects nonregular files and hard links. This is a bounded local
record, not a tamper-proof ledger or a guarantee of retention in days.

Export existing Docker logs before recreating old containers or changing drivers:

```bash
docker logs --timestamps webview > webview-before-upgrade.log 2>&1
```

Keep the audit volume during upgrades. Deleting that volume deletes the saved
files. The release does not remove existing deployed logs or keys automatically.

## 4. Remove obsolete Webview signing credentials

If upgrading from before v2.0.7, remove Webview-only `CLIENT_KEY_FILE`, private
keys, mnemonics, wallet mounts and generated signing-key files from the Webview
environment/container. Review old image layers, backups and exported archives;
rotate credentials if they were exposed. Check network-prefixed/local aliases.

Do not remove node identity, validator keys, delegated capability object IDs or
independent CLI keys. `CLIENT_KEY_FILE` remains valid in the standalone client.
`EULA_SOURCE_TOKEN` is unrelated to wallet signing and may still be required for
private-repository access; keep it server-side. Never put secrets in `VITE_*`.

## 5. Rebuild and restart using the existing deployment method

```bash
git fetch origin --tags
git switch --detach v2.0.8
cd webview
docker compose up --build -d
```

Preserve your existing Compose project name, deployment network and identity
volumes. BuildKit is required for the existing frontend `.env` build-secret
mount. Native deployments should install dependencies with `npm ci` in their
respective packages and restart using their existing service manager. If nodes
need the new task allowlist, update and rebuild/restart them with their existing
node deployment procedure and preserved key volumes.

## 6. Post-upgrade checks

- `/api/health` remains public. Dashboard reads remain available within limits.
- Anonymous POST preparation requests return 401; `/api/tasks/execute` returns
  404 even with an authenticated session.
- Authenticate with a real wallet or the noninteractive `auth:webview` client;
  check task preparation on the intended network without spending real gas.
- Check SSE reconnects, quota responses (429), upstream budgets and actual proxy
  client-IP behavior for your expected workload.
- Make one ordinary API request and verify a new JSON record is written to the
  configured audit file. Check permissions and volume persistence, plus rotation
  using a disposable test instance rather than filling production logs.
- Analyze a copied file with `node webview/scripts/audit-report.mjs <file>`.
  Include rotated archives when assessing a full period. Absence of old events
  does not establish absence of abuse; historical investigation also needs the
  old signer address and its on-chain transactions/funding.

Docker image build/layer inspection, live installation cleanup and external
partner retesting remain operator tasks; publishing this release is not deployment.
