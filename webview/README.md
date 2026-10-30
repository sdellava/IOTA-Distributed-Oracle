# iota_oracle_webview

TypeScript full-stack webview for the IOTA Oracle system.

## What it does

- React frontend for a live oracle dashboard
- Express backend in TypeScript
- Reads on-chain activity through the official IOTA TypeScript SDK
- Executes tasks through local sibling project `../iota_oracle_client`
- Loads JSON examples from local `./examples`

## Dashboard metrics

The page shows:

- active nodes
- known nodes
- inactive known nodes
- task events
- message events
- latest checkpoint
- recent oracle events
- node activity by sender address

## Important note about "active nodes"

Without a dedicated on-chain registry query, the dashboard infers active nodes from recent event senders in configured oracle modules.

That means:

- `active nodes` = unique senders with recent events in the configured time window
- `known nodes` = `ORACLE_NODE_ADDRESSES` from `.env`, if provided
- if `ORACLE_NODE_ADDRESSES` is empty, known nodes are inferred from recent senders only

If `ORACLE_SYSTEM_STATE_ID` is configured, backend tries to read registered nodes from oracle system state and counts active nodes only inside that set. If missing, it falls back to sender-based inference.

## Expected project layout

```text
parent/
  iota_oracle_client/
  iota_oracle_webview/
    examples/
```

Backend assumptions:

- oracle client is at `../iota_oracle_client`
- example JSON files are in local `./examples`

## Configuration

Copy `.env.example` to `.env` and set at least:

```env
PORT=8787
IOTA_RPC_URL=https://api.testnet.iota.cafe
ORACLE_PACKAGE_ID=0xYOUR_PACKAGE_ID
ORACLE_SYSTEM_STATE_ID=0xYOUR_SYSTEM_STATE_ID
ORACLE_TASK_MODULE=oracle_tasks
ORACLE_MESSAGE_MODULE=oracle_messages
ACTIVE_WINDOW_MINUTES=15
EVENT_FETCH_LIMIT=100
ORACLE_NODE_ADDRESSES=
ORACLE_CLIENT_DIR=../iota_oracle_client
ORACLE_EXAMPLES_DIR=examples
```

## Install

```bash
npm install
```

## Development

```bash
npm run dev
```

Starts:

- Vite frontend on `http://localhost:5173`
- Express backend on `http://localhost:8787`

Vite proxies `/api/*` to backend.

## Production-style run

Build frontend:

```bash
npm run build
```

Start backend:

```bash
npm run start
```

Backend serves `dist/` and API.

## Task execution flow

The backend only prepares unsigned transactions. The connected wallet signs and
submits them; immediate and scheduled tasks remain supported. The obsolete
`POST /api/tasks/execute` server-signing route has been removed.

External clients can independently submit tasks using `client/` and their own
local wallet (`npm run create -- examples/task_weather.json`). The standalone
client identity must not be installed in the Webview runtime.

No `CLIENT_KEY_FILE`, private key, mnemonic, or wallet key mount is required by
the Webview. Preparation subprocesses receive only public configuration and
cannot load or generate a signing identity. Keep EULA_SOURCE_TOKEN, if needed,
server-side; this repository access token is unrelated to wallet signing.

Docker builds use `.env.example` for build defaults. Configure deployment via
runtime environment; the Compose build mounts `.env` as a BuildKit secret to preserve `VITE_*`
customizations without retaining the source file in image layers. Real `.env` and wallet key files are excluded from the image.

## API authentication

Preparation requires a short-lived wallet-signature session in v2.0.7. The UI
requests a personal-message signature at first preparation and separately asks
for each transaction signature. Automated clients can sign locally using
`client`'s `auth:webview` command. Dashboard reads remain public. See
[protocol, quotas and proxy configuration](../docs/WEBVIEW_API_AUTHENTICATION.md).

## Files worth touching next

- `server/services/oracleStatus.ts` for stricter on-chain metrics
- `server/services/oracleClient.ts` if client command changes
- `src/App.tsx` for UI changes

## Suggested next improvement

A good next step is a dedicated backend adapter that reads real oracle shared objects (not only recent events). That enables exact counts for registered nodes, pending tasks, completed tasks, and per-task state.

## Note on `.env`

Backend loads `.env` using `dotenv`. If `ORACLE_PACKAGE_ID` is empty, verify commands are run from `iota_oracle_webview` project root.

## Notes

- `ORACLE_NODE_ADDRESSES` is optional. If empty, dashboard infers nodes from recent event senders.
- On Windows backend runs oracle client via `cmd.exe /c npm run create -- <taskfile>` because `npm.cmd` should not be spawned directly without a shell (per Node.js docs).

## Examples directory

By default backend reads example tasks from:

```text
./examples
```

relative to `iota_oracle_webview` root.

You can override with:

```env
ORACLE_EXAMPLES_DIR=examples
```

For backward compatibility, `ORACLE_CLIENT_EXAMPLES_DIR` is still accepted, but recommended variable is `ORACLE_EXAMPLES_DIR`.
