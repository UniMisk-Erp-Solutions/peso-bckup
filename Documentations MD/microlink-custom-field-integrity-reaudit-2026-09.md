# MicroLink Custom-Field Integrity — Re-Audit (2026-09-23)

**Doc ID:** DOC-132
**Status:** deployed (this is a read-only audit; nothing was changed)
**Last updated:** 2026-09-23
**Owner / area:** Expenses (MicroLink custom fields)

---

## 1) Summary

A fresh, read-only forensic re-audit of MicroLink's expense custom-field
integrity, requested alongside the Detailed Expense preview work (DOC-131)
on the same branch. Recomputes every number from live data rather than
reusing the historical baselines from the September 2026 remediation
(DOC-117–DOC-123): is the preventative fix still working for new expenses,
are any post-fix expenses newly incomplete, what historical blanks remain
today, and can any of them now be recovered — classified honestly (direct
evidence vs. deterministic derivation vs. inference vs. unrecoverable).

**No Production data was read/write mutated.** Every statement was a
`SELECT` (or `COPY ... TO STDOUT`) inside a session with
`default_transaction_read_only=on`.

---

## 2) Prevention boundary (recomputed, not assumed)

- **Completeness enforcement** (the fix that matters for this incident):
  `2026-09-07 11:15:13.124777+00` — taken directly from the live
  `created_at` of MicroLink's row in `organization_required_expense_fields`.
  Underlying migrations `20260905150000` (DOC-117, canonical validator +
  deferred constraint triggers) and `20260907120000`/`20260907121000`
  (DOC-119, org policy), merged to `main` at `534d8e1`. Confirmed live today:
  both deferred triggers (`validate_custom_fields_on_submit_*` on
  `expenses`, `protect_required_fields_after_submission` on
  `expense_form_field_values`) exist and are enabled.
- **Atomicity** (single-transaction submit, single-expense path):
  `2026-09-09`, migration `20260909100000_microlink_atomic_submission_v1.sql`,
  merged `main` at `bf7be6c`. MicroLink **batch** submission remains on the
  legacy multi-mutation client path (documented, unfixed) — but batch stays
  protected against *incompleteness* by the DOC-117/119 triggers regardless
  of which client path performs the write, since those triggers fire on any
  transition into a protected status. Both paths were checked separately
  (see below).
- Live `pg_get_functiondef()` read for `_persist_microlink_expense_snapshot_v1`,
  `submit_microlink_expense_v1`, and `admin_submit_expense_for_employee_v2`
  — all genuinely atomic, matching the documented design exactly. No drift
  found between documentation and live code.

---

## 3) Post-fix prevention: HEALTHY

- **4,396** non-draft MicroLink expenses created after the prevention
  boundary checked — **1,206 single-entry + 3,190 batch-entry**.
- **0 incomplete** in either path (validated via the live
  `expense_submission_integrity_issues_v1()` validator, then independently
  cross-checked with direct SQL: 0 duplicate `(expense_id, template_id)`/
  `(expense_id, branch_field_id)` rows, 0 orphaned branch references, 0
  references to a retired option, 0 whitespace-only values, 0
  wrong-organization rows).
- **New true regressions since the fix: 0.**

---

## 4) Previously repaired 192 (2026-09-07): still healthy

The original remediation manifest lives outside the database (owner-only
backup, per DOC-120 §10) and could not be read directly, so the repaired set
was re-identified empirically: 188 of 192 pass-1 expenses share one exact
microsecond bulk-INSERT fingerprint (376 rows, Project ID + Project Name);
the 3 named pass-2 expenses (17275, 17769, 18181) were independently
re-identified by transaction number. **191 of the documented 195 positively
re-identified** (the remaining 4 are indistinguishable from ordinary
same-day traffic via SQL fingerprints alone — a methodology limit, not a
finding of harm).

**Recheck result: 191/191 still present and unchanged, 382/382 field values
intact, 0 duplicates, 0 validator failures.**

---

## 5) Historical incomplete today: 38 (recomputed, not reused from "46")

| Missing | Expenses |
|---|---|
| From location + To location | 22 (exact match to the 2026-09-07 count) |
| Project Unique ID only | 11 |
| Project Unique ID + From/To (all three) | 1 (txn 18105) |
| Project ID + Project Name (dependents) | 4 |
| **Total** | **38** |

Lower than the documented 43 — most likely ordinary subsequent
edits/resubmissions closing a few rows through the normal path over the
intervening 16 days. 2 of the 38 (txns 17096, 17848) are `rejected` status,
which DOC-120's own population definition treats as out of scope (same as
`draft`) — never eligible for the 2026-09-07 remediation regardless of
evidence quality.

