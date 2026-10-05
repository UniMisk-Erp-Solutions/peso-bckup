# Expense Transaction Number — NULL Audit (forensic, no mutation)

**Doc ID:** DOC-121
**Status:** deployed *(audit complete 2026-09-07 — read-only, nothing changed)*
**Last updated:** 2026-09-07
**Owner / area:** Expenses — transaction numbering

---

## 1) Summary

113 expenses across four organizations carry a NULL `transaction_number`.

**100 of them are drafts, and that is correct by design.** The remaining
**13 are approved MicroLink expenses**, and those are a real defect.

The governing question was not "how do we fill these in" but **"did a
transaction number ever exist for them?"** Across 22 verified backups reaching
back to 2026-08-08, **it never did**. Nothing was lost. A number was simply
never assigned.

**No transaction number was created, changed, shifted or reused. This audit
mutated nothing.**

---

## 2) How a transaction number is produced

```sql
CREATE TRIGGER trigger_assign_transaction_number
  BEFORE INSERT OR UPDATE ON public.expenses FOR EACH ROW
  EXECUTE FUNCTION assign_transaction_number()
```

```sql
IF NEW.status = 'submitted'
   AND (OLD.status IS NULL OR OLD.status != 'submitted')
   AND NEW.transaction_number IS NULL
   AND NEW.organization_id IS NOT NULL THEN
  NEW.transaction_number := generate_transaction_number(NEW.organization_id);
END IF;
```

`generate_transaction_number` takes the next value from the per-organization
counter `organization_transaction_sequences` under `SELECT … FOR UPDATE` and
formats it `LPAD(n, 5, '0')`.

The condition is the whole story: a number is assigned **only on the transition
*into* `submitted`**. A draft has none because it has not been submitted — that
is intended. But an expense that reaches `approved` **without ever passing
through `submitted`** never satisfies the condition, and once approved it never
will again.

---

## 3) The 13

| | |
|---|---|
| Organization | MicroLink (only) |
| Status | `approved`, all 13 |
| Created | 2026-07-02 → 2026-08-06 |
| Last updated | **2026-08-19**, all 13, between 11:25 and 14:14 IST |
| Audit trail | `expense_created > expense_approved` — **no `expense_submitted` event on any of them** |
| Category | 12 Travelling, 1 Other |
| Value | ₹6,020.00 |
| Balance footprint | **all 13 carry a balance deduction — this is real money** |

The single-day clustering of every `updated_at` on 2026-08-19 is the signature
of one administrative operation that moved these rows straight to `approved`.

No other organization has a single non-draft expense without a number:

| Organization | NULL txn | of which draft | of which non-draft |
|---|---|---|---|
| MicroLink | 54 | 41 | **13** |
| Patidar Travels | 46 | 46 | 0 |
| Bikes auto Hero | 11 | 11 | 0 |
| Mistry And Shah | 2 | 2 | 0 |

---

## 4) Was a number ever assigned and then lost?

No. Every one of 22 verified backups was restored and queried:

| | |
|---|---|
| Backups scanned | 22 (2026-08-08 → 2026-09-07) |
| Backups that restored usable | **22 of 22** |
| Expense rows in the oldest / newest | 13,628 / 24,545 |
| Of the 13, present in every backup | **13 of 13** |
| Ever carrying a transaction number | **0** |

**Verdict: no historical transaction number ever existed for these rows.**

### A false negative that was caught, not published

The first scan reported `rows_present=0` for *every* backup — including ones
taken hours earlier that certainly contain these expenses — and would have
produced the same "none ever existed" conclusion **for the wrong reason**.

The cause was `pg_restore -t expenses`: with `-t`, the table's `CREATE TABLE`
fails because the status enum type is not part of the selected object, so no
table exists and the query returns nothing. The row parser then silently
discarded the error text.

That verdict was rejected rather than reported. The restore was changed to
`--section=pre-data --schema=public` followed by `--data-only -t expenses`, and
the scanner now records each backup's actual `expenses` row count and marks a
backup **UNUSABLE** rather than counting it as evidence of absence. Absence of
evidence and a broken tool must not look alike.

