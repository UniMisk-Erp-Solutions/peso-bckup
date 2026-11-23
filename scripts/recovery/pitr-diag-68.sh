#!/usr/bin/env bash
run_sudo() { echo "${SUDO_PASSWORD:-qwertyui}" | sudo -S "$@"; }
echo "SUCCESS dirs:"
run_sudo find /var/lib/pesowise-pitr-backup/base -name SUCCESS 2>/dev/null
echo "pgdata sample:"
run_sudo ls -la /var/lib/pesowise-pitr-recovery-demo/pgdata/ 2>/dev/null | head -8
run_sudo test -f /var/lib/pesowise-pitr-recovery-demo/pgdata/PG_VERSION && echo PG_VERSION_OK || echo PG_VERSION_MISSING
