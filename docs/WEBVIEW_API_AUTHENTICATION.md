# Webview API wallet authentication

Starting with repository release **v2.0.7**, the Webview prepares transactions
only for authenticated clients. Authentication uses an IOTA **personal-message**
signature, not a transaction signature. It does not spend gas or grant node,
governance, owner or supervisor capabilities. The caller separately signs and
submits each blockchain transaction with its own wallet.

## Protected and public endpoints

These POST endpoints require `Authorization: Bearer <token>`, an explicit
`network`, and a `sender` matching the authenticated wallet:

- `/api/tasks/prepare-wallet`
- `/api/tasks/prepare-task-schedule-wallet`
- `/api/task-schedules/prepare-action-wallet`
- `/api/node-management/prepare-wallet`
- `/api/node-management/prepare-approve-wallet`

`POST /api/network` also requires authentication and the session's network; it
returns selected configuration without changing the server-wide default. It
does not require a `sender`. The browser now uses public
`GET /api/network?network=testnet` to change its own selection without affecting
other clients or requiring a wallet just to view the dashboard.

Health, dashboard, task/event/stream, schedule, examples and network GET endpoints
remain public reads. Their data are not made private by this authentication
feature. There is no public server-signing endpoint: `/api/tasks/execute` is
removed and returns 404, with or without authentication.

## Protocol for browser and noninteractive clients

1. POST `/api/auth/challenge` with `{"address":"0x...","network":"testnet"}`.
2. Receive `challengeId`, `message`, canonical `address`, `network`, `audience`
   and `expiresAt`. Validate the service identity and sign the exact UTF-8
   `message` bytes using IOTA `signPersonalMessage`.
3. POST `/api/auth/verify` with `{"challengeId":"...","signature":"..."}`.
4. Receive `token`, `tokenType: "Bearer"`, `address`, `network`, `expiresAt`.
5. Supply the token in the Authorization header on preparation requests. Keep
   the same `sender` and `network`. A token for one network is not valid for another.
6. At expiry or after a server restart, request a new challenge and sign again.
   POST `/api/auth/logout` with the token to revoke it early.

Challenges expire after **2 minutes** and are consumed once, including failed
signature attempts. The signed message binds the service origin, browser origin
(or noninteractive client), wallet, network, random nonce, issuance and expiry.
Concurrent replay cannot mint a second session. Sessions expire after **15
minutes**. Tokens are opaque random values; the server keeps only their hashes.
Tokens in URL/query parameters are ignored. Authentication responses are not cached.

The browser uses `useSignPersonalMessage` at the first preparation request,
shares one authentication attempt between simultaneous requests and caches the
session in memory. Account/network changes and disconnect clear that cache.
The UI renews once on a 401, before preparation work; it does not retry a 403 or
fall back to anonymous/server signing. Wallets must support personal-message
signing; rejecting that confirmation cancels the operation. Dashboard polling
does not request signatures.

## Existing automated CLI

The independent command below continues to sign and submit directly to IOTA:

```bash
cd client
npm run create -- examples/task_weather.json
```

It does not use Webview authentication. If an integration instead wants the
Webview's preparation API, it can authenticate without an extension or person:

```bash
cd client
npm run auth:webview -- https://oracle.example.com testnet
```

This loads the standalone client's local identity using the existing
`CLIENT_KEY_FILE` setting or client key-file default, signs locally and prints
the short-lived session as JSON. Treat that output as a credential; do not send
it to public logs, commit it, or expose it in URLs. The private key is never sent
to the Webview. A local identity may be generated if none exists, as with the
existing CLI; authentication alone does not fund it or authorize blockchain actions.

For an embedded integration, import `authenticateWebview` from
`client/src/webviewAuth.ts` and supply your own signer. The helper enforces HTTPS
except on loopback, rejects redirects, checks the challenge's audience/address/
network and returns the session. A subsequent request is, for example:

```http
POST /api/tasks/prepare-wallet
Authorization: Bearer <token>
Content-Type: application/json

{"sender":"0x...","network":"testnet","task":{"template_id":1,"type":"..."}}
```

Use a complete task appropriate to the deployed template; the JSON above only
illustrates the authentication envelope. Sign and submit the returned
`serializedTransaction` locally. No server key is required.

## Deployment configuration and limits

Set `WEBVIEW_PUBLIC_ORIGIN` to the canonical externally visible origin, for
example `https://oracle.example.com`, particularly behind TLS termination. This
is an origin, not a URL path. Without it, the service derives an audience from
Host (HTTPS except loopback); explicit configuration avoids proxy ambiguity.
`WEBVIEW_ALLOWED_ORIGINS` optionally lists exact additional browser origins.
Other browser origins are rejected; browser-origin sessions cannot be reused
without their origin. Headless clients normally omit Origin consistently.

`WEBVIEW_TRUSTED_PROXIES` may list exact proxy IPs/CIDRs if forwarded client IPs
are needed for quotas. It is empty by default. Do not blindly trust all proxies
or user-supplied `X-Forwarded-For`. Behind an unconfigured proxy, its peer IP
shares the IP quota. TLS termination, firewall and correct proxy routing remain
operator responsibilities.

Default bounds, **per server process**:

| Resource | Bound |
|---|---|
| Authentication requests | 30/minute/IP, including challenge and verify |
| Requests to preparation paths | 120/minute/IP before authentication |
| Authenticated preparations | 60/minute/wallet/network |
| Active preparation HTTP requests | 4/wallet/network |
| Client preparation subprocesses | 4 globally, held until actual child completion |
| Challenge/session/counter stores | Each capped at 10,000 entries, expiry-pruned |

Excess authentication/preparation requests return 429 with Retry-After. Counters
and sessions are in memory: restart invalidates sessions, multiple replicas
require sticky routing and a shared store/limiter for coherent cluster-wide
quotas. These are not distributed abuse controls or a domain allowlist. Node
management still checks registry state as applicable, and the Move contracts
enforce final transaction authorization; API authentication is not a substitute
for owner/capability checks.
