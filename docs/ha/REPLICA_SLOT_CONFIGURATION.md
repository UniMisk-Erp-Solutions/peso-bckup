# Replication slot configuration (.68 standby)

**Date:** 2026-09-25  
**Primary:** `192.168.23.46` (`supabase-db-kar0ro1k6jiyfxzzw7acnsza`)

## Design

| Slot | Type | Purpose | Touch during replica repair? |
|------|------|---------|------------------------------|
| `pesowise_pitr` | physical | PITR / `pg_receivewal` | **No** |
| `pesowise_68_standby` | physical | Dedicated `.68` streaming standby | **Created / used** |
| Logical (Realtime, etc.) | logical | Supabase Realtime | **No** |

## `pesowise_68_standby`

- **Created on:** `.46` before rebuild (physical, for `.68` only).
- **Standby setting:** `primary_slot_name = 'pesowise_68_standby'` in `postgresql.auto.conf` + `standby.signal`.
- **Base backup:** `pg_basebackup … -S pesowise_68_standby` (creates/uses slot; does not reuse `pesowise_pitr`).

## Verification (post-repair)

```
slot_name            | slot_type | active | restart_lsn
pesowise_68_standby  | physical  | t      | advances with primary WAL
pesowise_pitr        | physical  | t      | unchanged
```

Standby `pg_stat_wal_receiver.slot_name` = **`pesowise_68_standby`**, `status` = **`streaming`**.

## WAL retention

- Slot prevents recurrence of “WAL already removed” for **this** standby while connected.
- Monitor disk on `.46`; `max_slot_wal_keep_size` / volume usage unchanged by this task.

## Do not

- Drop `pesowise_pitr`.
- Point `.68` at `pesowise_pitr`.
- Share one physical slot between PITR archive and standby.
