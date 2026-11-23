#!/usr/bin/env bash
# Pack lab files for upload to .46 / .68
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="/tmp/pesowise-ha-lab-pack.tar.gz"
tar -czf "$OUT" -C "$ROOT/tools" priyanshu-ha-lab
echo "$OUT"
