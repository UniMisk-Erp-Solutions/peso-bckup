# Testing & Validation

## Phase 3 — RCA-A fix

| Check | Result |
|-------|--------|
| serviceLoop uses deliverClaimedBatch | Implemented |
| Duplicate-only → ack failure | Implemented |
| tallySyncJobPoll unit tests | Pass |
| Connector tsc build | Pass |
| E2E Tally report rows | Pending (Tally HTTP) |

## Phase 2 — empty report investigation

| Check | Result |
|-------|--------|
| Batch XML includes DPR UDFs | Pass 88/88 (`_phase2-batch-udf-audit.mjs`) |
| Tally ack created/altered | 0/0 — confirms RCA-A |
| SafeMenu TDL | Confirmed empty shell (RCA-B) |
| Live Tally ledger export | Blocked — Tally HTTP offline on audit PC |

## Phase 1 (audit) — completed checks

| Check | Method | Result |
|-------|--------|--------|
| Architecture trace | Code review of Edge, mapper, connector, TDL, UI | Documented in `01-current-architecture.md` |
| Existing unit tests | `src/lib/__tests__/tally*.test.ts` | 213+ tally-scoped tests referenced in integration docs |
| Connector EXE build path | `package.json` + `build-win-exe.mjs` | Present; not run in Phase 1 |
| Production docs overlap | `docs/tally-integration/FINAL-PRODUCTION-ARCHITECTURE.md` | Aligned; noted doc drift on Alter policy |

## Mandatory failure tests (future phases)

Tracked for Phases 6–10:

- Browser refresh / close during sync
- Logout during sync
- Connector restart / Windows restart
- Network loss, Tally closed, wrong company
- Duplicate imports, partial batch failure

## Phase 1 rollback

**N/A** — no code or schema changes in Phase 1.
