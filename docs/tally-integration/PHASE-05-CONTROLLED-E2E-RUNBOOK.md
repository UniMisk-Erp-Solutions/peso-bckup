# Phase 5 — one controlled metadata E2E runbook

**Scope:** one report → metadata ledger CREATE → ACK → `completed`. No accounting vouchers in this gate.

## Preconditions

- [ ] Migration `20261007150000_tally_metadata_revision.sql` applied on target Supabase
- [ ] `set_tally_org_company_v1` → **PesoWise Integration Test**
- [ ] Agent paired (`doctor` exit 0)
- [ ] TallyPrime open, company **PesoWise Integration Test**, port **9000** localhost only
- [ ] No pending smoke batches (quarantine dry-run empty)

## Steps

1. **Pair** (if not done): see `AGENT-PAIRING-AND-SECURITY.md`
2. **Doctor:** `node connector/tally/dist/main.js doctor`
3. **Start Agent:** `node connector/tally/dist/main.js run` (single instance; dev only — installer will use startup task)
4. **PesoWise Admin:** Reports → **one** report (e.g. Daily Project) → minimal filters → **Sync to Tally**
5. Watch Agent log: `%USERPROFILE%\PesoWise\TallyConnector\connector.log`
6. Confirm job `completed`; new `PW-META-…` ledger in Tally; `tally_delivery_state.last_metadata_revision = 1`

## Fail closed

- Tally down → no completed job; user message per architecture doc
- Company mismatch → failed ack, batch retry

## Do not

- Run quarantine on empty batches
- Import old smoke jobs
- Use HTTP Alter for metadata updates
