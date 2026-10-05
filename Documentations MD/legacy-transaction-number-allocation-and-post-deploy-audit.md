# Legacy Transaction-Number Allocation + Post-Deployment Integrity Audit

**Doc ID:** DOC-123
**Status:** deployed *(Production 2026-09-08)*
**Last updated:** 2026-09-08
**Owner / area:** Expenses — transaction numbering, post-deployment assurance

---

## 1) Summary

Two things, both finished:

**A. The 13 legacy approved MicroLink expenses now have transaction numbers.**
The owner chose Option B from DOC-122's decision pack. They received **19528 –
19540** from the current canonical sequence.

> These are **newly assigned identifiers**. They are not restored, recovered,
> original or historical numbers. 22 verified backups prove no number ever
> existed for these expenses (DOC-121). No numeric gap was filled and no
> workflow history was rewritten.

**B. Every expense created since the final prevention deployment has been
audited. There is no recurrence, and no new regression.**

| | |
|---|---|
| New expenses audited | **138** |
| Canonical validator failures | **0** |
| Protected expenses with no number | **0** |
| Illegal state transitions | **0** |
| Batch orphan children | **0** |
| Draft-vs-database silent losses | **0** |
| Report omissions | **0** |

---

## 2) The audit window, derived rather than assumed

Migrations here are applied manually over SSH, and
`supabase_migrations.schema_migrations` holds a single stale row, so it is not a
usable record. The authoritative landmarks are the **server-recorded mtimes of
the pre-deploy backups** — immutable, and independent of the labels chosen for
the filenames. Those labels turned out **not** to match real server time, which
is exactly why the mtime was used instead.

| Landmark (file mtime, UTC) | What went live immediately after |
|---|---|
| 2026-09-05 18:58:21 | custom-field submission validator (DOC-117) |
| 2026-09-07 11:08:21 | organization mandatory fields (DOC-119) |
| **2026-09-07 14:24:08** | **state machine + transaction-number guarantee (DOC-122)** |

```
AUDIT_START_UTC = 2026-09-07 14:24:08+00
AUDIT_START_IST = 2026-09-07 19:54:08
```

Every expense is bucketed by era so that a row created in a deployment gap is
never mistaken for a regression:

| Era | Protected expenses | Validator failures |
|---|---|---|
| A — before custom-field prevention | 23,791 | 44 |
| B1 — custom-field prevention only | 450 | 1 |
| B2 — \+ organization mandatory fields | 77 | 0 |
| **C — ALL LAYERS LIVE** | **138** | **0** |

Ten expenses were created between the landmark and the migration finishing.
They sit in era C and are clean, so the few minutes of ambiguity change nothing.

---

## 3) How the 13 were numbered

| | |
|---|---|
| Population | recomputed in the transaction, never a hardcoded list; asserted to be exactly 13 |
| Generator | `generate_transaction_number` — the canonical per-organization, row-locked counter |
| `MAX()+1` | not used |
| Gap filling | not done |
| Order | `approved_at` ASC, then `created_at` ASC, then id — recorded and reproducible |
| Numbers issued | **19528 – 19540** |
| Counter | 19527 → 19540, exactly +13, no live traffic interleaved |
| Fake workflow events | none — no status change, no submitted/verified/approved event invented |
| Written columns | `expenses.transaction_number` only |

Every target was locked `FOR UPDATE` and re-asserted **after** locking to still
be MicroLink, still `approved`, and still unnumbered. The `UPDATE` itself
carried `AND transaction_number IS NULL` so it could not overwrite a value that
appeared concurrently.

### Provenance

One `legacy_transaction_number_assigned` audit row per expense, following the
existing maintenance-action convention already used by `routing_repair`,
`batch_repair_detach` and `expense_balance_historical_repair`, and written by the
same maintenance actor as those earlier owner-authorized repairs. Each records
the allocation timestamp, the new number, and states plainly that it is a newly
assigned identifier rather than a recovered original.

### What the transaction proved before committing

