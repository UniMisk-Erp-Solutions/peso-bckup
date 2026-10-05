#!/usr/bin/env bash
# DOC-129 — Expense Recycle Bin daily purge (host-level, mirrors the
# established report-worker-dispatch.sh pattern: a host crontab entry,
# direct docker exec into the Postgres container, no new HTTP surface, no
# secret duplicated or stored anywhere new).
#
# NOT yet installed on the server crontab -- this is the reviewed script to
# install, plus the crontab line below, once explicitly authorized. Prepared
# alongside the Recycle Bin feature per Part N; installing a new recurring
# production job is a separate, standing infrastructure change from
# applying a migration, so it is not done automatically.
#
# Install (as webadmin, on the Production host):
#   cp purge-trashed-expenses.sh /home/webadmin/purge-trashed-expenses.sh
#   chmod +x /home/webadmin/purge-trashed-expenses.sh
#   crontab -e
#     # DOC-129: Recycle Bin daily purge (30-day retention)
#     17 3 * * * /home/webadmin/purge-trashed-expenses.sh >> /home/webadmin/purge-trashed-expenses.log 2>&1
#
# What it does, every run:
#   1. Calls purge_expired_trashed_expenses_v1() directly via psql (service_
#      role-only at the API layer; a direct psql connection as supabase_admin
#      is the function owner and always may call it, exactly like every other
#      maintenance script in this repo's history) -- deletes every Recycle
#      Bin row past its 30-day purge_after, after its own per-row recheck.
#   2. Independently retries Storage cleanup for ANY tombstone (from today
#      OR a previous run) whose storage_cleanup_done is still false, using
#      the Storage API with the service_role key read fresh from the
#      edge-functions container's own environment -- never a duplicated
#      secret. A failed Storage delete simply leaves the flag false for
#      tomorrow's run to retry; the database row is already gone either way,
#      so nothing is ever lost, only a stray Storage object outlives its
#      tombstone by a day or two in the worst case.
set -euo pipefail

CONTAINER="supabase-db-evo3o0fdjaroxq7uohrm21cp"
EDGE_CONTAINER="supabase-edge-functions-evo3o0fdjaroxq7uohrm21cp"
STORAGE_URL="https://pesowise-supabase.unimisk.com/storage/v1"
BUCKET="receipts"

log() { echo "[$(date '+%F %T %Z')] $*"; }

# Overlap protection (same non-blocking flock idiom as this project's own
# supabase-backup.sh): if a previous run is still in flight -- a stuck
# Storage call, a slow purge on a large backlog -- skip this tick rather
# than run two purges concurrently. purge_expired_trashed_expenses_v1's own
# FOR UPDATE SKIP LOCKED already makes concurrent runs individually safe,
# but there is no reason to ever let two overlap in normal operation.
exec 9>"/var/lock/pesowise-purge-trashed-expenses.lock"
if ! flock -n 9; then
  log "===== purge-trashed-expenses: SKIP -- another run is already in progress ====="
  exit 0
fi

log "===== purge-trashed-expenses: START ====="

# Step 1: DB purge (idempotent; SKIP LOCKED inside the function means this
# is also safe to run concurrently with itself, though cron's own lock
# semantics already prevent overlap in the normal case).
RESULT=$(docker exec "$CONTAINER" psql -X -q -t -A -U supabase_admin -d postgres \
  -c "SELECT purge_expired_trashed_expenses_v1();")
log "purge_expired_trashed_expenses_v1 -> $RESULT"

PURGED=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('purged_count',0))" 2>/dev/null || echo "?")
SKIPPED=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('skipped_count',0))" 2>/dev/null || echo "?")
log "purged=$PURGED skipped=$SKIPPED"

# Step 2: retry Storage cleanup for any not-yet-cleaned tombstone (today's
# and any prior day's leftovers).
PENDING=$(docker exec "$CONTAINER" psql -X -q -t -A -U supabase_admin -d postgres \
  -c "SELECT id || '|' || (attachment_paths::text) FROM purged_expense_tombstones WHERE storage_cleanup_done = false AND jsonb_array_length(attachment_paths) > 0;")

if [ -z "$PENDING" ]; then
  log "no pending Storage cleanup"
else
  SERVICE_KEY=$(docker exec "$EDGE_CONTAINER" printenv SUPABASE_SERVICE_ROLE_KEY 2>/dev/null || true)
  if [ -z "$SERVICE_KEY" ]; then
    log "WARNING: could not read SUPABASE_SERVICE_ROLE_KEY from $EDGE_CONTAINER -- skipping Storage cleanup this run, will retry tomorrow"
  else
    while IFS='|' read -r tombstone_id paths_json; do
      [ -z "$tombstone_id" ] && continue
      ok=1
      for path in $(echo "$paths_json" | python3 -c "import sys,json; [print(p) for p in json.load(sys.stdin)]" 2>/dev/null); do
        resp=$(curl -s -w "\n%{http_code}" -X DELETE \
          "$STORAGE_URL/object/$BUCKET/$path" \
          -H "Authorization: Bearer $SERVICE_KEY" -H "apikey: $SERVICE_KEY")
        code=$(echo "$resp" | tail -1)
        body=$(echo "$resp" | sed '$d')
        # 200/204 deleted. This self-hosted Storage API returns HTTP 400 at
        # the transport layer for "object not found" (confirmed live) even
        # though its OWN JSON body correctly reports statusCode "404" --
        # the transport code alone is not trustworthy here, so "already
        # gone" is also detected from the body, not just the wire status.
        if [ "$code" = "200" ] || [ "$code" = "204" ]; then
          : # deleted
        elif echo "$body" | grep -q '"error":"not_found"'; then
          : # already gone -- also success
        else
          log "Storage delete FAILED ($code) for $path (tombstone $tombstone_id): $body -- will retry tomorrow"
          ok=0
        fi
      done
      if [ "$ok" = "1" ]; then
        docker exec "$CONTAINER" psql -X -q -U supabase_admin -d postgres \
          -c "SELECT mark_tombstone_storage_cleaned_v1('$tombstone_id'::uuid);" >/dev/null
        log "Storage cleanup done for tombstone $tombstone_id"
      fi
    done <<< "$PENDING"
  fi
fi

log "===== purge-trashed-expenses: END ====="