---

## 5) Sequence accounting — and the inference that was deliberately not made

| Organization | `next_number` | expenses carrying a number |
|---|---|---|
| MicroLink | 19369 | 18,686 |
| Patidar Travels | 3100 | 3,018 |
| Bikes auto Hero | 1540 | 1,424 |
| Mistry And Shah | 1331 | 1,297 |
| Trial | 8 | 7 |

683 MicroLink numbers have been issued by the counter but appear on no expense
today — ordinary for a non-transactional counter (a rolled-back transaction
still consumes a value; deleted expenses take theirs with them).

**None of those 683 was attributed to any of the 13.** Doing so would be
inference from numeric gaps, which is exactly what this audit forbids. There is
no evidence linking any specific unused number to any specific expense, so no
link was asserted.

Equally: **no existing transaction number was altered or shifted**, and no
brand-new number was assigned to a legacy row.

---

## 6) Is it still happening?

No new occurrence since 2026-08-19.

| | |
|---|---|
| Newest affected expense created | 2026-08-06 |
| Newest update to any affected row | 2026-08-19 |
| Occurrences since | **0** |

The broader "reached a post-draft status with no `expense_submitted` audit row"
pattern does still exist elsewhere — including a 1,200-row migration batch in
another tenant on 2026-08-13 — but **every one of those rows carries a
transaction number**. Only these 13 combine the missing transition with a
missing number.

---

## 7) Impact

8 of the 13 fall inside July 2026, so the July Detailed Expense report renders
them with a blank Transaction Number column. Everything else on those rows —
employee, amount, category, project fields, approval trail, balance deduction —
is intact and correct. The blank is cosmetic in the report and consequential
only where a transaction number is used as a human reference.

---

## 8) Recommendation (NOT applied — needs an owner decision)

The trigger condition could be widened from *"transitions into `submitted`"* to
*"leaves `draft` with no number yet"*, which would close the hole for any future
direct-to-approved path.

That is deliberately **not** done here, for two reasons:

1. It is a behaviour change to financial-document numbering and belongs in its
   own reviewed migration, not in an audit.
2. Applying it does **not** retroactively fix these 13 — they are already
   `approved` and would need numbers assigned explicitly, which means minting
   **brand-new** numbers for legacy rows. That is out of scope by instruction
   and should be an explicit, separately-authorised decision, because a number
   minted today would sit out of sequence with the July dates it labels.

---

## 9) Method

Read-only throughout. Every query ran inside a `READ ONLY` transaction with
`default_transaction_read_only = on`; each backup was restored into a throwaway
database that was dropped immediately after, with a final check confirming zero
leftover databases.

---

## 10) Test plan / verification performed

1. ✅ Trigger and function bodies read from live Production, not from repository files.
2. ✅ Population enumerated per organization and per status.
3. ✅ Audit trail reconstructed for all 13 — none has an `expense_submitted` event.
4. ✅ Balance-deduction footprint confirmed for all 13.
5. ✅ 22 verified backups restored and queried; usable/unusable recorded per backup.
6. ✅ First scan's zero-row result rejected as a tooling artefact and re-run correctly.
7. ✅ Sequence counters compared with numbered-expense counts; gap inference explicitly declined.
8. ✅ Recurrence window checked — none since 2026-08-19.
9. ✅ Zero leftover throwaway databases.
10. ✅ Nothing mutated: no transaction number created, changed, shifted or reused.

---

---

## 11) ROOT CAUSE — found, and fixed (2026-09-07)

This document reported a **symptom**. The cause was found the same day and is
documented in full in [DOC-122](./expense-state-machine-integrity.md).

| | |
|---|---|
| **Symptom** | 13 approved MicroLink expenses carry no transaction number |
| **Root cause** | they reached `approved` **without ever entering `submitted`** |
| **Numbering consequence** | `assign_transaction_number` fired only on the transition *into* `submitted`, so it never ran for them — and, being terminal, they could never acquire one afterwards |

### The bypass

