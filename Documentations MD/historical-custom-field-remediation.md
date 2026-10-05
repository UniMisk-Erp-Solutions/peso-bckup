# Historical Custom-Field Remediation (direct evidence only)

**Doc ID:** DOC-120
**Status:** deployed *(MicroLink remediation applied 2026-09-07)*
**Last updated:** 2026-09-07
**Owner / area:** Expenses — custom form fields, historical data remediation

---

## 1) Summary

DOC-117 and DOC-119 stopped the leak. This repaired the damage that predates
them, for one organization, under a single governing rule:

> **Restore a value only when there is direct evidence of the value that
> belonged to that exact expense.** If the evidence does not identify the value,
> leave it blank.

**192 expenses repaired · 384 field values restored · 0 inferred · 0 ambiguous ·
0 existing values overwritten · 0 financial or status changes.**

46 expenses remain incomplete and are documented as unrecoverable rather than
guessed at.

---

## 2) Why counts were recomputed from scratch

Earlier investigations produced several different populations (≈209 project-field
rows, 39 invariant-incomplete, 37 MicroLink). None was reused. Everything here
was recomputed against current Production, and the authoritative population was
obtained by **calling the deployed validator itself** on every protected
MicroLink expense rather than by reimplementing its logic:

```
FOR each protected expense:
  BEGIN PERFORM validate_expense_submission_invariants_v1(id);
  EXCEPTION WHEN others THEN  -- record it
```

Three populations were built and intersected:

| Set | Definition | Size |
|---|---|---|
| **A** | any MicroLink expense missing Project Unique ID / Project ID / Project Name | 255 |
| **B** | protected expenses the **live invariant** rejects | 238 |
| **C** | expenses with historical recovery evidence | 5,796 |

`A ∩ B = 216`, `A ∩ C = 205`, `B ∩ C = 203`, `A ∩ B ∩ C = 202`.
`A \ B = 39` — all `draft`/`rejected`, i.e. not protected, so the invariant
correctly does not apply. `B \ A = 22` — the From/To location cases, which are
category-required rather than project fields.

---

## 3) Evidence hierarchy

| Level | Source | Auto-repair |
|---|---|---|
| **A1** | the exact expense held the value in a verified historical **database backup** | eligible |
| **A2** | the exact expense's **linked submission draft** holds the value, with unambiguous provenance | eligible |
| A3 | immutable server-side audit payload tied to the submission | eligible (none found) |
| B | multiple independent sources agree, no exact submitted state survives | **not** eligible |
| C | inference — same employee, neighbouring transaction, project trip range, majority usage | **not** eligible |
| D | ambiguous / no evidence | **not** eligible |

### A1 produced nothing — and that finding needed care

An initial backup pass appeared to recover 33 values across 21 expenses. It was
wrong: the extract returned **every** project/location value on those expenses,
not only the ones currently missing. Filtered correctly to actually-missing
fields, **19 verified backups yielded 0 (expense, field) pairs**. Every repair
here rests on A2.

### A2 was gated twice

* **§9 payload agreement** — a draft was used only when its `expense.title`,
  `expense.category` and `expense.amount` match the expense it is linked to.
  Across the population, 6,520 drafts matched and **366 did not**; the
  non-matching ones were discarded.
* **§8 chronology** — where drafts disagreed, supersession had to be *proven*,
  not assumed.

---

## 4) A previously "ambiguous" row that chronology resolved

One expense had been classified **AMBIGUOUS** in earlier work because two drafts
carried different Project IDs. Its lifecycle settles it:

| Time | Event | Project ID | Payload matches expense |
|---|---|---|---|
| 17:29:06 | draft | *first value* | yes |
| 17:29:07 | **expense_submitted** | | |
| 17:30:31 | expense_updated | | |
| 17:30:33 | draft | *second value* | **no** — mid-edit |
| 17:46:39 | expense_updated | | |
| 17:46:40 | draft | *second value* | **yes** |
| 17:53:45 | tier_advanced → later approved | | |

The employee submitted, then edited twice, settling on the second project. The
last payload-matching draft is the final state, so the earlier value is
superseded. **Reclassified D → A2** and repaired.

This is the general lesson: *drafts disagreeing does not by itself mean
ambiguous.* Order them, and check each against the expense it claims to describe.

