#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

VALIDATOR_CAPS_REPORT="${REPO_ROOT}/move/testnet/oracle_validator_caps_testnet/testnet_validator_caps.txt"
SYSTEM_STATE_REPORT="${REPO_ROOT}/move/testnet/oracle_system_state_testnet/testnet_system_state.txt"
TASKS_REPORT="${REPO_ROOT}/move/testnet/oracle_tasks_testnet/testnet_oracle_tasks.txt"

python3 - "$REPO_ROOT" "$VALIDATOR_CAPS_REPORT" "$SYSTEM_STATE_REPORT" "$TASKS_REPORT" <<'PY'
from pathlib import Path
import re
import sys

repo_root = Path(sys.argv[1])
validator_caps_report = Path(sys.argv[2])
system_report = Path(sys.argv[3])
tasks_report = Path(sys.argv[4])


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def package_id_from_report(path: Path) -> str | None:
    if not path.exists():
        return None
    text = read(path)
    match = re.search(r'PackageID:\s*(0x[a-fA-F0-9]+)', text)
    return match.group(1) if match else None


def object_id_for_type(text: str, suffix: str) -> str | None:
    blocks = re.findall(r"│  ┌──[\s\S]*?│  └──", text)
    type_pattern = re.compile(r"ObjectType:\s*(0x[a-fA-F0-9]+::" + re.escape(suffix) + r")")
    id_pattern = re.compile(r"ObjectID:\s*(0x[a-fA-F0-9]+)")
    for block in blocks:
        if not type_pattern.search(block):
            continue
        match = id_pattern.search(block)
        if match:
            return match.group(1)
    return None


def read_env(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore") if path.exists() else ""


system_text = read(system_report)
tasks_text = read(tasks_report)

values = {
    "TESTNET_ORACLE_VALIDATOR_CAPS_PACKAGE_ID": package_id_from_report(validator_caps_report),
    "TESTNET_ORACLE_SYSTEM_PACKAGE_ID": package_id_from_report(system_report),
    "TESTNET_ORACLE_TASKS_PACKAGE_ID": package_id_from_report(tasks_report),
    "TESTNET_ORACLE_STATE_ID": object_id_for_type(system_text, "systemState::State"),
    "TESTNET_ORACLE_TREASURY_ID": object_id_for_type(system_text, "systemState::OracleTreasury"),
    "TESTNET_CONTROLLER_CAP_ID": object_id_for_type(system_text, "systemState::ControllerCap"),
    "TESTNET_ORACLE_NODE_REGISTRY_ID": object_id_for_type(system_text, "systemState::NodeRegistry"),
    "TESTNET_ORACLE_TASK_REGISTRY_ID": object_id_for_type(tasks_text, "oracle_tasks::TaskRegistry"),
    "TESTNET_ORACLE_TASK_SCHEDULER_QUEUE_ID": object_id_for_type(tasks_text, "oracle_tasks::SchedulerQueue"),
}

missing = [key for key, value in values.items() if not value]
if missing:
    raise SystemExit("Missing required values from publish reports: " + ", ".join(missing))


def upsert_lines(path: Path, pairs: list[tuple[str, str]]) -> None:
    if not path.exists():
      return
    lines = read_env(path).splitlines()
    changed = False
    for key, value in pairs:
        regex = re.compile(rf'^{re.escape(key)}=.*$')
        for idx, line in enumerate(lines):
            if regex.match(line):
                new_line = f"{key}={value}"
                if lines[idx] != new_line:
                    lines[idx] = new_line
                    changed = True
                break
        else:
            lines.append(f"{key}={value}")
            changed = True
    if changed:
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"[updated] {path}")


def remove_keys(path: Path, keys: list[str]) -> None:
    if not path.exists():
        return
    lines = read_env(path).splitlines()
    filtered = [line for line in lines if not any(line.startswith(f"{key}=") for key in keys)]
    if filtered != lines:
        path.write_text("\n".join(filtered) + "\n", encoding="utf-8")
        print(f"[cleaned] {path}")


client_env = repo_root / "client" / ".env"
client_example = repo_root / "client" / ".env.example"
node_env = repo_root / "node" / ".env"
node_example = repo_root / "node" / ".env.example"
webview_example = repo_root / "webview" / ".env.example"
webview_env = repo_root / "webview" / ".env"

