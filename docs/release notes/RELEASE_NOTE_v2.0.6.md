# Release Note - v2.0.6

Date: 2026-10-21

Security update: restrict task-controlled network requests and protect node
monitoring details. Node operators should update all instances. No Move contract
redeployment or on-chain migration is required for these runtime changes.

## Task request protection

- Task downloads share a mandatory HTTP client covering JSON, text, HTML,
  STORAGE, PDF, legacy downloads and DID linked-domain documents.
- Only HTTP/HTTPS and GET/HEAD are accepted. URL credentials and connection or
  routing headers are rejected.
- Private, loopback, link-local, multicast and special-use IP destinations are
  blocked, including IPv6 transition addresses and known cloud metadata routes.
- All DNS answers are checked, and validated addresses are pinned to the
  connection. Redirect destinations are revalidated; at most five redirects are
  followed. HTTPS-to-HTTP redirects are rejected.
- Caller headers are removed when redirecting to a different origin.
- TLS certificate checks are mandatory for task downloads, even when legacy
  runtime TLS overrides are configured.
- Downloads are capped at 30 seconds and 25 MB of streamed response content.
  Task parameters cannot raise these limits.
- HTTP failures return error codes, not upstream response bodies or DNS details.
- LLM PDF requests now send locally validated file_data rather than delegating
  URL downloads to the model provider. The provider must support file_data.
- The remote DLVC fetching proxy fallback and legacy STORAGE retry paths have
  been removed. Operator-configured LLM/IPFS endpoints reject HTTP redirects;
  configure their final API URL directly. Self-hosted endpoints remain supported.

## Monitoring changes and required configuration

The unauthenticated /health endpoint now returns only node status,
capabilitiesDegraded and LLM/IPFS status strings. It does not return wallet,
registration, template lists, raw errors, or balance information.

The /status endpoint requires a Bearer token, including on localhost. Generate a
random token using Node.js:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set the generated value in node/.env:

```env
MONITOR_AUTH_TOKEN=<generated-token>
```

At least 32 characters are required. Use a separate secret per node where
possible; NODE_<id>_MONITOR_AUTH_TOKEN supports node-scoped configuration.
Keep tokens out of source control, task payloads, public dashboards and tickets.
Update monitoring clients to send:

```http
Authorization: Bearer <generated-token>
```

Without a configured token, /status returns 503. Missing or incorrect credentials
return 401. Authenticated responses retain runtime details but replace raw error
messages with stable codes. /health keeps the existing booting 503 / ready 200
semantics. A capability failure alone does not change the HTTP readiness code.
Both endpoints send Cache-Control: no-store.

Native processes bind to loopback by default. The supplied Compose files bind
inside the container and publish monitor ports only on host loopback. Remote
monitoring requires a protected connection, such as an SSH tunnel or an
authenticated TLS management proxy. Review any existing NODE_<id>_MONITOR_HOST
and NODE_<id>_MONITOR_PORT overrides when using Compose.

## Upgrade procedure

Back up node/.env and node/keys and preserve local configuration changes. From a
clean checkout at the repository root, fetch and select the release:

```bash
git fetch origin --tags
git switch --detach v2.0.6
```

Configure MONITOR_AUTH_TOKEN before restarting. Do not replace an existing .env
with .env.example. Then rebuild/restart the node with the existing deployment
procedure. For the supplied single-node Docker deployment:

```bash
cd node
docker compose up --build -d
```

For installations using the devnet Compose file, use that same file explicitly
and retain the existing project name and key volumes. This release does not
require deploying or switching to devnet.

After restart, check /health and query /status with the token. Update dashboards
that previously read detailed information from /health. Check that valid public
URL tasks still complete and that private destinations fail with TASK_* codes.
For native deployments, run npm ci and npm run build in node/, then restart
using the installation's existing service manager.

## Deployment boundaries

LLM/IPFS capability checks remain mandatory. Their frequency is unchanged.
The monitor token is an access secret, not an IOTA token or a wallet key.

TASK_HTTP_DENIED_HOSTS can add comma-separated domain exclusions (including
subdomains) for company services with public IP addresses. It cannot disable the
mandatory IP restrictions. Maintain network-level egress filtering and isolate
oracle containers from management/database networks; allow only the necessary
connections to configured internal backend services. This patch does not apply
firewall rules to deployed hosts.

Already published results are not deleted from the chain or IPFS. Review known
exposures and rotate any credentials that were disclosed.

## Verification

- npm run test:security: 22 offline regression tests passed.
- npm run build: TypeScript compilation passed.
- git diff --check: passed.

No daemon, Docker test environment, or devnet deployment was started for these
checks. No chain transactions or paid provider requests were made. Devnet
end-to-end verification remains outstanding.

Repository release tags and the node package's existing internal version are
separate; this release does not renumber the internal 3.1.0 package version.