---

## 5) What was repaired

| | |
|---|---|
| Expenses repaired | **192** |
| Fields restored | **384** — Project ID ×192, Project Name ×192 |
| Evidence level | **A2 ×384**, A1 ×0 |
| Resolved by supersession | 2 fields (1 expense) |
| Values inferred | **0** |
| Existing non-blank values overwritten | **0** |

Every target row was **absent**, so the operation was INSERT-only. Replace-all
writers were deliberately avoided so unrelated custom fields could not be
removed.

---

## 6) The prevention invariant stayed on

No trigger was disabled or dropped, no policy removed, no status changed to ease
a write, no `session_replication_role`. The repair had to satisfy the deployed
guard naturally, and `SET CONSTRAINTS ALL IMMEDIATE` forced it to prove that
before commit.

Each target's branch row was resolved from the **expense's own currently-stored
parent option value**, never from the plan — the same resolution the validator
performs.

### Preconditions, all checked inside the transaction

plan size unchanged · every target resolves to exactly one active branch
definition · every target still genuinely blank · every expense still in this
organization and still in a protected status.

### Post-write verification, before COMMIT

every value landed · **every repaired expense now passes the live invariant** ·
expense count, approved count, approved total, deduction count, ledger count,
summed profile balance and a status fingerprint all unchanged · custom-field row
count moved by exactly the intended number of inserts.

The transaction was written to `ROLLBACK` on any mismatch rather than commit and
check afterwards.

---

## 7) Rehearsal on a restored production database

A fresh verified backup was taken (2,374 TOC entries, SHA-256 recorded), restored
into an isolated database **with all three prevention triggers and the
organization policy intact**, and the *exact* repair plan applied there first.
It committed cleanly with the same 384/192 result. Only then was Production
touched.

---

## 8) What remains, and why

**46 protected expenses are still incomplete. All 46 are unrecoverable — none
was skipped for convenience.**

| Missing | Expenses | Why not repaired |
|---|---|---|
| From location + To location | 22 | **no draft in the entire population carries these fields** |
| Project Unique ID | 15 | no draft evidence; dependents are undefined without the parent |
| Project ID + Project Name | 9 | linked drafts exist but carry no branch values |
| Total | **46** | |

**Zero repaired rows still fail the invariant** — every one of the 192 became
fully valid.

### A counting bug worth recording

12 of those 46 were missed by the first classification pass. They carry a **NULL
`transaction_number`**, and the extraction concatenated that column into a
delimited string — one NULL made the whole row NULL, so those rows silently
vanished from the manifest. They were never repaired and never at risk; the
error was in reporting, not in the write. They have **no linked drafts at all**
and are unrecoverable.

Separately: **54 MicroLink expenses carry a NULL `transaction_number`.** That is
unrelated to this incident and is flagged for its own look.

### The expense that will stay blank

One transaction was confirmed unrecoverable in earlier forensics: its submitted
draft arrived with empty `branchValues` and `formFieldValues`, so the values
never reached the server. A candidate existed by inference only (Level C). It was
**not repaired**, and it appears in the unrecoverable manifest. A known blank
with documented provenance is safer than a plausible but unproven project value
attached to an approved, balance-deducted expense.

---

## 9) Scope discipline

Mutation scope was **MicroLink only**. Other tenants were analysed and left
untouched:

| Organization | Protected expenses | Historically incomplete | Rows modified |
|---|---|---|---|
| Patidar Travels | 2,987 | 0 | **0** |
| Bikes auto Hero | 1,421 | 0 | **0** |
| Mistry And Shah | 1,296 | 2 | **0** |
| Trial | 7 | 0 | **0** |

The two rows in the third organization are reported for separate review, as
instructed.

---

## 10) Provenance

A durable remediation manifest — batch id, backup path and checksum, and one
entry per restored field with its evidence level, source identifier and
timestamp — is stored owner-only under the server's secured backup directory at
`pesowise-safe-backups/remediations/<timestamp>/`, with its SHA-256 recorded.
It is deliberately **not** in Git: it contains expense identifiers and recovered
business values.

The same applies to the working manifests (`repair-plan.csv`, `evidence.json`,
`unrecoverable.csv`, the workbook). None is committed.

---

