# v2.0.8 — Availability limits, configurable destinations and persistent audit

Release date: 30 October 2026. This release builds on v2.0.7 wallet authentication,
removal of the obsolete server-signing endpoint and STORAGE SSRF protections.
No Move package deployment or internal package-version renumbering is required.
Publishing the release does not update any running installation.

## Availability controls

Public API GET/HEAD reads now have per-IP rate and concurrency limits, with a
global concurrency cap. Synthetic health checks stay available. SSE connections
have per-IP/global limits, a finite lifetime, reconnect guidance and slow-client
closure. An aborted HTTP connection does not release its slot while underlying
work is still running.

Webview-process RPC, GraphQL, market-data and EULA fetches use actual transport
abort deadlines through body consumption, response-size bounds and shared
request/concurrency budgets. Existing client-preparation subprocess limits stay
separate. All application limits work without Traefik and are per process;
multiple replicas require distributed controls for cluster-wide guarantees.

Default settings:

| Setting | Default |
|---|---:|
| API reads per minute/IP | 240 |
| Concurrent reads per IP / globally | 8 / 64 |
| SSE connections per IP / globally | 4 / 64 |
| SSE maximum lifetime | 300,000 ms |
| Webview upstream request timeout | 15,000 ms |
| Webview upstream concurrency / requests per minute | 32 / 1,200 |
| Webview upstream response bytes | 10,000,000 |

The [environment migration guide](https://github.com/sdellava/IOTA-Distributed-Oracle/blob/v2.0.8/docs/ENV_MIGRATION_v2.0.8.md) lists exact variable
names, defaults, proxy settings and upgrade checks. Invalid limits fail startup.

## Optional task destination allowlists

Node and client task HTTP transports now support `TASK_HTTP_ALLOWED_HOSTS` and
`TASK_HTTP_ALLOWED_PORTS`. Empty lists preserve existing public-source behavior.
Exact names match only that host; `*.example.com` matches subdomains only. Every
redirect destination must match. Existing denied-host settings take precedence.

The mandatory public IPv4/IPv6 policy, all-answer DNS validation, DNS pinning,
redirect revalidation, header restrictions and HTTPS downgrade prevention remain
in force. An allowlist cannot enable private/internal destinations. Explicit
Webview policy overrides client subprocess defaults.

Apply the policy to executing nodes as well as the Webview. These settings cover
task-controlled HTTP sources, not operator-configured infrastructure endpoints,
and do not install firewall rules.

## Persistent audit file

Audit events are text records containing one JSON object per line. They record
request ID, timestamp, normalized route, result/status, duration, pseudonymous
client identifier and verified wallet/network when available. They omit tokens,
signatures, challenge/session values, request bodies, task contents, query
strings and task identifiers in paths. Health checks are omitted to reduce noise.
Raw child output is no longer copied into preparation-failure logs; internal and
stream errors use controlled codes.

```dotenv
WEBVIEW_AUDIT_ENABLED=true
WEBVIEW_AUDIT_FILE=./logs/audit.log
WEBVIEW_AUDIT_MAX_FILE_MB=10
WEBVIEW_AUDIT_MAX_FILES=5
WEBVIEW_AUDIT_STDOUT=true
WEBVIEW_AUDIT_IP_SALT=
```

File count includes the current file: defaults retain at most five 10-MB files,
about 50 MB total. Rotation deletes the oldest archive before exceeding the
budget and preserves complete JSON records. Restart and changed retention limits
are handled; lowering limits can remove older over-budget files.

The supplied Compose mounts `webview_audit` persistently at
`/workspace/webview/logs`. A custom path requires its own persistent directory.
Use one writer per file. Normal stdout mirroring is optional; disk/permission
failures fall back to stdout with throttled warnings, without failing the API.
Partial failed writes are rolled back before retry. Files with multiple hard
links and nonregular files are rejected. Audit files are excluded from Git and
Docker build context.

The separate Docker stdout copy has its own five-by-10-MB rotation budget; it is
additional storage. Size limits do not guarantee a retention period in days.
The local `webview/scripts/audit-report.mjs` tool summarizes copied files or
Docker exports. It does not recover missing historical events, prove absence of
abuse or replace on-chain investigation.

## Authorization and compatibility

Resource roles, ownership and capabilities remain definitively enforced by Move
when a transaction is submitted. No duplicate API ownership policy is added.
API wallet/network binding, personal-message authentication and separate explicit
transaction signing from v2.0.7 remain unchanged. Independent CLI submissions
still use their own keys; Webview signing keys are not reintroduced.

Public dashboard reads remain public within the new limits. New quotas can return
429; upstream saturation/timeout can prevent a read from completing. Tune the
bounded settings to the intended workload and configure trusted proxy IPs/CIDRs
explicitly. Do not blindly trust client-supplied forwarded headers.

## Upgrade and .env migration

Follow the [step-by-step .env migration guide](https://github.com/sdellava/IOTA-Distributed-Oracle/blob/v2.0.8/docs/ENV_MIGRATION_v2.0.8.md).
Back up and merge existing `.env` values rather than replacing them with examples.
Preserve real network/object/package IDs and node/standalone-client keys. Set the
canonical external origin for wallet authentication and choose the task provider
allowlists only if desired.

Export old logs before recreating containers. Remove Webview-only signing
credentials, mounts and old copies as described in the guide; inspect old images
and backups and rotate exposed credentials. This release does not delete deployed
keys, rotate credentials or perform a historical incident audit.

```bash
git fetch origin --tags
git switch --detach v2.0.8
cd webview
docker compose up --build -d
```

Use the existing Compose project/network and retain identity and audit volumes.
For native deployments, keep the established service-management procedure.
For rollback, keep anonymous operational endpoints and server signing blocked;
do not reintroduce pre-v2.0.7 behavior.

## Verification

- 70 passing security/regression tests: Webview 35, client 12, node 23.
- Full Webview/client TypeScript checks, frontend production build and node build.
- SSRF/public-IP enforcement, unsafe DNS answers, DNS pinning, redirect rules,
  allowlists/ports, routing headers, timeouts and legitimate public-source controls.
- Real personal-message authentication, wrong signer/message/intent rejection,
  replay, expiry, logout, wallet/network/origin/service binding, route aliases,
  headless-client login and frontend session lifecycle.
- Read/SSE admission, aborted-request slot retention, upstream concurrency/rate,
  body-size limits and native abort of a stalled response body.
- Audit redaction, UTF-8 byte boundaries, rotation/oldest-file deletion, restart,
  lower retention, disabled logging, failure/recovery, partial-write rollback,
  hard-link rejection and log-summary parsing.
- Actual application SSE smoke with delayed local RPC and HTTP-to-audit-file smoke.
- Compose YAML/logging/persistent-volume checks and `git diff --check`.

Tests use local fixtures and do not submit on-chain transactions or call paid
providers. Docker is unavailable in the verification environment: actual image
build/layer inspection, Docker-volume/rotation behavior, production deployment,
old-key cleanup, historical audit and partner retesting remain operator tasks.

See [operational details and updated scope](https://github.com/sdellava/IOTA-Distributed-Oracle/blob/v2.0.8/docs/SECURITY_OPERATIONS.md).
