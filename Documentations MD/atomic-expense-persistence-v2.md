# Atomic Expense Persistence V2 — Write-Path Inventory and Architecture

**Doc ID:** DOC-125  
**Status:** deployed (MicroLink single-expense V1 live on Production; MicroLink batch client is still legacy — next task; all other organizations unchanged)  
**Last updated:** 2026-09-09  
**Owner / area:** Expenses — submission persistence, Supabase  

---

## 1) Summary

An expense is one business object written through **three separate client-orchestrated
network mutations**. Core columns land in `expenses`; dynamic values land in
`expense_form_field_values` via a different RPC; the status transition is a third call.
When the third call is refused by the submission guard, the first two have already
committed and the row stays a draft. That is the architecture behind the 2026-09-08
incident (employee 6818, six refused submissions, ₹2,590 stranded).

This document is the §3 inventory that must precede any implementation. **No code has
been changed.**

---

## 2) Branch

| | |
|---|---|
| Branch | `architecture/atomic-expense-persistence-v2` |
| Created from | `origin/main` @ **`90b7723`** |
| Worktree | `_atomicv2` |
| Business data modified | **none** (inventory is read-only) |

---

## 3) Every current expense write path

### Client → PostgREST (direct row writes)

| # | Path | Core write | Custom-field write | Status write | Atomic? | Risk |
|---|---|---|---|---|---|---|
| 1 | `ExpenseService.createExpense` (`ExpenseService.ts:266`) | `INSERT expenses` (draft) | none | none | n/a | Row exists before its fields do |
| 2 | `ExpenseService.updateExpense` (`:384`) | `UPDATE expenses` | none | none | no | Core can move without fields |
| 3 | `ExpenseService.submitExpense` (`:1761`, `:1786`, `:1890`) | none | **none** | `UPDATE status='submitted'` | no | **The failure point.** Refused ⇒ row stays draft |
| 4 | `ExpenseService.submitExpenseBatch` (`:1479`) | `UPDATE batch_id` | via #6 per line | via #3 per line | **per row** | Partial batch — see §F |
| 5 | `ExpenseService.assignToEngineer` (`:2030`) | `UPDATE expenses` | none | none | no | Unrelated to submission |
| 6 | `ExpenseService.replaceExpenseFormFieldValues` (`:1217`) | none | RPC (atomic **within itself**) | none | partial | Atomic for fields only |
| 7 | `AdminPanel.tsx` (`:989`, `:1305`, `:1344`) | `UPDATE expenses` | none | status changes | no | Admin status edits |
| 8 | `UserManagement.tsx` (`:1301`) | `UPDATE expenses` | none | none | no | Reassignment |
| 9 | `Expenses.tsx` (`:762`) | `DELETE expenses` | cascade | n/a | n/a | User-initiated discard |

### Server-side (live `pg_proc`)

| Function | Writes `expenses` | Touches custom fields | Sets `submitted` | Allocates number |
|---|---|---|---|---|
| `admin_submit_expense_for_employee_v2` | yes | via `replace_…` | via `p_status` | via trigger |
| `apply_expense_correction` | yes | — | — | — |
| `review_verify_expense` / `review_approve_expense` / `…_v2` / `…_manager_override_v1` / `review_reject_expense` / `review_admin_verify_expense` / `review_advance_expense_hierarchy_tier` | yes | — | — | override only |
| `repair_expense_for_manager_review` | yes | — | — | — |
| `deactivate_organization_member`, `undo_organization_member_deactivation`, `sync_pending_expenses_on_supervisor_change`, `update_expense_total` | yes | — | — | — |
| `replace_expense_form_field_values` | — | **yes** | — | — |
| `replace_expense_form_field_values_by_reviewer` | — | **yes** | — | — |
| `admin_restore_upsert_form_field_values` | — | **yes** | — | — |

> **Decisive finding: no server function sets `status='submitted'` for an ordinary
> employee.** That transition exists *only* as a client `PATCH /rest/v1/expenses`.
> There is no server-side submit command to make atomic — one must be built.

### The exact orchestration in `ExpenseForm.tsx`

New expense (`:1699`–`:1769`) — **three mutations**:

1. `createExpense` → `INSERT expenses` (draft)
2. `saveFormFieldValues` → `replace_expense_form_field_values`
3. `submitExpense` → `PATCH expenses status='submitted'` ← guard rejects here

Edit/resubmit (`:1670`–`:1692`) — the same three, as `updateExpense` → fields → submit.

---

## 4) Why core fields survived and custom fields did not

**Core fields** are columns of `expenses`. They are written by the same statement that
creates the row. There is no window in which the row exists without them.

**Custom fields** are rows in a different table, written by a different call, and their
*shape* depends on asynchronously fetched configuration — templates, option branches,
nested conditional branches. The client therefore had to coordinate four things it does
not control: expense row state, template values, branch values, and async config
readiness. A pending fetch, a stale response for a superseded selection, or a rejected
second call all produce the same outcome — a committed core row with absent field rows.

A hotfix already landed (`ExpenseForm.tsx`, "INCIDENT hotfix (2026-09)") that refuses to
build a payload while a selected option's branch config is unresolved. That closes one
mechanism. It does not remove the split write.

---

## 5) What the schema already gives us

| Asset | State | Use in V2 |
|---|---|---|
| `uq_form_field_values_expense_template` UNIQUE (expense_id, template_id) | exists | **narrow `ON CONFLICT` upsert is possible** (§21) — no delete-then-insert needed |
| `uq_form_field_values_expense_branch` UNIQUE (expense_id, branch_field_id) | exists | same, for branch values |
| `expenses_transaction_number_org_unique` UNIQUE | exists | numbers cannot duplicate |
| `assign_transaction_number` trigger | fires on INSERT **or** status change into a protected state | §41 satisfied by construction — a number is allocated inside whatever transaction performs the transition |
| `validate_custom_fields_on_submit_*` | `DEFERRABLE INITIALLY DEFERRED` constraint triggers | §24 satisfied by construction — they validate **rows actually written**, at COMMIT |
| `expense_submission_integrity_issues_v1` | live | §22's canonical validator — do not write another |
| `admin_submit_expense_idempotency` (org, admin, key, request_hash, expense_id) | exists, in use | proven idempotency pattern to generalise |
| `expense_submission_drafts` (payload jsonb, 9,174 rows) | client-written safety copy | prior art; a recovery net, **not** a persistence path |
| Revision / version column on `expenses` | **absent** | §13 requires adding one |

---

## 6) Findings that need a decision before implementation

### §F — Batch is currently PARTIAL-SUCCESS by design

`submitExpenseBatch` loops per line and returns `successCount`, `failureCount` and a
per-line `results[]`. Partial success is therefore **existing product behaviour**, not an
accident. §20 says explicitly: do not assume all-or-none; if partial success is required,
**stop and document it**. This is that stop.

The historical harm was never partial success itself — it was *silent* partial success.
A previous fix already reordered the field write before the status transition. Three
options:

- **A — atomic all-or-none** (the prompt's default). Cleanest invariant; changes product
  behaviour: one bad line blocks nine good ones.
- **B — partial, but explicit.** Keep per-line receipts, require the UI to state
  "6 submitted, 1 needs attention" and route the failed line back into the form.
- **C — all-or-none by default, partial only on an explicit second confirmation.**

**Recommendation: C.** It gives the strong invariant by default and preserves the
existing capability behind an intentional choice. *This needs your decision — implementation
of §19/§20 is blocked on it.*

### §G — `anon` holds EXECUTE on four mutating functions

`replace_expense_form_field_values`, `replace_expense_form_field_values_by_reviewer`,
`admin_restore_upsert_form_field_values` and `apply_expense_correction` are all executable
by `anon`. This is the same `ALTER DEFAULT PRIVILEGES` class of issue found and fixed on
the diagnostics functions on 2026-09-08. Each refuses an unauthenticated caller internally,
so nothing is currently exposed — but the grant should not exist. Separate hotfix; not
part of V2.

---

## 7) Proposed V2 design (not yet implemented)

### Snapshot

Grounded in the real schema — `expense_form_field_values` stores exactly one of
`template_id` or `branch_field_id` (CHECK constraint), so the snapshot mirrors that:

```
ExpenseSnapshotV2 {
  expense_id            uuid | null      -- null = create
  expected_revision     bigint | null    -- null only when creating
  action                'save_draft' | 'submit'
  idempotency_key       uuid            -- client-generated per attempt
  core {
    title, destination, trip_start, trip_end,
    category, total_amount, purpose
  }
  fields [                               -- ONE array; mirrors the CHECK constraint
    { template_id, value, op }           -- op: 'set' | 'clear'
    { branch_field_id, value, op }
  ]
  resolved_scope {                       -- §11/§12: what the client PROVES it resolved
    template_ids   uuid[]
    branch_ids     uuid[]
  }
}
```

`resolved_scope` is the answer to §11 and §12. Deletion is scoped to what the client
positively resolved — never to "absent from the payload". A field outside `resolved_scope`
is **UNCHANGED**, not cleared.

### Server

```
_persist_expense_snapshot_v2(p_snapshot jsonb, p_action text)   -- single implementation
  ├── save_expense_draft_v2(p_snapshot jsonb)                    -- thin wrapper
  └── submit_expense_v2(p_snapshot jsonb)                        -- thin wrapper
get_expense_submission_result_v2(p_idempotency_key uuid)         -- §16 reconciliation
```

One transaction: authenticate → authorize → lock row `FOR UPDATE` → check revision →
upsert core → upsert fields by `ON CONFLICT` → set status → (trigger allocates number) →
audit row → receipt row → `SET CONSTRAINTS ALL IMMEDIATE` (forces the deferred validators
against **written rows**, §24) → return receipt. Any failure rolls back everything.

### New objects required

- `expenses.revision bigint NOT NULL DEFAULT 0`, bumped by trigger (§13)
- `expense_submission_receipts` (idempotency_key PK, expense_id, transaction_number,
  status, revision, snapshot_hash, committed_at) — §14, §15, §44

---

## 8) §51 answers available today

| # | Item | Answer |
|---|---|---|
| 1 | Branch | `architecture/atomic-expense-persistence-v2` |
| 2 | Starting main SHA | `90b7723` |
| 3–4 | Write paths / split-write paths | §3 above — 9 client paths, 16 server functions; **3 mutations per submit** |
| 5 | Why core survived | same statement as row creation (§4) |
| 6 | Why custom fields did not | separate table, separate call, async-config-dependent shape (§4) |
| 9 | Submit network mutations **today** | **3** (target: 1) |
| 10 | Draft-save persistence RPCs **today** | **2** (core PATCH + field RPC; target: 1) |
| 11 | Core + custom in same DB transaction today | **NO** |
| 12 | Custom fields validated after DB write | **YES** — already, via the deferred constraint triggers |
| 13 | Number allocated in same transaction as transition | **YES** — trigger-driven |
| 14 | Audit event in same transaction | **NO** for employee submit (client-side path) |
| 15 | Idempotency | **NO** for employee submit; **YES** for admin submit |
| 16 | Optimistic concurrency | **NO** — no revision column |
| 17 | Timeout reconciliation | **NO** |
| 18 | Batch all-or-none | **NO** — partial by design (§F) |
| 19 | Direct submission PATCH remaining | **3 call sites** (target: 0) |
| 31 | Business data modified | **0** |
| 32 | Production deployed | **NO** |

---

## 9) Database / migrations

None yet. No migration has been written or applied.

---

## 10) Test plan (to be built)

§32 serializer property tests, §33 round-trip fixtures (100+), §34 custom-field fuzz,
§35 network-failure matrix, §36 504 reconciliation, §49 A–M acceptance tests.

---


---

## 11) MicroLink Atomic Submission V1 — built 2026-09-09

`supabase/migrations/20260909100000_microlink_atomic_submission_v1.sql`.
Functions, one column, one table. **No DML against existing business rows.**

### §6 decided by measurement, not assumption

Project ID / Project Name are **not** uniformly derivable:

| | UIDs | exactly one option | multiple | none |
|---|---|---|---|---|
| `project_id` | 530 | 529 | **1** (`197001M3` -> 326 / 506) | 0 |
| `project_name` | 526 | 521 | **4** | **1** (`202608M453`) |

Stored history agrees with derivation on 19,086/19,088 and 11,853/11,854 rows.

The resolver is therefore **hybrid**: derive when exactly one option exists,
validate the employee's choice when several do, refuse (PW002) when none do. A
client value disagreeing with a deterministic project is refused as a stale form
rather than silently overwritten. Nothing is invented.

### API

```
submit_microlink_expense_v1(p_snapshot jsonb) -> jsonb
save_microlink_expense_draft_v1(p_snapshot jsonb) -> jsonb
submit_microlink_expense_batch_v1(p_snapshots jsonb, p_allow_partial boolean = false) -> jsonb
get_expense_submission_result_v1(p_idempotency_key uuid) -> jsonb
```

All four delegate to one engine, `_persist_microlink_expense_snapshot_v1`, so
draft-save and submit cannot drift. The client sends **business values only**;
the server owns the template/branch mapping.

### Acceptance results (Production data, one rolled-back transaction)

| Test | Result |
| --- | --- |
| A. 6818 reproduction, ONE call | **PASS** - submitted, txn 19838, 5 field rows, project fields derived server-side |
| B. Idempotent retry | **PASS** - replayed, same expense/number, 1 audit event |
| C. Timeout reconciliation | **PASS** |
| D. Missing Project UID | **PASS** - PW001, **0 rows left behind** |
| E. Invalid UID | **PASS** - PW003 |
| E2. Ambiguous, no choice | **PASS** - PW001, nothing invented |
| E3. Ambiguous, valid choice | **PASS** |
| E4. Illegal choice | **PASS** - PW003 |
| E5. Stale deterministic value | **PASS** - PW003, not overwritten |
| F. Wrong organization | **PASS** - 42501 |
| G. Atomic draft save | **PASS** - stays draft, no number |
| H. Batch 2 valid + 1 invalid | **PASS** - **0 submitted**, exact failed row returned |
| I. Batch all valid | **PASS** - 2 submitted |
| J. Stale expected_revision | **PASS** - PW409; current revision accepted |
| K. Edit + switch project, one call | **PASS** - **0 stale branch rows** |
| Rows left in Production | **0** |

### Two bugs found and fixed while building

- `PW_DRYRUN` is not a legal SQLSTATE (Postgres requires exactly five characters
  from `[0-9A-Z]`), so the batch dry-run handler could never have matched. Now `PWDRY`.
- `SET CONSTRAINTS ALL IMMEDIATE` applies to the **whole transaction**, not the
  function. Left set, the next batch row would fire the submission guard on its
  INSERT before its custom fields were written and fail a valid expense. The
  engine now restores `DEFERRED` straight after forcing the check.

### Client

`src/lib/microlinkExpenseSnapshot.ts`. Frozen output, refuses to build while
branch configuration is unresolved, and **throws rather than omitting a visible
value**. 17 tests including a 120-case property test asserting
`snapshotBusinessValues === visibleBusinessValues`.

### Not done

Client cutover (`ExpenseForm.tsx` still uses the three-mutation path), admin
submit through the engine, Preview deployment. **Migration not applied to Production.**


---

## 12) MicroLink client cutover — 2026-09-09

### Backward-compatibility proof (§37-§39) — the migration is neutral

Run against live Production data inside a rolled-back transaction, comparing the
OLD three-mutation flow before and after installing the migration:

| Check | Result |
| --- | --- |
| Legacy complete submit (MicroLink) | works, txn 19851, 5 fields, revision 1 |
| Legacy INCOMPLETE submit | still refused, PW001 — guard intact |
| **Other organization** (Mistry And Shah) legacy submit | works, txn 01348 — unaffected |
| V1 flow alongside legacy in the same period | works |
| Existing rows given a non-zero revision by install | **0 of 25,047** |
| Rows left in Production | **0** |

**Answer to §37: YES, backward compatible.** No split needed. The revision
trigger only fires on genuine content change and nothing enforces V1 on the old
client.

### What the client now does

| Surface | Path |
| --- | --- |
| New expense (desktop **and** mobile — one component) | **V1** |
| Existing draft submit | **V1** |
| Edit / resubmit | **V1** |
| Batch | still legacy — see below |
| Every other organization | unchanged legacy |

Routing is one function, `usesAtomicSubmissionV1(organizationId)`, resolved by
id in one place.

### The attachment exception, and why

A bill photo can only be moved onto an expense that already exists. For a NEW
expense that **requires** a bill we therefore save an atomic draft, attach, then
submit — two individually atomic calls. A failure between them leaves exactly
what today leaves: a draft holding everything the employee typed. Submitting
first would risk a submitted expense missing a required bill, which would be a
new failure mode rather than a fixed one. Expenses that do not require a bill
are a single request.

### Findings that removed work rather than adding it

- **There is no explicit "Save Draft" button** in `ExpenseForm`. §13/§15 had
  nothing to cut over; the draft RPC is used only by the attachment flow above.
- **Autosave writes to browser storage, not the database** (`useExpenseFormDraft`).
  There is no server-side autosave to route through the draft RPC, and it cannot
  race the atomic submit. §14 does not apply.
- **Mobile and desktop share one `ExpenseForm` component**, so both surfaces
  cut over together. There is no second legacy submit path to miss.

### Tests — 43 passing

Serializer omission guarantees (incl. a 120-case property test), the form-state
bridge, and the failure matrix: 400 validation, 409 conflict, 500, 504,
response-lost-after-commit, HTTP-200-without-receipt, idempotency-key reuse,
batch all-or-none, explicit partial, and readback mismatch detection.
Added no new `any` to `ExpenseForm` (unchanged at 15). Build passes.

### Not done

- **Batch client cutover** (`ExpenseBatchForm.tsx` still calls
  `ExpenseService.submitExpenseBatch`). The server endpoint exists and is tested.
  This is the explicit next task — see §13 below.

---

## 13) Production merge and deploy — 2026-09-09

Owner approved merge and Production frontend cutover after completing manual
Preview QA, evidenced by a browser HAR showing a real MicroLink expense
submitted through exactly one `POST /rpc/submit_microlink_expense_v1` with the
committed receipt matching every entered value.

### The requiresAttachment bug found during Preview QA

The owner's first real click threw `ReferenceError: requiresAttachment is not
defined`. Cause: `submitMicroLinkAtomically` is a sibling function of
`handleSubmit`, not nested inside it, so it could not see `handleSubmit`'s
local `const requiresAttachment` — a straight ReferenceError, which is why it
fired on every submit regardless of amount. Fixed by passing the value in as an
explicit parameter (commit `b910d6a`) rather than relying on the caller's local
scope; `tsc` now fails the build if that parameter is ever dropped again. This
fix was verified present on the branch before merge.

### Pre-merge verification

| Check | Result |
| --- | --- |
| `origin/main` drift since branch creation | none — `merge-base(origin/main, HEAD) == origin/main`, exactly `90b7723` |
| TypeScript | 0 errors |
| Build | pass |
| Focused V1 tests | 43/43 |
| Full suite | 4051/4052 — 1 failure independently proven pre-existing: the file is byte-identical to `origin/main` (0 diff), and passes cleanly in isolation (788 ms against a 5000 ms timeout); it only times out under full-suite parallel resource contention |
| New lint debt | 0 |
| Secret scan | clean |

### Pre-merge Production integrity snapshot (read-only)

MicroLink protected-incomplete: 45 (pre-existing historical baseline, unrelated
to this change). Protected NULL transaction numbers org-wide: **0**. Duplicate
transaction numbers: **0**. One `expense_submission_receipts` row already
existed from the owner's Preview QA (Preview and Production share one Supabase
backend) — 0 orphaned, 0 status disagreement with its expense, transaction
number present. 189 MicroLink and 5 Patidar Travels expenses carry a nonzero
`revision` from ordinary legacy edits since the capability went live on
2026-09-08; this is expected and inert — the trigger bumps on any
content-changing UPDATE regardless of which path performs it, and legacy code
never reads or gates on `revision`.

### Merge

`git merge --no-ff` (no conflicts — main had not moved): pre-merge main
`90b7723` → merge commit `bf7be6c`. Safety ref `backup/main-pre-microlink-v1-merge-20260909`
pushed at `90b7723` before touching `main`.

### Production deploy

Vercel Production reached READY. Confirmed against the **live Production
bundle** at `pesowise.unimisk.com` rather than trusting a SHA label alone: the
deployed JS contains `submit_microlink_expense_v1`, `save_microlink_expense_draft_v1`,
`get_expense_submission_result_v1` and the MicroLink organization id constant.

### Smoke test

No MicroLink QA/test employee identity exists. Per instruction, a real employee
was not used merely for smoke testing. The one existing receipt (from the
owner's own Preview QA, reachable because Preview and Production share a
backend) was instead inspected in full: txn 19869, `Travelling (Public and
Private Transport)`, ₹2.00, status `submitted`, exactly 1 `expense_submitted`
audit event, 5 persisted field values (Project Unique ID `201904M525`,
`project_id` `4957`, `project_name` "Courtesy 2019-20" — both server-derived —
`From location`/`To location` present), canonical validator: **0 blocking
issues**.

### Legacy path retained

No legacy code was removed or modified for other organizations. Rollback to
the legacy client remains possible without any data migration, since the V1
capability is additive and MicroLink's `usesAtomicSubmissionV1` routing is the
only new code path exercised.

## Revision log

| Date | Rev | Change | By |
| --- | --- | --- | --- |
| 2026-09-09 | 1.3 | Merged to `main` (`bf7be6c`) and deployed to Production. Fixed a real `ReferenceError` the owner found on first Preview click (`requiresAttachment` read outside its scope) before merging. Full pre-merge verification clean (tsc, build, 43/43 focused + 4051/4052 full suite with one independently proven pre-existing flake, 0 new lint debt, secret scan). Confirmed via the live Production JS bundle — not just a SHA label — that the V1 RPC names are actually deployed. No MicroLink QA employee exists, so no real-employee smoke test was performed; instead verified in full detail the one receipt already on record from the owner's own Preview QA: 5 fields persisted, 1 audit event, 0 validator issues. Legacy path untouched and rollback-capable. MicroLink batch client cutover remains the explicit next task. | Agent |
| 2026-09-09 | 1.2 | Cut the MicroLink employee form over to atomic submission. One routing decision by organization id; every other tenant untouched. A MicroLink submit is now ONE mutating request with no custom-field call and no status PATCH; the snapshot is built once, frozen, and never re-read. Proved the migration backward compatible against live data: the legacy flow behaves identically before and after install, other organizations are unaffected, and 0 of 25,047 existing rows changed. Three findings removed work rather than adding it - there is no Save Draft button, autosave writes to browser storage rather than the database, and mobile and desktop share one form component. Documented the one deliberate exception: an expense that requires a bill photo saves an atomic draft, attaches, then submits, because submitting first would risk a submitted expense with no bill. 43 tests. Batch client and Preview deployment still outstanding. | Agent |
| 2026-09-09 | 1.1 | Built the MicroLink atomic-submission vertical. One RPC persists core fields, every custom and conditional branch value, the transaction number, the submitted status, the audit event and an idempotency receipt in ONE transaction. Settled the project-derivation question by measuring rather than assuming: project fields are NOT uniformly derivable, so the resolver derives only where configuration is deterministic and validates the employee's choice otherwise. Verified against Production data inside a rolled-back transaction - 15 acceptance tests pass including the 6818 reproduction, all-or-none batch, optimistic concurrency and project switching, with 0 rows left behind. Found and fixed two real bugs while building: PW_DRYRUN is not a legal SQLSTATE, and SET CONSTRAINTS ALL IMMEDIATE leaks to the whole transaction and would break the second row of every batch. Client serializer added with 17 tests. Not deployed, not merged. | Agent |
| 2026-09-09 | 1.0 | Registered DOC-125. Completed the §3 write-path inventory across the client and live `pg_proc` before any implementation, as the task requires. Established that **no server function performs the employee submit transition** — it exists only as a client `PATCH`, so there is no atomic command to harden and one must be built. Documented the three-mutation submit sequence in `ExpenseForm.tsx` and why core columns survived while custom-field rows did not. Found the schema already supplies most of what V2 needs: both UNIQUE constraints for narrow upserts, a transaction-number trigger that fires inside whichever transaction performs the transition, deferred constraint triggers that already validate written rows at COMMIT, and a working idempotency table to generalise. Found two blockers: batch partial-success is existing product behaviour (§20 stop), and `anon` holds EXECUTE on four mutating functions. No code changed, no migration written, no business data touched. | Agent |
