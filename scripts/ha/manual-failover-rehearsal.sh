#!/usr/bin/env bash
# Controlled manual failover rehearsal — phase driver (dry-run default).
# Requires: .46 SSH for fence/HAProxy/PITR-old; .68 SSH for promote/rejoin target.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PHASE="${1:-precheck}"
EXECUTE=0
OPERATOR="${OPERATOR:-unknown}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --operator) OPERATOR="$2"; shift 2 ;;
    precheck|stability|lock|catchup|fence|promote|validate-write|switch-app|pitr|basebackup|rejoin|verify|*) ;;
  esac
done

run_46() {
  local cmd="$1"
  if [[ -n "${SSH_46:-}" ]]; then
    sshpass -p "${SSH_46_PASS:?}" ssh -o StrictHostKeyChecking=accept-new "$SSH_46" "$cmd"
  else
    echo "BLOCKED .46: set SSH_46=hasto@192.168.23.46 SSH_46_PASS=..." >&2
    return 1
  fi
}

run_68() {
  local cmd="$1"
  if [[ -n "${SSH_68:-}" ]]; then
    sshpass -p "${SSH_68_PASS:?}" ssh -o StrictHostKeyChecking=accept-new "$SSH_68" "$cmd"
  else
    echo "BLOCKED .68: set SSH_68=mithil@192.168.23.68 SSH_68_PASS=..." >&2
    return 1
  fi
}

case "$PHASE" in
  precheck)
    run_46 "bash -s" <<'EOS' || true
/home/hasto/peso-bckup-priyanshu/scripts/recovery/check-pitr-health.sh
/home/hasto/peso-bckup-priyanshu/scripts/ha/check-ha-health.sh
EOS
    run_68 "SUDO_PASSWORD=$SSH_68_PASS bash /tmp/verify-replication-68.sh"
    ;;
  lock)
    run_68 "sudo mkdir -p /var/lib/pesowise-ha && $SCRIPT_DIR/ha-lock.sh acquire --operator $OPERATOR --reason controlled_manual_failover_rehearsal" || \
      run_68 "echo qwertyui | sudo -S bash $SCRIPT_DIR/ha-lock.sh acquire --operator $OPERATOR --reason controlled_manual_failover_rehearsal"
    ;;
  fence)
    [[ "$EXECUTE" -eq 1 ]] || { echo "DRY: PESOWISE_FENCE_CONFIRM=FENCE_46_NOW $SCRIPT_DIR/fence-primary-46.sh --execute"; exit 0; }
    run_46 "PESOWISE_FENCE_CONFIRM=FENCE_46_NOW bash $SCRIPT_DIR/fence-primary-46.sh --execute"
    ;;
  promote)
    [[ "$EXECUTE" -eq 1 ]] || { echo "DRY: RUN_LOCALLY=standby PESOWISE_HA_PROMOTE_CONFIRM=PROMOTE_STANDBY_NOW promote-standby.sh --execute"; exit 0; }
    run_68 "RUN_LOCALLY=standby PESOWISE_HA_PROMOTE_CONFIRM=PROMOTE_STANDBY_NOW bash $SCRIPT_DIR/promote-standby.sh --execute"
    ;;
  switch-app)
    [[ "$EXECUTE" -eq 1 ]] || { echo "DRY: switch-haproxy-primary.sh --execute"; exit 0; }
    run_46 "PESOWISE_SWITCH_CONFIRM=SWITCH_APP_TO_68 bash $SCRIPT_DIR/switch-haproxy-primary.sh --execute"
    ;;
  *)
    echo "Phases: precheck | stability | lock | catchup | fence | promote | validate-write | switch-app | pitr | basebackup | rejoin | verify"
    exit 1
    ;;
esac