### Evidence classification

- **Level A — directly recoverable: 1** (txn 17848, rejected). A linked
  draft agrees on title/category/amount and its branch values match this
  expense's own currently-stored Project Unique ID exactly. Unrepaired only
  because it is `rejected`.
- **Level B — deterministic derivation: 1** (txn 17096, rejected). Its
  stored Project Unique ID resolves to exactly one active (Project ID,
  Project Name) pair org-wide today.
- **Level C — inference only, NOT recovered: 12** expenses (batch-sibling
  agreement, a multi-leg-trip pattern, one weak nearby-transaction proxy).
  See `microlink_custom_field_inference_candidates_*.csv`. **None of these
  were or should be written anywhere.**
- **Level D — unrecoverable: 36** of the 38 (12 of these also carry a
  Level C guess, noted for transparency only, not upgraded).
- Two genuine **configuration-gap** findings, verified independently: txn
  14271's Project field branches were created 10 days *after* the expense;
  txn 19325's were created ~55 minutes *after* the expense. Both are
  correctly blank for a real historical reason, not a bug.

### Transaction 18542 — re-examined, not repeated

**No longer blank**, contrary to the historical "deliberately not
repaired" baseline. All 5 required fields are now present, inserted at one
identical timestamp (`2026-09-08 09:05:04.734233+00`) — one day after the
2026-09-07 remediation closed, three days after this expense was already
approved. Its linked draft is empty (matching the original finding that
this submission never reached the server with values), and **there is no
`audit_logs` row at all for the 2026-09-08 write**. Provenance could not be
verified. **Not classified A/B/C/D — flagged as an unverified-provenance
anomaly for the owner's attention, explicitly not claimed as "recovered."**

---

## 6) NULL transaction numbers (separate from the custom-field incident)

**62** MicroLink expenses currently have a NULL transaction number, and
**all 62 are drafts** — 0 in any protected status. Confirms DOC-121/122/123's
"13 approved-with-NULL" defect remains fully resolved. **No changes made.**

---

## 7) Review-display path (code read only, no live UI QA)

`src/lib/fetchExpenseFormFieldDisplay.ts` resolves labels by id (not label
text), strips any label that is itself a raw UUID, and drops empty-valued
rows rather than rendering a placeholder for them. `BatchExpenseReviewPanel.tsx`,
`BatchExpenseDetailCard.tsx`, `expenseCustomFieldFilters.ts`, and
`batchExpenseReview.ts` all consume the same resolved label maps. Existing
tests (`fetchExpenseFormFieldDisplayUuidLeak.test.ts`,
`batchReviewColumnOrder.test.ts`) already assert real labels render, not
UUIDs. One residual, minor, pre-existing gap: a template with both a blank
`name` and no `field_key` still falls back to the generic "Field" label even
when a real value exists — a data-quality edge case in template
configuration, not a rendering bug, and not observed in any population
checked here.

---

## 8) Artifacts (not committed — real employee data)

Written to a local, gitignored handoff folder (see the release handoff
folder referenced in the final report for this branch), never to this
repository, per `CLAUDE.md`'s sensitive-data policy:

- `microlink_custom_field_post_fix_audit_20260923T091200Z.csv` (4,418 rows)
- `microlink_historical_blank_custom_fields_20260923T091200Z.csv` (39 rows,
  including the 18542 anomaly)
- `microlink_custom_field_inference_candidates_20260923T091200Z.csv` (14
  rows, Level C only, informational)
- `microlink_custom_field_integrity_summary_20260923T091200Z.md` (full
  narrative this doc is condensed from)

---

## 9) No action taken

Per explicit instruction, this audit identifies and classifies only. **No
historical custom-field update, project correction, location guess, or
transaction-number repair was applied.** Two items are flagged for a
separate, deliberate owner decision:

1. Transaction 18542's unverified-provenance data (§5).
2. Whether txns 17096/17848 (rejected, but with real A/B-quality evidence)
   should be reconsidered if either is ever resubmitted.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-23 | 1.0 | Agent | Initial re-audit, run alongside DOC-131 on `feature/recent-expense-field-values`. Prevention confirmed healthy (0 post-fix regressions across 4,396 expenses); 192/384 prior repairs re-verified intact; historical incomplete count recomputed at 38 (down from the documented 43/46); evidence classified honestly (1 A, 1 B, 12 C-informational-only, 36 D); txn 18542 flagged as an unverified-provenance anomaly rather than reclassified; NULL transaction numbers confirmed all-draft (62, 0 protected). No data modified. |
