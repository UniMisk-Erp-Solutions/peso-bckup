# Off-host backup gate (O)

**Status:** **BLOCKED**

## Required vs current

| Requirement | Status |
|-------------|--------|
| Database backup off-host | **Missing** — only `/tmp/pesowise-migration-backup/` on host `192.168.23.46` |
| WAL archive off-host | **Missing** — WAL PITR path not wired to authorized remote |
| MinIO/object backup off-host | **Missing** |
| Retention policy on remote | **Not configured** |
| Checksum verification on remote | **Not configured** |
| Failure monitoring / alerting | **Not configured** |
| Restore runbook to off-host copies | **Not written** |

## What exists (local only — does not satisfy Gate O)

- Native dump: `/tmp/pesowise-migration-backup/pesowise-20260930T062343Z.dump` + SHA-256 sidecar
- Gate scripts and reports under `/tmp/pesowise-migration-backup/`

## Unblock

Operator must authorize a **PesoWise-only** off-host destination (path, credentials, retention). Then add PesoWise-scoped sync jobs without touching unrelated backup repositories.

**Gate O cannot be PASS until that destination exists.**
