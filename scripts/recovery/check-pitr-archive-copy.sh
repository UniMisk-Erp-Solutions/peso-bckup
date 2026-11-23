#!/usr/bin/env bash
# Read-only check of the PesoWise PITR archive COPY kept on the hasto server's
# 4 TB disk (copied from /mnt/hdd/pesowise-pitr on 2026-11-06, see DOC-161).
#
# Layout of the archive root:
#   wal/     WAL segments (24-hex-char names, last one may end in .partial)
#   base/    <UTC timestamp>/base.tar.zst (+ manifest.json); *.partial = unfinished
#   status/  pi-wal.json, pi-base.json written by the original receiver
#
# Usage: check-pitr-archive-copy.sh [ARCHIVE_ROOT]
#   ARCHIVE_ROOT defaults to $PESOWISE_PITR_ARCHIVE_ROOT or the path below.
# Exit: 0 = PASS/WARN, 1 = FAIL. Never writes or deletes anything.
set -euo pipefail

ARCHIVE_ROOT="${1:-${PESOWISE_PITR_ARCHIVE_ROOT:-/srv/immich-data/backup/pesowise-pitr}}"
MAX_WAL_AGE_H="${PESOWISE_PITR_ARCHIVE_MAX_AGE_H:-24}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAIL=0
WARN=0
pass() { echo "$1: PASS"; }
warn() { echo "$1: WARN"; WARN=1; }
fail() { echo "$1: FAIL"; FAIL=1; }

echo "PESOWISE PITR ARCHIVE COPY"
echo "=========================="
echo "Root: $ARCHIVE_ROOT"

[[ -d "$ARCHIVE_ROOT/wal" ]] && pass "WAL directory" || { fail "WAL directory"; echo "OVERALL: FAIL"; exit 1; }

# Complete segments only (exclude *.partial).
mapfile -t segs < <(find "$ARCHIVE_ROOT/wal" -maxdepth 1 -type f -regextype posix-extended \
  -regex '.*/[0-9A-F]{24}' -printf '%f\n' | sort)
count=${#segs[@]}
if [[ "$count" -gt 0 ]]; then
  echo "Complete WAL segments: $count (first ${segs[0]}, last ${segs[$((count-1))]})"
  pass "WAL present"
else
  fail "WAL present"
fi

# Continuity: same timeline, consecutive 16 MiB segments (24 hex = TLI 8 + log 8 + seg 8).
gaps=0
prev_log=""; prev_seg=""
for s in "${segs[@]}"; do
  tli=${s:0:8}; log=$((16#${s:8:8})); seg=$((16#${s:16:8}))
  if [[ -n "$prev_log" && "$tli" == "$prev_tli" ]]; then
    exp_seg=$((prev_seg+1)); exp_log=$prev_log
    if [[ "$exp_seg" -ge 256 ]]; then exp_seg=0; exp_log=$((prev_log+1)); fi
    if [[ "$log" -ne "$exp_log" || "$seg" -ne "$exp_seg" ]]; then
      gaps=$((gaps+1)); echo "  gap before $s"
    fi
  fi
  prev_tli=$tli; prev_log=$log; prev_seg=$seg
done
[[ "$gaps" -eq 0 ]] && pass "WAL continuity (no gaps)" || fail "WAL continuity ($gaps gap(s))"

# Zero-byte / name validation reuses the existing validator.
"$SCRIPT_DIR/validate-wal-archive.sh" "$ARCHIVE_ROOT/wal" >/dev/null 2>&1 \
  && pass "WAL file validation" || fail "WAL file validation"

# Freshness of the newest segment (the copy is a snapshot, so this tells how far
# the archive reaches, not whether a receiver is running).
newest=$(find "$ARCHIVE_ROOT/wal" -maxdepth 1 -type f -printf '%T@ %f\n' | sort -n | tail -1)
if [[ -n "$newest" ]]; then
  ts=${newest%% *}
  age_h=$(( ( $(date +%s) - ${ts%.*} ) / 3600 ))
  echo "Newest WAL: ${newest#* } ($(date -d "@${ts%.*}" -Is 2>/dev/null || echo "$ts"), ${age_h} h old)"
  [[ "$age_h" -le "$MAX_WAL_AGE_H" ]] && pass "WAL freshness" \
    || warn "WAL freshness (archive ends ${age_h} h ago; limit ${MAX_WAL_AGE_H} h)"
fi

# Base backups: complete = has base.tar.zst, directory name has no .partial suffix.
complete=0
if [[ -d "$ARCHIVE_ROOT/base" ]]; then
  while IFS= read -r d; do
    n=$(basename "$d")
    if [[ "$n" == *.partial ]]; then
      echo "Base $n: unfinished (ignored)"
    elif [[ -s "$d/base.tar.zst" ]]; then
      echo "Base $n: ok ($(du -sh "$d" | cut -f1))"
      complete=$((complete+1))
    else
      echo "Base $n: missing base.tar.zst"
    fi
  done < <(find "$ARCHIVE_ROOT/base" -mindepth 1 -maxdepth 1 -type d | sort)
fi
[[ "$complete" -gt 0 ]] && pass "Complete base backup" || fail "Complete base backup"

echo "=========================="
if [[ "$FAIL" -eq 0 && "$WARN" -eq 0 ]]; then echo "OVERALL: PASS"; exit 0
elif [[ "$FAIL" -eq 0 ]]; then echo "OVERALL: WARN"; exit 0
else echo "OVERALL: FAIL"; exit 1; fi