## 11) Key files

```
supabase/migrations/20260905150000_validate_expense_custom_fields_on_submit.sql   # DOC-117 prevention (live)
supabase/migrations/20260907120000_organization_required_expense_fields.sql       # DOC-119 prevention (live)
supabase/migrations/20260907121000_enable_project_fields_policy_for_microlink.sql # DOC-119 enablement (live)
```

This remediation added **no migration and no application code**. It was a
one-time, transactional data operation against Production, recorded in the
server-side manifest rather than in the schema.

---

## 12) Test plan / verification performed

1. ✅ Population recomputed from scratch by calling the live validator per expense.
2. ✅ Evidence gated on payload agreement and proven chronology.
3. ✅ A1 backup scan across 19 verified backups, correctly filtered — 0 recoveries.
4. ✅ Fresh Production backup taken and verified (`pg_restore -l`, SHA-256).
5. ✅ Exact plan rehearsed on a restore of that backup with prevention active — committed cleanly, 384/192.
6. ✅ Production applied in one guarded transaction with `SET CONSTRAINTS ALL IMMEDIATE` before commit.
7. ✅ Read-back from Production of every repaired expense.
8. ✅ Post-repair invariant scan; remaining rows classified.
9. ✅ Financial fingerprint identical before and after.
10. ✅ Workbook regenerated and re-opened programmatically; counts reconciled against SQL.

---

---

## 13) Second pass (2026-09-07) — three more expenses recovered

The first pass gated Level A2 on **payload agreement**: a linked draft counted
only when its `title`, `category` and `amount` all matched the expense. That was
the right default, and it is why the first pass has no wrong values in it. But it
discarded drafts that disagreed on a field the employee had *later edited* —
even when the same draft still held the project values, and the expense's own
Project Unique ID had never changed.

A second pass re-examined every remaining row on that narrower question:

> Does this expense's **own** linked draft record a project value, under a
> branch whose parent option is the UID the expense still carries?

Across all 46 remaining expenses, only **four** drafts held any branch value at
all, and one of those (`05178`) named a different project than the expense
stores and was rejected. Three were repaired.

### What made these deterministic rather than correlated

* A `branchValues` key **is** a branch row id, and `branch id -> parent_option_value`
  is **1:1 by schema** — verified live: 1,916 rows, 1,916 distinct ids, at most
  one parent each. So the draft's own content names the project, with no
  guessing.
* Each recovered value was additionally required to be a **legal active option**
  of that branch, in this organization, under the Project Unique ID template.
* Where the expense still stored a UID, the draft's implied UID had to **equal**
  it. The fields that disagreed (an amount on one, a title on the other) were
  fields the audit trail shows were edited afterwards; neither touches the
  project.

| txn | recovered | evidence | mismatch explained by |
|---|---|---|---|
| 17275 | Project ID, Project Name | own draft 17:45:45, UID unchanged | amount edited 17:46:50 |
| 17769 | Project ID, Project Name | own draft 2026-09-02 05:18, UID unchanged | title edited 16:51:50 |
| 18181 | **Project Unique ID**, Project ID, Project Name | own draft 4 s after submission; `formFieldValues` arrived `{}` (the DOC-117 signature) while `branchValues` survived | — |

### Configuration was checked against the clock, not just against today

Nine expenses looked repairable on "today the UID admits exactly one option".
Chronology cut that to two, and the check earned its place:

* **Six expenses** (txns 14271–14281, that UID) were created
  2026-08-22, but that UID's dependent branch configuration **was not created
  until 2026-09-01** — ten days later — and is absent from every backup before
  then. The dependent fields did not exist when these were submitted. They are
  blank for a legitimate historical reason, and filling them would invent data
  that never existed.
* **One expense** (txn 19325) was created 2026-09-07 13:51; its branch
  configuration was created **54 minutes afterwards**. Same conclusion.
* **One expense** (txn 17769) has **two** legal project names
  today — but the second was added on 2026-09-04, *after* this 2026-09-02
  expense. At its own submission time exactly one existed, and it is the one its
  draft records. The "single option today" test would have called this
  ambiguous; the contemporaneous test resolves it correctly.

That last row is why the check has to run in both directions: today's
configuration can be **more** permissive than the day's, and also **less**.

