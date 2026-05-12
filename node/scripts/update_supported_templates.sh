#!/usr/bin/env bash
set -Eeuo pipefail

trap 'echo "[error] line $LINENO: command failed: $BASH_COMMAND" >&2' ERR

NODE_ID="${NODE_ID:-1}"
ENV_FILE=""
TEMPLATES_RAW=""
NETWORK=""
ASSUME_YES=0

usage() {
  cat <<'EOF'
Interactive update of node supported templates.
The selected list replaces accepted_template_ids on-chain.

Usage:
  ./scripts/update_supported_templates.sh [--node <id>] [--network devnet|testnet|mainnet] [--env-file ./.env]
  ./scripts/update_supported_templates.sh [--node <id>] [--network devnet|testnet|mainnet] --templates "4,5,6" [--yes]

Options:
  --node <id>          Node id (default: 1)
  --network <name>     Force network for env resolution (devnet|testnet|mainnet)
  --env-file <path>    Env file (default: ./ .env)
  --templates <csv>    Preselect templates (example: "4,5,6" or "all")
  -y, --yes            Apply without confirmation
  -h, --help           Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node)
      shift
      [[ $# -gt 0 ]] || { echo "[error] missing value for --node" >&2; usage; exit 1; }
      NODE_ID="$1"
      ;;
    --env-file)
      shift
      [[ $# -gt 0 ]] || { echo "[error] missing value for --env-file" >&2; usage; exit 1; }
      ENV_FILE="$1"
      ;;
    --network)
      shift
      [[ $# -gt 0 ]] || { echo "[error] missing value for --network" >&2; usage; exit 1; }
      NETWORK="$1"
      ;;
    --templates)
      shift
      [[ $# -gt 0 ]] || { echo "[error] missing value for --templates" >&2; usage; exit 1; }
      TEMPLATES_RAW="$1"
      ;;
    -y|--yes)
      ASSUME_YES=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[error] unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

[[ "$NODE_ID" =~ ^[0-9]+$ ]] || { echo "[error] --node must be numeric" >&2; exit 1; }

normalize_list() {
  local raw="$1"
  echo "$raw" \
    | tr '; ' ',,' \
    | tr -s ',' '\n' \
    | sed '/^$/d' \
    | awk '/^[0-9]+$/' \
    | sort -n \
    | uniq \
    | paste -sd, -
}

read_env_value() {
  local key="$1"
  local file="$2"
  [[ -f "$file" ]] || return 1
  awk -F= -v k="$key" '
    /^[[:space:]]*#/ { next }
    $1 == k {
      v = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      print v
      exit
    }
  ' "$file"
}

write_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"
  if [[ -f "$file" ]] && grep -qE "^[[:space:]]*${key}=" "$file"; then
    awk -v k="$key" -v v="$value" '
      BEGIN { done = 0 }
      {
        if (!done && $0 ~ "^[[:space:]]*" k "=") {
          print k "=" v
          done = 1
        } else {
          print $0
        }
      }
      END {
        if (!done) print k "=" v
      }
    ' "$file" > "${file}.tmp"
    mv "${file}.tmp" "$file"
  else
    {
      [[ -f "$file" ]] && cat "$file"
      [[ -s "$file" ]] && echo
      echo "${key}=${value}"
    } > "${file}.tmp"
    mv "${file}.tmp" "$file"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${PROJECT_DIR}/.env}"

if [[ -f "$ENV_FILE" ]]; then
  for k in \
    DEVNET_IOTA_RPC_URL DEVNET_IOTA_RPC_URLS DEVNET_IOTA_CLOCK_ID DEVNET_ORACLE_TASKS_PACKAGE_ID DEVNET_ORACLE_SYSTEM_PACKAGE_ID DEVNET_ORACLE_STATE_ID DEVNET_ORACLE_NODE_REGISTRY_ID DEVNET_CONTROLLER_CAP_ID DEVNET_CONTROLLER_ADDRESS_OR_ALIAS DEVNET_ORACLE_CONTROLLER_ADDRESS DEVNET_ORACLE_ACCEPTED_TEMPLATE_IDS \
    TESTNET_IOTA_RPC_URL TESTNET_IOTA_RPC_URLS TESTNET_IOTA_CLOCK_ID TESTNET_ORACLE_TASKS_PACKAGE_ID TESTNET_ORACLE_SYSTEM_PACKAGE_ID TESTNET_ORACLE_STATE_ID TESTNET_ORACLE_NODE_REGISTRY_ID TESTNET_CONTROLLER_CAP_ID TESTNET_CONTROLLER_ADDRESS_OR_ALIAS TESTNET_ORACLE_CONTROLLER_ADDRESS TESTNET_ORACLE_ACCEPTED_TEMPLATE_IDS \
    MAINNET_IOTA_RPC_URL MAINNET_IOTA_RPC_URLS MAINNET_IOTA_CLOCK_ID MAINNET_ORACLE_TASKS_PACKAGE_ID MAINNET_ORACLE_SYSTEM_PACKAGE_ID MAINNET_ORACLE_STATE_ID MAINNET_ORACLE_NODE_REGISTRY_ID MAINNET_CONTROLLER_CAP_ID MAINNET_CONTROLLER_ADDRESS_OR_ALIAS MAINNET_ORACLE_CONTROLLER_ADDRESS MAINNET_ORACLE_ACCEPTED_TEMPLATE_IDS
  do
    unset "$k" || true
  done
  set -a
  # shellcheck disable=SC1090
  source <(sed 's/\r$//' "$ENV_FILE")
  set +a
fi

NODE_NETWORK_KEY="NODE_${NODE_ID}_NETWORK"
if [[ -z "$NETWORK" ]]; then
  NETWORK="${IOTA_NETWORK:-${ORACLE_NETWORK:-${NODE_NETWORK:-${!NODE_NETWORK_KEY:-}}}}"
fi
NETWORK_RAW="$(echo "${NETWORK}" | tr '[:upper:]' '[:lower:]' | xargs)"
case "$NETWORK_RAW" in
  dev|local|localnet) NETWORK_RAW="devnet" ;;
  test) NETWORK_RAW="testnet" ;;
  main) NETWORK_RAW="mainnet" ;;
