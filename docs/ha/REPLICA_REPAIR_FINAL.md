# Replica repair — final report (.46 → .68)

**Date:** 2026-09-25  
**Promotion performed:** **No**  
**App routing changed:** **No** (still Traefik → HAProxy → Kong `.46` → Postgres `.46`)

---

## A. Original failure

Standby stopped applying WAL; receiver inactive; ~32h replay age; `expenses` thousands of rows behind; `.68` logs: **WAL segment already removed**.

## B. Root cause

No dedicated physical slot for `.68` + lag → required WAL recycled on `.46`. Secondary: **`replicator` password on `.46` out of sync** with preserved `.68` `primary_conninfo` (blocked `pg_basebackup` until fixed).

## C. Repair path

**PATH B — rebuild standby** via `pg_basebackup` from `.46` into fresh volume data dir; preserved old PGDATA as `_data.preserved-20260925T095317Z`.

## D. Files / config changed

| Location | Change |
|----------|--------|
| `.68` volume `…/_data` | Replaced via `pg_basebackup` (~943 MB) |
| `.68` `postgresql.auto.conf` | Restored from preserve + **`primary_slot_name = 'pesowise_68_standby'`** |
| `.68` `standby.signal` | Present |
| `.46` role `replicator` | Password **re-synchronized** (via `supabase_admin`; value not recorded in repo) |
| Repo | `scripts/ha/rebuild-68-standby.sh`, `verify-replication-68.sh`, HA docs |

## E. Replication slot

**`pesowise_68_standby`** (physical, active). **`pesowise_pitr` untouched.**

## F. Auth / network

- `pg_hba`: existing `host replication replicator 192.168.23.68/32 scram-sha-256` (unchanged).
- `pg_basebackup` / streaming use **`--network host`** on `.68` so source IP is `.68/32`.
- `supabase_admin` used only to **`ALTER USER replicator`** (not for streaming).

## G. `.68` rebuilt?

**Yes** — full physical base backup; old data **preserved by rename**, not deleted.

## H. WAL receiver status

**`streaming`**, slot **`pesowise_68_standby`**, sender **192.168.23.46:5432**.

## I. Catch-up duration

Initial base backup ~**3 minutes**; replay caught up to **sub-second** replay age immediately after start.

## J. Final byte lag

Receive LSN ≈ replay LSN ≈ primary (e.g. `0/C4046810` at first steady check).

## K. Final replay lag

**~0.05–0.25 s** on standby (`pg_last_xact_replay_timestamp`); **&lt; 1 s** on primary `main` walsender.

## L. Data validation

| Table | Primary | Standby |
|-------|---------|---------|
| `expenses` | 24713 | 24713 |
| `organizations` | 5 | 5 |
| `notifications` | 84829 | 84829 |

LSN/receiver metrics treated as authoritative; counts matched after catch-up.

## M. Stability (initial window)

See `REPLICATION_STABILITY_REPORT.md` — **PASS** for ~6 min sampled; recommend **60 min** continued watch on `.68`.

## N. PITR status

Remote SQL: **`pesowise_pitr` active**. Run **`check-pitr-health.sh` on `.46`** for full PASS (WAL dir + `pg_receivewal`).

## O. App routing

**`.68` not in HAProxy app path**; unchanged `.46`-only L7.

## P. Remaining risks

1. **Stale walsender row** on `.46` for `.68` with ~58 min lag (empty `application_name`) — clean up when logged in on `.46`.
2. **Async replication** — RPO &gt; 0 under load.
3. **Failover untested** — promotion, fencing, endpoint switch not executed.
4. **Replicator password** was reset on `.46` — store in vault; preserved `.68` auto.conf updated to match.

## Q. Rollback

- Stop `.68` DB container; restore `_data` from `_data.preserved-20260925T095317Z` (rename back); **do not** promote.
- Old preserved copy remains on disk unless operator removes it after burn-in.

## R. Readiness for failover rehearsal

| Criterion | Met |
|-----------|-----|
| `.68` in recovery | **Yes** |
| WAL receiver streaming | **Yes** |
| LSN lag near zero | **Yes** |
| System ID match | **Yes** |
| Only `.46` writable | **Yes** |
| PITR unchanged | **Yes** (verify script on `.46`) |
| Stability 30–60 min | **Partial** (short window PASS) |
| Controlled failover test | **Not yet** |

**Next approved phase:** **controlled manual failover rehearsal** (not promotion in production traffic).

---

## SUCCESS CRITERIA (this task)

Replica repair **complete** for operational HA standby purposes, with follow-up: extended stability watch + stale walsender cleanup + PITR health on `.46`.

**REPLICATION: READY**  
**FAILOVER: NOT YET TESTED**
