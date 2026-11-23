#!/usr/bin/env bash
# Reject known PesoWise production PostgreSQL data paths.
set -euo pipefail
path="${1:-}"
path=$(readlink -f "$path" 2>/dev/null || echo "$path")
block_patterns=(
  "/var/lib/postgresql/data"
  "kar0ro1k6jiyfxzzw7acnsza"
  "supabase-db-kar0ro1k6jiyfxzzw7acnsza"
  "/data/coolify/services/kar0ro1k6jiyfxzzw7acnsza"
)
for p in "${block_patterns[@]}"; do
  if [[ "$path" == *"$p"* ]]; then
    echo "BLOCKED: path matches production marker: $p" >&2
    exit 1
  fi
done
exit 0