### 18181 — where the guard did its job, and where the owner decided

18181's project fields were recoverable, but its From/To locations were lost in
the same event and no source survives them. The deployed guard re-validates the
**whole** expense on any insert, so a partial repair was rejected outright:

```
ERROR: Cannot submit: required additional field(s) missing: From location, To location
CONTEXT: trg_protect_required_fields_after_submission()
```

That is correct behaviour and it was not worked around — no trigger disabled, no
policy relaxed, no status changed. The blocker was put to the owner, who
supplied the From/To pair used on all three of this employee's other trips on
this project (the values themselves are in the server-side manifest, not here). Those two values are recorded as
**owner-supplied, not evidence-derived**; the three project values on the same
row remain Level A2.

### Result

| | first pass | second pass | total |
|---|---|---|---|
| Expenses repaired | 192 | **3** | 195 |
| Field values restored | 384 | **9** | 393 |
| Of which owner-supplied | 0 | **2** | 2 |
| Values inferred | 0 | **0** | 0 |
| Existing values overwritten | 0 | **0** | 0 |
| Financial / status / transaction-number changes | 0 | **0** | 0 |

Remaining invariant failures: **46 -> 43.** Each write was rehearsed on a restore
of a fresh verified backup with all three guards and the organization policy
active, then applied to Production in one transaction with
`SET CONSTRAINTS ALL IMMEDIATE` proving the guard before commit.

Backups taken first:
`20260907T190000Z-pre-second-pass-project-recovery.dump` (sha256 `d8f3d189…`,
2,389 TOC entries) and
`20260907T193000Z-pre-18181-owner-supplied-repair.dump` (sha256 `80bbf7e1…`).

### July is now clean

The report that started this — MicroLink, July 2026, 7,534 non-draft expenses:

| Project Unique ID blank | Project ID blank | Project Name blank |
|---|---|---|
| **0** | **0** | **0** |

Across all months, 43 non-draft expenses still fail the invariant: 22 on From/To
location, 14 on Project Unique ID, 7 on Project ID + Name. All are documented as
unrecoverable, not skipped. Separately, 13 approved MicroLink expenses carry a
blank transaction number — an unrelated defect audited in
[DOC-121](./expense-transaction-number-audit.md).

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-07 | 1.0 | Claude Code | Historical remediation applied to MicroLink. 192 expenses / 384 fields restored, all Level A2 with payload agreement and proven chronology; 0 inferred, 0 ambiguous, 0 overwrites, 0 financial or status changes. A1 backup evidence yielded nothing once correctly filtered — an earlier apparent 33 recoveries was an extraction artefact. One previously-ambiguous expense reclassified D → A2 by draft supersession. 46 rows remain, all genuinely unrecoverable, including 12 initially missed by a NULL-`transaction_number` string-concat bug in the manifest extraction (reporting only; they were never repaired). Rehearsed on a restore of a fresh verified backup with prevention triggers active before touching Production. Non-MicroLink tenants analysed, none modified. |
| 2026-09-07 | 2.0 | Claude Code | Second pass. Re-examined the 46 remaining rows on a narrower question than pass 1's payload-agreement gate: does the expense's OWN linked draft hold a project value under a branch whose parent option is the UID the expense still carries? Four drafts across the population held any branch value; one (05178) named a different project than its expense stores and was rejected. Three repaired: 17275 and 17769 (Project ID + Name) and 18181 (Unique ID + ID + Name, its formFieldValues having arrived empty while branchValues survived). Determinism rests on branch-id -> parent-option being 1:1 by schema (1,916/1,916, max 1 parent), each value being a legal active option, and the draft's implied UID matching the stored one. Configuration was tested against each expense's own submission time, not today: six expenses (14271-14281) and one (19325) were ruled OUT because their branch configuration was created after the expense, so the values never existed; 17769 was ruled IN because its second project-name option was added after its submission, when exactly one existed. 18181's From/To were unrecoverable and the deployed guard correctly refused a partial repair; the owner supplied the From/To pair, recorded as owner-supplied rather than evidence-derived. Totals now 195 expenses / 393 fields, 0 inferred, 0 overwritten, 0 financial changes; remaining failures 46 -> 43. July 2026 now has zero blank project columns across 7,534 non-draft expenses. |
