# Expense State-Machine Integrity + Transaction-Number Guarantee

**Doc ID:** DOC-122
**Status:** deployed *(Production 2026-09-07)*
**Last updated:** 2026-09-07
**Owner / area:** Expenses — approval state machine, transaction numbering

---

## 1) Summary

DOC-121 reported a symptom: 13 approved MicroLink expenses with no transaction
number. This document is the cause.

> **An expense could go from `draft` straight to `approved`, never passing
> through `submitted`.**

The missing transaction number was a *consequence*: the numbering trigger fired
only on the transition **into** `submitted`, so an expense that skipped that
transition reached a terminal state permanently unnumbered.

The bypass was **still reachable on current `main`** — not a historical bug that
had already been fixed.

Two independent invariants now hold:

| | |
|---|---|
| **A** | an illegal entry into the review workflow cannot commit |
| **B** | any expense in a protected state carries a transaction number |

B is deliberately not a substitute for A. An illegal `draft → approved` is
**rejected**, not "approved but numbered".

---

## 2) Root cause

`review_approve_expense_manager_override_v1` gated the source status with a
**deny-list of terminal statuses**:

```sql
-- (b) Terminal expenses are never re-approved (fail fast before any locking).
IF e.status IN ('approved', 'rejected', 'paid') THEN
  RAISE EXCEPTION 'This expense is already %', e.status;
END IF;
```

`draft` is not terminal, so it passed straight through to the approval `UPDATE`.

**Every other approval and verification path uses an allow-list of source
statuses.** This function was the only exception:

| function | source-status gate |
|---|---|
| `review_approve_expense` | `NOT IN ('submitted','edited','level_2_verified')` → allow-list |
| `review_approve_expense_v2` | delegates to the above |
| `review_verify_expense` | `NOT IN ('submitted','edited','level_1_verified','level_2_verified')` |
| `review_admin_verify_expense` | `NOT IN ('submitted','edited')` |
| `review_verify_batch_atomic_v1` | allow-list **and** explicitly excludes `draft` when selecting candidates |
| **`review_approve_expense_manager_override_v1`** | **deny-list of terminal statuses only** |

The function is reachable from bulk Manager Override in
`EngineerReview.tsx` → `ExpenseService.approveExpenseManagerOverride`.

### Proven empirically, not inferred from names

A transition matrix was run against a full restore of Production, driving the
**real RPCs** as the real engineer actor:

| from | approve_v1 | approve_v2 | **mgr_override** | verify | admin_verify |
|---|---|---|---|---|---|
| **draft** | rejected | rejected | **ALLOWED → approved** | rejected | rejected |
| submitted | ALLOWED | ALLOWED | ALLOWED | ALLOWED | rejected |
| under_review | rejected | rejected | ALLOWED | rejected | rejected |
| edited | ALLOWED | ALLOWED | ALLOWED | ALLOWED | rejected |
| level_1_verified | rejected | rejected | ALLOWED | rejected | rejected |
| level_2_verified | ALLOWED | ALLOWED | ALLOWED | ALLOWED | rejected |
| verified | rejected | rejected | ALLOWED | rejected | rejected |
| rejected / approved / paid | rejected | rejected | rejected | rejected | rejected |

A raw `UPDATE ... SET status='approved'` from `draft` also succeeded, leaving the
transaction number NULL — there was no database backstop at all.

---

## 3) How the drafts got into a reviewer's hands

The 13 are not random. **Each is a batch child, and in every one of the 13
batches exactly one sibling lacks both a transaction number and an
`expense_submitted` audit event, while every other sibling has both:**

| siblings in batch | with number | without |
|---|---|---|
| 8 | 7 | 1 |
| 5 | 4 | 1 |
| 5 | 4 | 1 |
| 3 | 2 | 1 |
| 3 | 2 | 1 |
| 2 (×8 batches) | 1 | 1 |

So batch submission left one child behind in `draft` while its siblings became
`submitted` — the partial-batch failure shape recorded in DOC-117. Those orphans
stayed visible under their batch, and on **2026-08-19** a single engineer ran a
bulk approval of 1,887 expenses via Manager Override, which swept them up:

```
comment: "Bulk approved (Manager override) Manager override approval"
```

Two defects in series. This document closes the second; the first is DOC-117's.

---

## 4) The fix

### Invariant A — one canonical rule, two enforcement points

```sql
public.expense_status_transition_allowed_v1(p_from text, p_to text) → boolean
```

It deliberately encodes **one proven rule** rather than a re-invented state
machine: an expense may not jump from the pre-submission state directly into a
protected workflow state. `draft → submitted` stays legal; `draft → rejected` and
`draft → edited` stay legal; everything from a non-draft source is untouched.

This is the single place to extend if further transitions are ever proven
illegal — never by adding a second, divergent rule elsewhere.

It is used by **both**:

1. `review_approve_expense_manager_override_v1`, as a new step (b2). Nothing else
   about override semantics changed — it still bypasses the tier gate, still
   honours the engineer approval limit, still refuses self-review, still performs
   the same atomic balance deduction. The function body was reproduced verbatim
   from the migration that defines it (proven identical to the live definition)
   with only that block added.
2. `enforce_expense_status_transition`, a `BEFORE UPDATE` trigger on
   `public.expenses` — the backstop for any other route: a future buggy RPC, a
   direct `UPDATE`, a careless script. It is named to sort **before**
   `trigger_assign_transaction_number` so an illegal move is refused without
   first consuming a value from the organization's counter.

### Invariant B — protected implies numbered

`assign_transaction_number` now allocates whenever a row **enters any protected
state** without a number, rather than only on entering `submitted`:

```sql
IF NEW.transaction_number IS NULL
   AND NEW.organization_id IS NOT NULL
   AND public._expense_status_is_protected_v1(NEW.status::text)
   AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
THEN
  NEW.transaction_number := public.generate_transaction_number(NEW.organization_id);
END IF;
```

This is a strict **superset** of the previous behaviour, so no existing flow can
lose a number it used to get. The column stays nullable on purpose: `draft`,
`rejected` and `edited` are not protected and legitimately carry NULL.

### Integrity probe

`public.expenses_missing_transaction_number_v1()` — service-role only, since it
enumerates rows across every tenant.

---

## 5) The generator, and why it is safe

| | |
|---|---|
| Function | `generate_transaction_number(org_id uuid)` |
| Source | `organization_transaction_sequences.next_number`, one row per organization |
| Mechanism | upsert the row, `SELECT … FOR UPDATE`, then `UPDATE … SET next_number = next_number + 1 RETURNING` |
| `nextval()` | not used |
| `MAX()+1` | **not used** |
| Format | `LPAD(n, 5, '0')` |
| Uniqueness scope | **per organization** — enforced by `UNIQUE (transaction_number, organization_id)` |

Allocation is serialised by a row lock held to the end of the transaction, so
concurrent submissions inside one organization queue behind each other; different
organizations take different rows and do not contend. Two organizations
legitimately printing the same value is correct, not a collision.

---

## 6) Proof

All of the following ran against a **full restore of a fresh verified Production
backup**, with every guard trigger and the organization policy active.

### Transition matrix, after the fix

Identical to the before-matrix in every cell **except** `draft`/`mgr_override`,
which is now rejected. Every legitimate override — from `under_review`,
`level_1_verified`, `level_2_verified`, `verified`, `submitted`, `edited` — still
works.

### Direct-SQL backstop

| attempt | result |
|---|---|
| draft → approved / verified / level_1_verified / level_2_verified / under_review / paid | **REJECTED** (`PW003`) |
| draft → submitted | allowed, number allocated |
| draft → rejected / edited | allowed, correctly unnumbered |

### Concurrency

| test | result |
|---|---|
| 50 simultaneous submissions | 50/50 processed, 0 failed, **0 NULL**, **0 duplicates** |
| 200 submissions through 25 simultaneous connections | 200/200 processed, 0 failed, **0 NULL**, **0 duplicates**, numbers a contiguous block of 200 |