esac
[[ "$NETWORK_RAW" == "devnet" || "$NETWORK_RAW" == "testnet" || "$NETWORK_RAW" == "mainnet" ]] || {
  echo "[error] invalid or missing network. Use --network devnet|testnet|mainnet or set IOTA_NETWORK/NODE_${NODE_ID}_NETWORK in .env" >&2
  exit 1
}
export IOTA_NETWORK="$NETWORK_RAW"
NET_PREFIX="$(echo "$NETWORK_RAW" | tr '[:lower:]' '[:upper:]')"
PREF_KEY="${NET_PREFIX}_ORACLE_ACCEPTED_TEMPLATE_IDS"
NODE_KEY="NODE_${NODE_ID}_ORACLE_ACCEPTED_TEMPLATE_IDS"

get_prefixed_env() {
  local key="$1"
  local prefixed="${NET_PREFIX}_${key}"
  local v="${!prefixed:-}"
  if [[ -n "$v" ]]; then
    printf "%s" "$v"
    return 0
  fi
  printf "%s" "${!key:-}"
}

STATE_ID="$(get_prefixed_env ORACLE_STATE_ID)"
[[ -n "$STATE_ID" ]] || { echo "[error] missing ${NET_PREFIX}_ORACLE_STATE_ID (or ORACLE_STATE_ID) in env" >&2; exit 1; }

echo "[info] project: ${PROJECT_DIR}"
echo "[info] node_id: ${NODE_ID}"
echo "[info] env_file: ${ENV_FILE}"
echo "[info] network: ${NETWORK_RAW}"
echo "[info] state_id: ${STATE_ID}"

