#!/usr/bin/env bash
# HA operation lock (management host; must not depend on .46 being up).
set -euo pipefail

LOCK_DIR="${PESOWISE_HA_LOCK_DIR:-/var/lib/pesowise-ha}"
LOCK_FILE="${LOCK_DIR}/operation.lock"

cmd="${1:-}"
shift || true

usage() {
  echo "Usage: $0 acquire|release|status --operator NAME --reason TEXT [--source HOST] [--target HOST]"
  exit 1
}

[[ -n "$cmd" ]] || usage

mkdir -p "$LOCK_DIR" 2>/dev/null || sudo mkdir -p "$LOCK_DIR"

OPERATOR="${OPERATOR:-unknown}"
REASON="${REASON:-unspecified}"
SOURCE="${SOURCE_PRIMARY:-192.168.23.46}"
TARGET="${TARGET_PRIMARY:-192.168.23.68}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --operator) OPERATOR="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    *) usage ;;
  esac
done

write_lock() {
  local id
  id="ha-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  printf '{"operation_id":"%s","operator":"%s","started_at":"%s","source_primary":"%s","target_primary":"%s","reason":"%s"}\n' \
    "$id" "$OPERATOR" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SOURCE" "$TARGET" "$REASON" | \
    (sudo tee "$LOCK_FILE" >/dev/null 2>&1 || tee "$LOCK_FILE" >/dev/null)
  echo "LOCK ACQUIRED: $id"
}

case "$cmd" in
  acquire)
    if [[ -f "$LOCK_FILE" ]]; then
      echo "LOCK HELD:" >&2
      cat "$LOCK_FILE" >&2
      exit 1
    fi
    write_lock
    ;;
  release)
    if [[ ! -f "$LOCK_FILE" ]]; then
      echo "No lock present"
      exit 0
    fi
    sudo rm -f "$LOCK_FILE" 2>/dev/null || rm -f "$LOCK_FILE"
    echo "LOCK RELEASED"
    ;;
  status)
    if [[ -f "$LOCK_FILE" ]]; then
      cat "$LOCK_FILE"
      exit 0
    fi
    echo "No active HA lock"
    exit 0
    ;;
  *) usage ;;
esac