200 *literal* simultaneous connections could not be tested: the server's
`max_connections` is 100 and the live stack already holds ~60. Production has the
same ceiling and pools behind PostgREST, so 25 concurrent writers exercising 200
submissions is the faithful equivalent, and it is stated as such rather than
claimed as a 200-connection run.

### Rollback

A submission that allocates a number and then fails leaves the counter advanced
and the expense still `draft` and unnumbered. The consumed value is **never**
reclaimed or reused. Gaps are correct and expected.

### Regression

| flow | result |
|---|---|
| draft → submitted → level_1 → level_2 → verified → approved → paid | every step OK, one number allocated at `submitted` and retained |
| draft → submitted → rejected → edited → submitted → approved | every step OK |
| INSERT directly as `submitted` / `verified` / `approved` (the admin-submit shape) | numbered on insert |
| INSERT as `draft` | correctly unnumbered |
| `review_verify_batch_atomic_v1` candidate selection | unchanged, still excludes `draft` |

---

## 7) Report NULL-safety — audited, and found already correct

The forensic harness bug that dropped 12 rows through
`a || '|' || nullable || '|' || b` prompted a sweep for the same shape in product
code. **It is not there.**

* Every `||` involving `transaction_number` in live SQL is either
  `COALESCE`-guarded or is an `ILIKE '%' || <search term> || '%'` search
  predicate, where a NULL number simply fails to match a number search — correct
  behaviour, not row loss.
* `report_full_expense_detail_rows_v1` guards its filter as
  `p_transaction_number IS NULL OR e.transaction_number ILIKE …`, so an unfiltered
  call includes unnumbered rows.
* `report_balance_timeline_rows_v3` orders with an explicit `NULLS LAST`.
* Client code renders it as `?? "—"`, `?? "-"` or `|| "-"` throughout; there is no
  non-null assertion and no unguarded interpolation.

**Row-omission bugs found: 0. Fixed: 0 — none were needed.**

### All 13 appear where they should

| surface | result |
|---|---|
| Full Expense Detail (internal row builder, by id) | 13/13 built, all with a blank number |
| Full Expense Detail (paged public RPC, per-expense window) | **13/13 present** |
| Expense rows report (per-expense window) | **13/13 present** |
| Balance deductions | 13 rows, ₹6,020.00 |

A first pass appeared to show 0/13 in the expense-rows report. That was a defect
in the *check*, not the report: those rows are keyed `id`, not `expense_id`. A
control expense — a numbered batch sibling in the same window — was equally
"missing", which proved the query was wrong rather than the report. Corrected, it
returns 13/13.

---

## 8) Deployment

| | |
|---|---|
| Migration | `supabase/migrations/20260907220000_expense_state_machine_and_transaction_number_integrity.sql` |
| Pre-deploy backup | `20260907T233000Z-pre-state-machine-hotfix.dump`, sha256 `4a792869…`, 2,389 TOC entries |
| Dry run | `BEGIN … ROLLBACK` on Production: all objects created, rule evaluated, **0 survived the rollback** |
| Applied as | `supabase_admin` (owner of `public.expenses` and the affected functions) |
| Business rows changed | **0** — fingerprint `6b286e118d28e4df88c9201f26a33b10` identical before and after |

### Post-deploy, on Production

| check | result |
|---|---|
| draft → approved / verified / level_1 / level_2 / under_review / paid | REJECTED |
| draft → submitted | allowed, numbered |
| draft → rejected / edited | allowed, unnumbered |
| drafts still unnumbered | 100, by design |
| the 13 legacy rows | still 13, still `approved`, still unnumbered |
| `expenses_missing_transaction_number_v1()` | 13 |
| fingerprint after probes | unchanged |

---

## 9) The 13 legacy rows were not touched

They are classified **LEGACY-NUMBER-NEVER-ASSIGNED**. 22 verified backups prove
no number ever existed for them (DOC-121), so there is nothing to restore, and
this hotfix mints nothing for them. The owner's decision on that is separate.