runtime_pairs = [
    ("IOTA_NETWORK", "testnet"),
    ("IOTA_RPC_URL", "https://api.testnet.iota.cafe"),
    ("IOTA_FAUCET_URL", "https://faucet.testnet.iota.cafe/gas"),
    ("ORACLE_VALIDATOR_CAPS_PACKAGE_ID", values["TESTNET_ORACLE_VALIDATOR_CAPS_PACKAGE_ID"]),
    ("ORACLE_TASKS_PACKAGE_ID", values["TESTNET_ORACLE_TASKS_PACKAGE_ID"]),
    ("ORACLE_SYSTEM_PACKAGE_ID", values["TESTNET_ORACLE_SYSTEM_PACKAGE_ID"]),
    ("ORACLE_STATE_ID", values["TESTNET_ORACLE_STATE_ID"]),
    ("ORACLE_TREASURY_ID", values["TESTNET_ORACLE_TREASURY_ID"]),
    ("CONTROLLER_CAP_ID", values["TESTNET_CONTROLLER_CAP_ID"]),
    ("ORACLE_NODE_REGISTRY_ID", values["TESTNET_ORACLE_NODE_REGISTRY_ID"]),
    ("ORACLE_TASK_REGISTRY_ID", values["TESTNET_ORACLE_TASK_REGISTRY_ID"]),
    ("ORACLE_TASK_SCHEDULER_QUEUE_ID", values["TESTNET_ORACLE_TASK_SCHEDULER_QUEUE_ID"]),
]

client_network_pairs = [
    ("TESTNET_IOTA_RPC_URL", "https://api.testnet.iota.cafe"),
    ("TESTNET_ORACLE_VALIDATOR_CAPS_PACKAGE_ID", values["TESTNET_ORACLE_VALIDATOR_CAPS_PACKAGE_ID"]),
    ("TESTNET_ORACLE_TASKS_PACKAGE_ID", values["TESTNET_ORACLE_TASKS_PACKAGE_ID"]),
    ("TESTNET_ORACLE_SYSTEM_PACKAGE_ID", values["TESTNET_ORACLE_SYSTEM_PACKAGE_ID"]),
    ("TESTNET_ORACLE_STATE_ID", values["TESTNET_ORACLE_STATE_ID"]),
    ("TESTNET_ORACLE_TREASURY_ID", values["TESTNET_ORACLE_TREASURY_ID"]),
    ("TESTNET_ORACLE_NODE_REGISTRY_ID", values["TESTNET_ORACLE_NODE_REGISTRY_ID"]),
    ("TESTNET_ORACLE_TASK_REGISTRY_ID", values["TESTNET_ORACLE_TASK_REGISTRY_ID"]),
    ("TESTNET_ORACLE_TASK_SCHEDULER_QUEUE_ID", values["TESTNET_ORACLE_TASK_SCHEDULER_QUEUE_ID"]),
]

node_pairs = [
    ("TESTNET_IOTA_RPC_URL", "https://api.testnet.iota.cafe"),
    ("TESTNET_ORACLE_VALIDATOR_CAPS_PACKAGE_ID", values["TESTNET_ORACLE_VALIDATOR_CAPS_PACKAGE_ID"]),
    ("TESTNET_ORACLE_TASKS_PACKAGE_ID", values["TESTNET_ORACLE_TASKS_PACKAGE_ID"]),
    ("TESTNET_ORACLE_SYSTEM_PACKAGE_ID", values["TESTNET_ORACLE_SYSTEM_PACKAGE_ID"]),
    ("TESTNET_ORACLE_STATE_ID", values["TESTNET_ORACLE_STATE_ID"]),
    ("TESTNET_ORACLE_TREASURY_ID", values["TESTNET_ORACLE_TREASURY_ID"]),
    ("TESTNET_CONTROLLER_CAP_ID", values["TESTNET_CONTROLLER_CAP_ID"]),
    ("TESTNET_ORACLE_NODE_REGISTRY_ID", values["TESTNET_ORACLE_NODE_REGISTRY_ID"]),
    ("TESTNET_ORACLE_TASK_REGISTRY_ID", values["TESTNET_ORACLE_TASK_REGISTRY_ID"]),
    ("TESTNET_ORACLE_TASK_SCHEDULER_QUEUE_ID", values["TESTNET_ORACLE_TASK_SCHEDULER_QUEUE_ID"]),
    ("REGISTER_MODE", "prod"),
]

webview_pairs = list(values.items())
legacy_node_runtime_keys = [
    "DELEGATED_CONTROLLER_CAP_ID",
]
legacy_generic_runtime_keys = [
]

upsert_lines(client_env, [*client_network_pairs, *runtime_pairs])
upsert_lines(client_example, [*client_network_pairs, *runtime_pairs])
upsert_lines(node_env, [*node_pairs, *runtime_pairs])
upsert_lines(node_example, [*node_pairs, *runtime_pairs])
upsert_lines(webview_env, [*webview_pairs, *runtime_pairs])
upsert_lines(webview_example, [*webview_pairs, *runtime_pairs])
remove_keys(node_env, legacy_node_runtime_keys)
remove_keys(node_example, legacy_node_runtime_keys)
remove_keys(client_env, legacy_generic_runtime_keys)
remove_keys(client_example, legacy_generic_runtime_keys)
remove_keys(webview_env, legacy_generic_runtime_keys)
remove_keys(webview_example, legacy_generic_runtime_keys)
PY
