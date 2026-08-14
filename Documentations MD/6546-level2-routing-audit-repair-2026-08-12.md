# MicroLink Employee 6546 — Level 2 Routing & Audit Repair

**Doc ID:** DOC-092
**Status:** deployed
**Last updated:** 2026-08-12
**Owner / area:** Expense Hierarchy Review, Production Data Integrity

---

## 1) Summary

One-time, owner-authorized Production data repair for 100 real MicroLink
expenses belonging to employee 6546 (Aswinkumar). All 100 were left with
`status='level_2_verified'` but `approval_tier='executive'` (an inconsistent
combination — a real `level_2_verified` row should carry `approval_tier
='engineer'`) and zero `tier_advanced` audit trail, even though a real
executive (Kunvar Thakor) genuinely performed the Level 2 action. The repair
corrected `approval_tier` for exactly those 100 rows and backfilled truthful,
non-fabricated audit evidence — without re-running verification, without
touching status, and without any financial mutation.

---

## 2) Problem / requirement

A read-only forensic audit (prompted by the owner reporting that employee
6546's previously-visible "Level 1 Verified" expenses had disappeared) traced
the exact mechanism: the `main`-branch (Production's deployed) `ExpenseService
.advanceExpenseTier()` derived the verify "tier" from the expense's own stale
`approval_tier` column, not the caller's real current role. This morning's
separate, correct, reviewer-pointer-only repair
(`supervisor_reassignment_repair_log`, batch `microlink_2026-08-12`) made
Kunvar Thakor (role: executive) the assigned reviewer for 100 long-pending
expenses whose stale `approval_tier` snapshot still read `'team_leader'` (from
their original 2026-07-04 submission to a prior supervisor). When Kunvar
verified them, the server (authoritative on `status`) correctly advanced
`status` to `level_2_verified`, but the client sent the wrong
`p_next_approval_tier` (`'executive'`, computed from the stale snapshot) and
then threw the legacy "Run Supabase migration 20260524260000..." error —
*before* reaching the audit-log write, because its own predicted status
(`level_1_verified`) didn't match the server's real one. This is the exact
Issue 2 (role/tier divergence) defect already fixed on this debug branch
(`07495ac`); that fix was not yet deployed to Production when this happened.

A separate 58 sibling expenses for the same employee were verified the same
day via the same real action but were unaffected, because their pre-existing
`approval_tier` snapshot (`'executive'`, from a genuine earlier Level 1 verify)
happened to already match Kunvar's real role — no mismatch, no throw, normal
audit trail written.

Full forensic detail: see the read-only audit conversation preceding this
repair (SSH + `pg_get_functiondef` + Git history of both `main` and this
branch; zero Production writes during that phase).

---

## 3) Solution

Additive, guarded, idempotent one-time repair migration
(`20260812150000_repair_6546_level2_routing_and_audit.sql`):

1. Resolves the MicroLink organization and employee 6546 from business keys
   (name / `employee_id`), never hardcoded UUIDs, so it fails loudly if
   identity has drifted.
2. Builds the exact candidate population: `status='level_2_verified'`,
   `approval_tier='executive'`, no existing `approved_by`/`approved_at`, and
   no existing `tier_advanced` audit row for that expense. Proven via
   read-only set-difference query to match the original 100-row
   `supervisor_reassignment_repair_log` population with zero discrepancy in
   either direction, and to never match any of the 58 already-correct
   siblings.
3. Asserts the count is exactly 100 and aborts otherwise — refuses to guess
   at an unproven population. A rerun with 0 candidates is a clean no-op
   (`RAISE NOTICE`, `RETURN`), not an error.
4. Defensively re-verifies each candidate's `assigned_reviewer_id`/
   `assigned_engineer_id` already equals the proven-correct value (Kunvar
   Thakor — see below) before writing anything.
5. Updates **only** `approval_tier` (`'executive' → 'engineer'`).
   `assigned_reviewer_id`/`assigned_engineer_id` are deliberately left
   untouched (already correct — see §4). `status`, amounts, attachments,
   category, `batch_id`, `transaction_number`, `approved_by`, `approved_at`
   are never referenced. `updated_at` is deliberately **not** set — the
   existing value is the real, provable timestamp of when the server-side
   transition actually committed inside the original (failed-client-side)
   RPC call, and preserving it is more truthful than overwriting it with the
   repair time.
6. Inserts one truthful `tier_advanced` audit row per repaired expense,
   attributed to Kunvar Thakor (the real actor, proven by the forensic
   audit) — never to admin/system/the migration itself. The comment
   explicitly distinguishes the historical event (citing that row's own
   pre-repair `updated_at` as the proven historical timestamp) from this
   reconstruction (recorded now, at repair time). No timestamp is
   backdated. Carries the deterministic marker
   `6546_level2_metadata_repair_20260812` for de-duplication and
   traceability.
7. Asserts exact row counts after both the `UPDATE` and the `INSERT`,
   aborting on any partial-failure mismatch.

**Correct downstream routing was proven, not assumed**, from the 58 already-
correct sibling rows: all 58 unanimously show `assigned_reviewer_id =
assigned_engineer_id = Kunvar Thakor himself` — because employee 6546 has no
team configured in this organization, so the app's own routing (in the
absence of a team `manager_user_id`) keeps the acting executive as the final-
tier assignee rather than escalating further. This matches what the 100
candidate rows already had from this morning's earlier repair, so no
reviewer/engineer field change was needed for them at all.

**Verification, in order:**
- Dry-run inside `BEGIN; ... ROLLBACK;` against Production matched every
  expected value exactly: 100 rows repaired, all 158 uniformly reached
  `level_2_verified`/`engineer` inside the transaction, 100 audit rows
  inserted (500 total), zero financial-field changes — then `ROLLBACK`
  returned the database to the *exact* original state (100
  executive/58 engineer, 400 audit rows).
- Permanent apply produced the identical result for real: 158/158 correctly
  routed, 0 executive-tier remaining, 0 approved/rejected, 0 financial
  changes, `updated_at` preserved exactly, and the idempotency check (rerun
  candidate count) confirmed 0.
- Read-only `expense_hierarchy_reviewer_can_act` check: Kunvar Thakor →
  ALLOW, old supervisor Mahamkali Venkateswara Rao → DENY — matching the
  same authority pattern already proven for the 58 reference rows.

---

## 4) Key files

```
supabase/migrations/20260812150000_repair_6546_level2_routing_and_audit.sql
src/services/__tests__/repair6546Level2RoutingAndAudit.test.ts
```

---

## 5) Database / migrations

`20260812150000_repair_6546_level2_routing_and_audit.sql` — applied to
Production (owner-authorized) 2026-08-12 via `psql -f` over SSH+docker (this
project's established manual-apply convention), after a full validated backup
(`pg_restore --list` passed, SHA-256 recorded) and a targeted CSV snapshot of
all 158 affected expenses, their 400 pre-repair `audit_logs` rows, and the
original 100-row `supervisor_reassignment_repair_log` entries. Dry-run
(`BEGIN...ROLLBACK`) matched the permanent apply exactly before the real
write was made.

---

## 6) Test plan

- [x] `src/services/__tests__/repair6546Level2RoutingAndAudit.test.ts` — source
      guards: candidate selector matches only the proven bad-state pattern,
      never the 58 correct siblings; exact-100 assertion; idempotent no-op on
      rerun; `UPDATE` touches only `approval_tier`; never touches `status`,
      financial fields, or `updated_at`; never touches
      `assigned_reviewer_id`/`assigned_engineer_id`; audit entry attributed to
      the real actor with a truthful, non-fabricated comment; deterministic
      repair marker present; exact post-write count assertions.
- [x] Live dry-run (`BEGIN...ROLLBACK`) against Production — exact expected
      before/after/after-rollback state, described above.
- [x] Live permanent apply against Production — exact expected final state,
      described above.
- [x] Full validation gauntlet on the debug branch after the repair: `tsc`,
      `typecheck:api`, `build`, `migrations:check`, `security:secrets` all
      clean; `i18n:check` fails with the same pre-existing unrelated tooling
      error (not a regression); 3028 tests passing (3015 baseline + 13 new),
      0 failures; lint matches the exact pre-existing baseline (373
      errors/84 warnings), no new issues.

---

## 7) Related docs

- [supervisor-hierarchy-runtime-fixes-2026-08-12.md](./supervisor-hierarchy-runtime-fixes-2026-08-12.md)
  (DOC-091) — the Issue 1–4 code fixes, including the Issue 2 (role/tier
  divergence) fix whose absence from Production caused this data corruption.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-12 | 1.0 | Agent | Initial doc — one-time repair of 100 real MicroLink employee-6546 expenses, applied and verified live on Production, dry-run proven identical to the permanent apply. |