One consequence to be aware of: because Invariant B allocates on *entering* a
protected state, if one of the 13 is ever legitimately transitioned again — for
example `approved → paid` — it will acquire a number at that moment. Nothing in
this deployment causes such a transition.

---

## 10) Key files

```
supabase/migrations/20260907220000_expense_state_machine_and_transaction_number_integrity.sql
supabase/migrations/20260810160000_manager_override_approve_prepared.sql   # the function this supersedes
src/pages/EngineerReview.tsx                                              # bulk override caller (unchanged)
src/services/ExpenseService.ts                                            # approveExpenseManagerOverride (unchanged)
```

No application code was changed. The defect was entirely server-side, and fixing
it in the database closes it for every caller at once.

---

## 11) Test plan / verification performed

1. ✅ Root cause proven by transition matrix against real RPCs on a full restore, not inferred from function names.
2. ✅ Confirmed the live function is byte-identical in logic to the repository migration, so `main` reproduces the bug.
3. ✅ Confirmed every other approval/verify path already uses an allow-list.
4. ✅ Batch-sibling analysis established how drafts reached a reviewer.
5. ✅ Post-fix matrix identical to pre-fix except the one illegal cell.
6. ✅ Direct-SQL backstop proven for all six illegal targets.
7. ✅ 50-way and 200-submission concurrency: 0 NULL, 0 duplicate, 0 failed.
8. ✅ Rollback proven not to reuse a consumed counter value.
9. ✅ Full hierarchy ladder and reject/resubmit regression pass.
10. ✅ Report NULL-safety swept in SQL and client; no omission bugs found.
11. ✅ All 13 proven present in Full Expense Detail and the expense-rows report.
12. ✅ Production dry run left nothing behind; the real apply changed 0 business rows.
13. ✅ Post-deploy probes on Production, rolled back, fingerprint unchanged.

---

---

## 12) Follow-up (2026-09-08)

**The fix held.** Every expense created since this deployment was audited:
138 new expenses, **0** canonical-validator failures, **0** protected rows
without a transaction number, **0** illegal state transitions, **0** batch orphan
children, **0** draft-versus-database losses. The batch failure signature that
produced the original 13 does not recur.

The decision pack in §9 was answered: the owner chose to allocate new current
numbers, and the 13 received **19528 – 19540**. The consequence noted in §9 —
that a future legitimate transition would have numbered them anyway — is now
moot.

A read-only health check was added,
`public.expense_integrity_report_v1(p_days)`, which reuses the canonical
validator so it cannot drift from what the database enforces. Empty result =
healthy.

See [DOC-123](./legacy-transaction-number-allocation-and-post-deploy-audit.md).

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-07 | 1.0 | Claude Code | Root-caused the NULL transaction numbers to a state-machine bypass: `review_approve_expense_manager_override_v1` gated its source status with a deny-list of terminal statuses, so `draft` — not terminal — passed through to `SET status='approved'`. Proven still reachable on current `main` by a transition matrix driving the real RPCs against a full Production restore; every other approval/verify path already used an allow-list. Established the delivery mechanism: each of the 13 is a batch child whose siblings were submitted normally, swept up by a 1,887-expense bulk Manager Override on 2026-08-19. Fixed with one canonical rule, `expense_status_transition_allowed_v1`, enforced at both the RPC and a `BEFORE UPDATE` backstop trigger, plus a generalised `assign_transaction_number` that allocates on entering any protected state. Post-fix matrix identical to pre-fix except the single illegal cell. Concurrency 50-way and 200-submission: 0 NULL, 0 duplicate. Report NULL-safety swept — no product-code omission bugs existed. Deployed to Production with 0 business rows changed (identical fingerprint); the 13 legacy rows deliberately untouched. |
| 2026-09-08 | 1.1 | Claude Code | Post-deployment audit confirms the fix held: 138 new expenses, 0 validator failures, 0 protected-unnumbered, 0 illegal transitions, 0 batch orphans, 0 draft-vs-DB losses. The batch failure signature does not recur. The §9 decision pack was answered - the 13 were allocated 19528-19540. Added expense_integrity_report_v1 as a service-role read-only health check. See DOC-123. |