13 numbers landed and match what was allocated · all 13 distinct · organization-
scoped uniqueness intact across the whole table · **no transaction number outside
the 13 changed** · expense count, status, approval timestamps, approval tiers,
business dates, amounts and batch membership fingerprints all identical ·
deduction count and sum, ledger count, summed profile balances unchanged ·
custom-field count and value fingerprint unchanged · `audit_logs` grew by exactly
13 rows, all of them the maintenance action.

Rehearsed first on a full restore of a fresh verified backup
(`20260908T000000Z-pre-legacy-number-allocation.dump`, sha256 `bcd49021…`,
2,398 TOC entries), where it committed with the identical result.

---

## 4) Post-deployment audit results

### All tenants, era C

138 new expenses — 135 MicroLink, 3 another tenant — every one `submitted`, none
draft. Zero missing organization, user, category, business date, amount, status
or title. Every employee identity resolves.

### Transaction numbers

| | |
|---|---|
| Protected expenses | 138 |
| Protected with no number | **0** |
| Drafts numbered unexpectedly | 0 |
| Duplicate numbers within an organization (whole table) | **0** |

### MicroLink mandatory project fields — checked structurally, not just for text

All **134** new MicroLink protected expenses:

| Check | Failures |
|---|---|
| Project Unique ID present | 0 |
| Project ID present | 0 |
| Project Name present | 0 |
| Stored branch belongs to the **selected** UID | 0 |
| Branch is active, not retired | 0 |
| The UID has an active Project ID branch definition | 0 |
| The UID has an active Project Name branch definition | 0 |
| Stored value is inside its branch's legal options (268 values) | 0 |

### Location fields

Every category that requires From/To has them: Travelling 111/111, Petrol 19/19.
The categories showing blanks (Material Purchase, Courier, Hotel/Guest House and
others) do not require those fields — confirmed by the canonical validator
passing all 138 rather than by reading the blank counts.

### Lifecycle, override and batches

| | |
|---|---|
| Protected without a recorded submission | **0** |
| Without a creation event | 0 |
| Manager Override actions since deployment | **0** (none attempted) |
| Batches touched | 30, containing 101 children |
| Draft children left behind | **0** |
| Batches mixing draft and submitted children | **0** |

The historical failure signature — N−1 siblings submitted, one child silently
left in `draft` — **does not recur**. For contrast, that pattern produced 4 such
children in era A and 27 in era B; era C has none.

### Draft-versus-database consistency

34 new MicroLink expenses still have a linked submission draft. All 34 carry both
`branchValues` and `formFieldValues`, and in **neither direction** is there a
value present in the draft but absent from the database. **0 silent losses.**

### Report visibility

138/138 appear in the Full Expense Detail report, and the internal row builder
returns 138/138.

Two intermediate checks looked like omissions and were both wrong, for reasons
worth recording:

* A whole-window query showed 49 "missing" — those windows exceeded the report's
  500-row page, so the rows were simply not on page 1.
* A day-window paging test reported "51 of 94 missing" — that window filtered on
  **business date** while the 94 were selected by **creation date**, and trips
  ranged back a week. Exactly 43 of the 94 have a business date within the
  window, which is precisely how many were found.

Scoped per expense to its own employee and its own business date: **138 present,
0 page-capped, 0 absent.**

---

## 5) Exceptions, classified

139 exception rows exist across all history. **Every one is pre-deployment.**

| Category | Count | Meaning |
|---|---|---|
| CRITICAL, post-deployment | **0** | — |
| Historical — missing required fields | 45 | 43 MicroLink (21 From/To, 21 project, 1 To location) + 2 in another tenant, all documented in DOC-120 as unrecoverable |
| Historical — lifecycle only | 94 | protected rows with a creation but no recorded submission; audit logging was less complete in the past. **All are numbered.** |
| Non-critical | — | drafts are legitimately incomplete and are never reported |

---

## 6) The daily integrity query