`review_approve_expense_manager_override_v1` gated its source status with a
**deny-list of terminal statuses** rather than an allow-list of pipeline
statuses:

```sql
IF e.status IN ('approved', 'rejected', 'paid') THEN
  RAISE EXCEPTION 'This expense is already %', e.status;
END IF;
```

`draft` is not terminal, so it passed straight through to the approval `UPDATE`.
Every other approval and verification path in the system already used an
allow-list and correctly refused a draft; this function was the only exception.

### Was it historical, or still live?

**Still live.** The function had not been amended since the migration that
created it on 2026-08-10, the live definition was proven identical in logic to
the one on `main`, and a transition matrix driving the real RPC against a full
Production restore reproduced `draft → approved` before the fix.

### How drafts reached a reviewer

Each of the 13 is a **batch child**. In every one of the 13 batches, exactly one
sibling lacks both a number and an `expense_submitted` audit event while all the
others have both — batch submission left one child behind in `draft`. On
2026-08-19 a single engineer bulk-approved 1,887 expenses through Manager
Override, which swept those orphans up.

### Fix

Deployed to Production 2026-09-07 as
`20260907220000_expense_state_machine_and_transaction_number_integrity.sql`:
one canonical rule (`expense_status_transition_allowed_v1`) enforced at both the
RPC and a `BEFORE UPDATE` backstop trigger, plus a generalised
`assign_transaction_number` that allocates on entering **any** protected state.

**The 13 were not modified.** See §8 of this document — the recommendation to
widen the trigger has now been implemented for future rows, and it deliberately
does not retroactively number these.

---

## 12) RESOLVED — the 13 were numbered on 2026-09-08

The owner reviewed the Option A / Option B analysis and chose to **allocate new
current numbers**. They received **19528 – 19540** from the canonical
per-organization generator.

This does not change anything in this document's findings. The numbers are
**newly assigned identifiers**, not recovered originals: the 22-backup proof in
§4 stands, and no numeric gap was filled. Each expense carries a
`legacy_transaction_number_assigned` audit row saying exactly that.

Details and the accompanying post-deployment integrity audit are in
[DOC-123](./legacy-transaction-number-allocation-and-post-deploy-audit.md).

The recommendation in §8 — widening the trigger — was implemented as part of
DOC-122 and deliberately did **not** retroactively number these rows; that was a
separate, explicit owner decision.

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-07 | 1.0 | Claude Code | Forensic audit of NULL `transaction_number`. 113 rows across 4 tenants; 100 are drafts and correct by design; 13 are approved MicroLink expenses (₹6,020, all with balance deductions) that reached `approved` without ever transitioning through `submitted`, so `assign_transaction_number` never fired. 22 verified backups (2026-08-08 → today) restored and queried: all 13 present in every one, none ever carrying a number — nothing was lost. A first scan returning zero rows for every backup was identified as a `pg_restore -t` enum-dependency artefact and rejected rather than reported; the scanner now distinguishes an unusable restore from genuine absence. 683 issued-but-unused MicroLink numbers exist; none was attributed to any expense, as that would be gap inference. No number created, changed or shifted. Trigger widening recommended but deliberately not applied. |
| 2026-09-07 | 1.1 | Claude Code | Root cause found and fixed the same day; see DOC-122. The 13 reached `approved` without ever entering `submitted`, because review_approve_expense_manager_override_v1 gated its source status with a deny-list of terminal statuses and `draft` is not terminal. Proven still reachable on current main, not historical-only. Delivery mechanism established: each of the 13 is a batch child left behind in draft by a partial batch submission, swept up by a 1,887-expense bulk Manager Override on 2026-08-19. Forward prevention deployed; the 13 remain unmodified and unnumbered pending the owner's decision. |
| 2026-09-08 | 1.2 | Claude Code | Owner chose to allocate new numbers; the 13 received 19528-19540 from the canonical generator on 2026-09-08. Recorded as newly assigned identifiers, not recovered originals - the 22-backup proof that no number ever existed is unchanged, and no gap was filled. See DOC-123. |
