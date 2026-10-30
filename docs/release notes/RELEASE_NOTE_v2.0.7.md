# v2.0.7 — Webview signing removal and STORAGE SSRF protection

Prepared 2026-10-30. These notes describe the source changes; deployment is a
separate operator action. No Move package update is required.

## Changes

- Added wallet personal-message authentication for the five preparation routes
  and POST network configuration. Challenges are single-use and expire in two
  minutes; opaque sessions expire in 15 minutes and bind wallet, network, service
  and browser origin. Invalid signatures, replay, expiry and mismatches fail
  before preparation work.
- Integrated browser authentication on first preparation, memory-only session
  caching and renewal. Added `client` command `npm run auth:webview -- <url> [network]`
  for noninteractive API clients signing with their own local key.
- Added bounded authentication/session stores, IP and wallet preparation quotas,
  and a global four-child preparation limit. Quotas and sessions are per process.
- Network selection is now per client/request; no public or authenticated request
  changes the server-wide default. Dashboard network switching stays public.
- Aligned checked-in backend JavaScript with maintained TypeScript so both
  entrypoints enforce the same controls. Fixed the existing nullable nodeId type
  annotation to match runtime handling and allow the full Webview type check.

- Removed the obsolete `POST /api/tasks/execute` endpoint, server signing runner,
  unused frontend wrapper and response type. The removed endpoint returns 404.
- Immediate and scheduled task creation in the Webview still uses the connected
  user's wallet. Standalone `client/` submission with its own wallet is retained.
- Webview preparation children receive public configuration only, cannot reload
  the client `.env`, and explicitly reject loading or generating a wallet identity.
- STORAGE size detection now validates public IPv4/IPv6 destinations, every DNS
  answer and redirect, pins DNS to the connection, rejects routing headers and
  HTTPS downgrade, and strips headers across origins. HEAD and Range GET fallback
  remain available. Probe duration is capped at 30 seconds; response bodies are
  cancelled after reading size headers. Internal URLs are intentionally rejected.
- Successful preparation responses no longer expose commands, local paths or
  process output. Failed child commands return controlled errors; details remain
  in server logs. Sender addresses are validated before invoking a child process.
- Docker excludes real `.env` files, `keys/`, `.iotaprivkey` and `.key` files.
  Compose passes `.env` to the frontend build as a BuildKit secret, preserving
  existing public `VITE_*` customizations without storing the source `.env` in
  image layers. Runtime configuration still uses Compose `env_file`.

## Required cleanup by node managers

The Webview no longer needs a signing wallet. In the **Webview deployment only**:

- Remove `CLIENT_KEY_FILE`, wallet private keys, mnemonics and signing credentials
  from `.env`, Compose environment overrides, service configuration and secret
  mounts. Also check network-prefixed or locally named equivalents. Public wallet
  addresses, capability IDs and package/object IDs are not private keys.
- Remove obsolete Webview-only key files, including a previously generated
  `client/keys/oracle_client.iotaprivkey`, after checking that the file is not used
  by a standalone client or node. Do not delete node identity, validator or
  independently operated CLI keys. A shared checkout may still need those files.
- Remove key volumes/mounts from the Webview container. Rebuild and recreate the
  container; merely updating the source does not clean existing deployments.
- Old images, exported archives and backups may still contain previously copied
  secrets. Review their contents and access, remove obsolete artifacts through
  your normal retention procedure, and rotate credentials that were exposed.
  Excluding secrets from new builds does not erase old layers or old `.env` files.
- Retain `EULA_SOURCE_TOKEN` only if needed for private-repository EULA access;
  it is not a wallet key. Never put secrets in `VITE_*`, which are public values.

These changes do not automatically delete deployed keys or rotate credentials.
Local Webview `.env` key entries are removed during this maintenance; standalone
client/node environment files and actual key files are deliberately preserved.

## Upgrade and smoke checks

1. Back up deployment settings securely and perform the Webview-only cleanup above.
2. Install client dependencies, including the added `undici` dependency, or rebuild
   the Webview image with BuildKit/Compose build-secret support.
3. Run the client and Webview `npm run test:security` suites, the node security
   regression suite, and the normal frontend/node builds.
4. Check `/api/health`, dashboard, wallet authentication, task and schedule preparation.
   `POST /api/tasks/execute` must return 404. Test with non-sensitive data; do not
   spend real gas as part of an automated security check.
5. Inspect the running container's mounts and environment and the rebuilt image's
   layers for leftover keys and real `.env` files. Check that public custom theme
   and network values still match your deployment.

On rollback, retain an external block on `/api/tasks/execute` and unsafe STORAGE
preparation; reverting to the previous image alone restores vulnerable behavior.

## Scope and remaining work

Wallet API authentication and preparation quotas are included. Wallet signing
still authorizes blockchain transactions and Move contracts retain their owner/
capability checks. No domain allowlist, egress firewall, full API resource-role
preflight, global GET/SSE limiter or historical incident audit is included.

See the [updated assessment completeness table](../SECURITY_ASSESSMENT_STATUS_v2.0.7.md)
and [authentication protocol](../WEBVIEW_API_AUTHENTICATION.md).

Managers must set `WEBVIEW_PUBLIC_ORIGIN` to the external HTTPS origin behind a
proxy. If using client-IP quotas behind a proxy, configure only its exact trusted
IP/CIDR in `WEBVIEW_TRUSTED_PROXIES`. Optional additional browser origins go in
`WEBVIEW_ALLOWED_ORIGINS`. Sessions are process-local: restart requires re-login;
replicated deployments need sticky routing and shared state for cluster-wide
session/limiter guarantees. Unsupported personal-message wallets cannot log in.

Automated clients calling prepare must obtain a bearer session; direct CLI
blockchain submissions are unchanged. All prepare requests need explicit sender
and network matching that session. Public dashboard/status/schedule GETs remain
accessible. Reverting the image must not reopen anonymous prepare or execute.

## Local verification

- Client security tests: 11/11; client TypeScript check passes.
- Webview security tests: 18/18; full TypeScript check and production frontend
  build pass.
- Existing node security suite: 22/22; node build passes. Total: 51 passing tests.
- HTTP auth tests exercise real IOTA personal-message signatures, noninteractive
  client login, browser-origin sessions, replay, expiry, revocation, route aliases,
  identity/network/origin binding and quotas without sending chain transactions.
- Actual TypeScript and JavaScript application smoke checks confirm health 200,
  six anonymous operations 401, removed execute 404, real signature login,
  sender binding, per-request network selection and logout. Vite proxy login
  also passes with browser-origin headers.
- Regression tests confirm that aborting HTTP does not free a preparation slot
  while underlying work is still running.
- Frontend session tests cover concurrent login deduplication, token renewal,
  wallet/account changes and rejection without falling back to server signing.
- Docker is unavailable in this environment: image build/layer inspection and
  deployment verification remain operator checks. No real transactions were sent.

## Repository release and upgrade

Repository tag: `v2.0.7`. Internal package versions remain separate.

```bash
git fetch origin --tags
git switch --detach v2.0.7
cd webview
docker compose up --build -d
```

Use your existing project name, network and deployment method; preserve node
identity volumes and independent CLI key files. Rebuild with the new source;
removing keys in a Dockerfile does not clean an already running container.