```sql
SELECT * FROM public.expense_integrity_report_v1();          -- last 7 days
SELECT * FROM public.expense_integrity_report_v1(30);        -- last 30 days
```

Service-role only. Returns **only** rows that are actually wrong: mandatory
fields missing per the live canonical validator, a protected expense with no
transaction number, or a protected expense with no recorded submission. It
reuses `validate_expense_submission_invariants_v1` rather than reimplementing
it, so it cannot drift from what the database enforces. It returns identifiers
and status only — no names, emails or amounts.

**An empty result means healthy.** The `predates_full_prevention` column
separates known historical stragglers from genuine new regressions, so a row
appearing does not automatically mean something broke today.

### A precision fix worth recording

The first version flagged any protected expense lacking an `expense_submitted`
event. Over a 400-day window that returned **1,341 rows** — useless as a health
check. The cause was legacy audit incompleteness, not bypasses: 200 rows in one
tenant carry *no* audit history at all (a bulk import on 2026-08-13), and older
rows predate complete audit logging. Every one of them is numbered and none is
post-prevention.

Requiring an `expense_created` event before flagging brought it to **139**, all
historical. A check that cries wolf is worse than no check.

---

## 7) Scope discipline

Mutations in this task were exactly:

1. `transaction_number` on the 13 legacy approved MicroLink rows
2. 13 maintenance audit rows recording that assignment
3. one read-only integrity function

Nothing else. No status change, no approval change, no financial mutation, no
historical custom-field inference, no other organization touched.

---

## 8) Key files

```
supabase/migrations/20260908060000_expense_integrity_daily_report.sql
```

The allocation itself was a one-time transactional data operation, not a
migration. Its plan, the per-row provenance and the audit workbook are held
locally and in the server-side manifest — deliberately not in Git, since they
contain employee identifiers and business values.

---

## 9) Test plan / verification performed

1. ✅ `origin/main` confirmed to contain `24f29b6`; all prevention layers verified live before any write.
2. ✅ The 13 recomputed from scratch and matched against the historical incident signature; none had acquired a number naturally.
3. ✅ Allocation rehearsed on a full restore of a fresh verified backup — committed with the identical 19528–19540 result.
4. ✅ Production applied in one transaction with locking, post-write assertions and full fingerprint comparison.
5. ✅ Post-commit readback: 13/13 numbered, 0 protected-unnumbered anywhere, 0 duplicates, counter +13 exactly.
6. ✅ Audit window derived from immutable server-side backup mtimes, not assumed.
7. ✅ Live canonical validator run against all 138 new protected expenses — 0 failures.
8. ✅ MicroLink project fields checked structurally, including branch-to-UID correspondence and legal-option membership.
9. ✅ Batch, override, lifecycle, financial and draft-consistency audits — all clean.
10. ✅ Report visibility proven per expense after two flawed intermediate checks were diagnosed rather than reported.
11. ✅ Integrity function tightened after it produced 1,341 false positives, then re-verified.
12. ✅ Audit workbook generated and read back programmatically; every exception confirmed pre-deployment.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-08 | 1.0 | Claude Code | Owner chose to allocate new numbers to the 13 legacy approved MicroLink expenses; issued 19528–19540 from the canonical per-organization generator in one guarded transaction, with the population recomputed rather than hardcoded, rows locked and re-asserted, and full before/after fingerprints proving no other transaction number, status, approval timestamp, amount, balance or custom field moved. Recorded as NEWLY ASSIGNED identifiers, never as recovered originals; no gap filled, no workflow event faked. Then audited every expense created since the final prevention deployment, with the window derived from immutable backup mtimes after the filename labels proved not to match server time: 138 new expenses, 0 validator failures, 0 protected-unnumbered, 0 illegal transitions, 0 batch orphans, 0 draft-vs-DB losses, 0 report omissions. All 139 exceptions in the database are pre-deployment. Added `expense_integrity_report_v1`, a service-role read-only health check reusing the canonical validator, after tightening it from 1,341 false positives down to 139 genuine historical rows. |