JSON="$(cd "${PROJECT_DIR}" && npm exec -- tsx src/tools/listTemplates.ts --json --network "$NETWORK_RAW" --state-id "$STATE_ID")"
mapfile -t CANDIDATES < <(printf "%s" "$JSON" | node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const approved = Array.isArray(data?.approvedTemplates) ? data.approvedTemplates : [];
const pending = Array.isArray(data?.pendingProposals) ? data.pendingProposals : [];
const map = new Map();
for (const t of approved) {
  const id = Number(t?.templateId);
  if (!Number.isFinite(id) || id < 0) continue;
  map.set(id, { id, type: String(t?.taskType ?? ""), src: "approved" });
}
for (const p of pending) {
  if (String(p?.kind ?? "") !== "upsert") continue;
  const id = Number(p?.templateId);
  if (!Number.isFinite(id) || id < 0) continue;
  if (!map.has(id)) map.set(id, { id, type: "", src: "pending-upsert" });
}
if (!map.has(0)) map.set(0, { id: 0, type: "SCHEDULER", src: "local" });
for (const x of [...map.values()].sort((a,b)=>a.id-b.id)) {
  process.stdout.write(`${x.id}\t${x.type}\t${x.src}\n`);
}
')

if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
  echo "[error] no template candidates found on-chain (approved/pending-upsert)." >&2
  exit 1
fi

CURRENT_RAW="${!NODE_KEY:-}"
if [[ -z "$CURRENT_RAW" ]]; then
  CURRENT_RAW="${ORACLE_ACCEPTED_TEMPLATE_IDS:-}"
fi
if [[ -z "$CURRENT_RAW" ]]; then
  CURRENT_RAW="${!PREF_KEY:-}"
fi
if [[ -z "$CURRENT_RAW" ]]; then
  CURRENT_RAW="$(read_env_value "$NODE_KEY" "$ENV_FILE" || true)"
fi
if [[ -z "$CURRENT_RAW" ]]; then
  CURRENT_RAW="$(read_env_value ORACLE_ACCEPTED_TEMPLATE_IDS "$ENV_FILE" || true)"
fi
if [[ -z "$CURRENT_RAW" ]]; then
  CURRENT_RAW="$(read_env_value "$PREF_KEY" "$ENV_FILE" || true)"
fi
CURRENT_LIST="$(normalize_list "$CURRENT_RAW")"

SELECTED_LIST=""
if [[ -n "$TEMPLATES_RAW" ]]; then
  TEMPLATES_CLEAN="$(echo "$TEMPLATES_RAW" | tr '[:upper:]' '[:lower:]' | xargs)"
  if [[ "$TEMPLATES_CLEAN" == "all" ]]; then
    SELECTED_IDS=()
    for line in "${CANDIDATES[@]}"; do
      SELECTED_IDS+=("$(printf "%s" "$line" | cut -f1)")
    done
    SELECTED_LIST="$(normalize_list "$(IFS=,; echo "${SELECTED_IDS[*]}")")"
  else
    SELECTED_LIST="$(normalize_list "$TEMPLATES_RAW")"
  fi
  [[ -n "$SELECTED_LIST" ]] || { echo "[error] --templates produced empty list" >&2; exit 1; }
  declare -A valid_ids=()
  for line in "${CANDIDATES[@]}"; do
    tid="$(printf "%s" "$line" | cut -f1)"
    valid_ids["$tid"]=1
  done
  for token in ${SELECTED_LIST//,/ }; do
    [[ -n "${valid_ids[$token]:-}" ]] || { echo "[error] unknown template id in --templates: $token" >&2; exit 1; }
  done
else
  echo ""
  echo "Available templates:"
  for i in "${!CANDIDATES[@]}"; do
    tid="$(printf "%s" "${CANDIDATES[$i]}" | cut -f1)"
    typ="$(printf "%s" "${CANDIDATES[$i]}" | cut -f2)"
    src="$(printf "%s" "${CANDIDATES[$i]}" | cut -f3)"
    mark=" "
    if [[ -n "$CURRENT_LIST" ]] && echo ",${CURRENT_LIST}," | grep -q ",${tid},"; then
      mark="x"
    fi
    printf "  [%s] id=%s type=%s source=%s\n" "$mark" "$tid" "${typ:--}" "$src"
  done
  echo ""
  echo "Select templates that this node should support:"
  echo "  - one/more template ids (example: 4 5 6 or 4,5,6)"
  echo "  - or 'all'"
  read -r -p "> " SEL
  SEL="$(echo "$SEL" | tr '[:upper:]' '[:lower:]' | xargs)"
  [[ -n "$SEL" ]] || { echo "[error] empty selection" >&2; exit 1; }

  SELECTED_IDS=()
  if [[ "$SEL" == "all" ]]; then
    for line in "${CANDIDATES[@]}"; do
      SELECTED_IDS+=("$(printf "%s" "$line" | cut -f1)")
    done
  else
    NORM="$(echo "$SEL" | tr ',' ' ')"
    declare -A seen=()
    declare -A valid_ids=()
    for line in "${CANDIDATES[@]}"; do
      tid="$(printf "%s" "$line" | cut -f1)"
      valid_ids["$tid"]=1
    done
    for token in $NORM; do
      [[ "$token" =~ ^[0-9]+$ ]] || { echo "[error] invalid token: $token" >&2; exit 1; }
      [[ -n "${valid_ids[$token]:-}" ]] || { echo "[error] unknown template id: $token" >&2; exit 1; }
      if [[ -z "${seen[$token]:-}" ]]; then
        seen[$token]=1
        SELECTED_IDS+=("$token")
      fi
    done
  fi
  SELECTED_LIST="$(normalize_list "$(IFS=,; echo "${SELECTED_IDS[*]}")")"
fi

[[ -n "$SELECTED_LIST" ]] || { echo "[error] selected list is empty (node registration would fail)." >&2; exit 1; }

echo ""
echo "[info] current templates: ${CURRENT_LIST:-<none>}"
echo "[info] selected templates: ${SELECTED_LIST}"
if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -r -p "Apply this template support list now? [y/N] " CONFIRM
  CONFIRM="$(echo "$CONFIRM" | tr '[:upper:]' '[:lower:]' | xargs)"
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "yes" ]]; then
    echo "[info] cancelled."
    exit 0
  fi
fi

cd "${PROJECT_DIR}"
npm run cli -- set-accepted-templates --node "${NODE_ID}" --templates "${SELECTED_LIST}"

if [[ -n "$ENV_FILE" ]]; then
  write_env_value "$NODE_KEY" "${SELECTED_LIST}" "${ENV_FILE}"
  write_env_value "ORACLE_ACCEPTED_TEMPLATE_IDS" "${SELECTED_LIST}" "${ENV_FILE}"
  write_env_value "$PREF_KEY" "${SELECTED_LIST}" "${ENV_FILE}"
  echo "[info] updated env: ${NODE_KEY}, ORACLE_ACCEPTED_TEMPLATE_IDS and ${PREF_KEY}"
fi

echo "[ok] node ${NODE_ID} accepted templates updated."
