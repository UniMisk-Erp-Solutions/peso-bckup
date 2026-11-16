#!/usr/bin/env bash
set -euo pipefail
WAL_DIR="${1:-}"
[[ -n "$WAL_DIR" && -d "$WAL_DIR" ]] || { echo "FAIL: WAL dir missing"; exit 1; }

STATUS="PASS"
WARN=0
OLDEST="" NEWEST="" COUNT=0
while IFS= read -r f; do
  COUNT=$((COUNT+1))
  base=$(basename "$f")
  [[ "$base" =~ ^[0-9A-F]{24}$ ]] || WARN=1
  [[ -s "$f" ]] || { echo "FAIL: zero-byte $f"; exit 1; }
  ts=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")
  [[ -z "$OLDEST" || ts -lt OLDEST ]] && OLDEST=$ts
  [[ -z "$NEWEST" || ts -gt NEWEST ]] && NEWEST=$ts
done < <(find "$WAL_DIR" -maxdepth 1 -type f 2>/dev/null)

[[ "$COUNT" -gt 0 ]] || { echo "FAIL: no WAL files"; exit 1; }
[[ "$WARN" -eq 0 ]] || STATUS="WARN"
echo "WAL VALIDATION: $STATUS files=$COUNT dir=$WAL_DIR"
if [[ -n "$OLDEST" && -n "$NEWEST" ]]; then
  echo "oldest=$(date -d "@$OLDEST" -Is 2>/dev/null || date -r "$OLDEST" -Is) newest=$(date -d "@$NEWEST" -Is 2>/dev/null || date -r "$NEWEST" -Is)"
fi
[[ "$STATUS" == "FAIL" ]] && exit 1
exit 0
