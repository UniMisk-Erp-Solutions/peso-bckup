#!/usr/bin/env bash
# Build & run full React staging frontend (PesoWise-only).
set -euo pipefail
REPO="${REPO_ROOT:-/tmp/pesowise-migration-staging/frontend-src}"
COMPOSE="$REPO/tools/pesowise-migration/docker-compose.staging-react.yml"
CONTAINER=pesowise-react-migration-staging

if [[ ! -f "$REPO/package.json" ]]; then
  echo "Missing repo at $REPO — extract frontend-src tarball first." >&2
  exit 1
fi

docker rm -f "$CONTAINER" 2>/dev/null || true
docker compose -f "$COMPOSE" build --no-cache
docker compose -f "$COMPOSE" up -d

SHA=$(docker inspect "$CONTAINER" --format '{{.Id}}' 2>/dev/null | cut -c1-12)
echo "REACT_STAGING_CONTAINER=$CONTAINER"
echo "REACT_STAGING_URL=http://127.0.0.1:5175"
echo "REACT_STAGING_IMAGE_SHA=$SHA"
curl -sf -o /dev/null http://127.0.0.1:5175/ && echo "REACT_STAGING_HTTP=200" || echo "REACT_STAGING_HTTP=FAIL"
