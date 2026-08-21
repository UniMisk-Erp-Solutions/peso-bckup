# DOC-081 — Safety, Recovery, Recycle Bin & Universal Undo — Implementation Plan

**Status:** APPROVED PLAN — NOT IMPLEMENTED YET  
**Owner intent:** This document is the implementation source of truth for the PesoWise safety/recovery work. If unrelated work interrupts this feature, the next implementation session must resume from the first incomplete checkpoint in this file rather than reconstructing the plan from chat history.  
**Branch strategy:** Implement on `dev`. Do not merge `dev` into `main` until the owner separately approves that merge.  
**Related roadmap:** `FUTURE_PLANS.md` §29 — Safety, Recovery, Recycle Bin + Universal 10-Second Undo.  
**Created:** 17/08/2026

---

## 1. Why this exists

PesoWise contains several classes of state-changing actions:

- actual deletions;
- user deactivation;
- category/location/team/template retirement or archive;
- dropdown option removal;
- attachment/file removal;
- expense approval/rejection/override;
- balance changes;
- transfer state changes;
- bulk operations.

These should not all use the same recovery mechanism.

The goal is to introduce one consistent safety layer while preserving financial auditability and historical expense data.

The final product model is:

```text
                              USER ACTION
                                   |
                                   v
                         server applies action now
                                   |
                                   v
                         authoritative action event
                                   |
                        +----------+----------+
                        |                     |
                        v                     v
                 10-second Undo         permanent audit trail
                        |
                 user clicks Undo?
                  /             \
                yes              no
                 |                |
                 v                v
          server-side inverse    action remains
          / compensating action
```

The browser must never delay the actual mutation for 10 seconds. The backend is authoritative.

---

# 2. Locked product decisions

These decisions should not be changed casually during implementation.

## 2.1 Universal 10-second Undo

Every user-visible state-changing action should show a proper success toast with Undo for approximately 10 seconds **where a safe inverse exists**.

The toast must:

- include a visible countdown/progress timeline;
- work on desktop and mobile;
- use one shared implementation;
- support multiple simultaneous undoable actions;
- bind each toast to a server-issued `action_id`;
- treat server expiry as authoritative;
- disable Undo immediately after the user clicks it;
- show a short success acknowledgement after a completed Undo;
- show a truthful error if Undo can no longer be performed.

Do not add routine typed phrases such as:

```text
PRODUCTION
DELETE
DELETE EXPENSE
RETIRE B
DEACTIVATE USER
```

Existing special infrastructure/maintenance confirmations remain separate from this product feature.

## 2.2 15-day Recycle Bin

Use a 15-day Recycle Bin only for things that are genuinely deletable.

Potential examples after the destructive-action inventory:

- eligible expenses;
- drafts;
- attachments/files;
- disposable configuration records with no required historical references.

Recycle Bin lifecycle:

```text
active
-> soft deleted
-> hidden from normal views
-> Undo available for ~10 seconds
-> Restore available from Recycle Bin for 15 days
-> permanent purge after retention only where permanent deletion is allowed
```

Audit/history records are never deleted merely because a parent entity is in the Recycle Bin.

If a Storage/MinIO object is recoverable for 15 days, the physical object must not be deleted immediately.

## 2.3 Historically referenced master/configuration data

Historically referenced data should normally be archived/deactivated/retired rather than physically deleted.

Preferred semantics:

```text
User               -> Deactivate / Reactivate
Category           -> Archive / Restore
Location           -> Archive / Restore
Used Team          -> Archive / Restore
Used Form Template -> Retire / Restore
Dropdown Option    -> Retire / Restore
Dependent Field    -> Retire / Restore
```

Historical records keep the old label/value forever.

## 2.4 Financial/workflow actions

Financial and workflow actions do not belong in the Recycle Bin.

Examples:

- balance set/edit/reset;
- approve expense;
- reject expense;
- manager override;
- bulk approve/reject;
- transfer accept/reject/cancel;
- bank-account deactivate/reactivate.

Their Undo must be an auditable compensating/reversal operation.

Never erase the original event.

Example:

```text
13:20:00 Expense approved
         Balance ₹20,000 -> ₹8,000
         action_id = X

13:20:06 Undo

13:20:06 Approval reversed
         Balance ₹8,000 -> ₹20,000
         reverses_action_id = X
```

Both events remain permanently visible in history.

---

# 3. Core backend action contract

Before wiring many screens, introduce a shared server-side action/undo contract.

Exact schema names may change after the destructive-action audit, but the design should resemble:

```text
action_events
------------------------------------------------
id
organization_id
actor_user_id
action_type
entity_type
entity_id
action_batch_id
applied_at
undo_expires_at
undone_at
undo_status
client_request_id / idempotency_key
metadata / minimal reversal metadata
created_at
```

Bulk operations may require child rows:

```text
action_event_items
------------------------------------------------
action_event_id
entity_type
entity_id
operation
reversal_metadata
```

A newly integrated mutation should return something equivalent to:

```text
action_id
applied_at
undo_expires_at
undo_available
```

## 3.1 Undo validation

Before reversing an action, the backend must check:

- caller authorization;
- same organization;
- action exists;
- action has not already been undone;
- undo window has not expired;
- entity has not entered a conflicting later state;
- the reversal is still valid under current business rules;
- the operation is idempotent.

If a later action makes exact reversal unsafe, Undo must fail clearly rather than overwrite newer state.

## 3.2 Authorization rule

Undo must never broaden access.

A user who could not legally perform or reverse the original operation must not gain that ability because an Undo endpoint exists.

All organization/RLS/role boundaries remain authoritative server-side.

---

# 4. Form-field historical integrity — highest business priority

This is the first major business feature after the shared Undo foundation.

## 4.1 Simple dropdown required behavior

Given:

```text
A
B
C
D
```

and historical expenses using `B`, retiring `B` must produce:

```text
NEW EXPENSES:
A
C
D

OLD EXPENSES:
B remains stored and displayed exactly as historical data
```

A configuration change must never rewrite old `expense_form_field_values`.

The existing architecture already stores a literal historical field value separately from the active option array. Preserve that advantage.

## 4.2 Product wording

Prefer:

```text
Retire option
```

rather than implying that historical data is being deleted.

Example success toast:

```text
Option B retired                       Undo   10s
```

## 4.3 Retirement metadata

Use a durable retirement model capable of storing at minimum:

```text
template_id
option_value
retired_at
retired_by
original_display_order
restored_at / active state
```

The exact implementation can be a dedicated option-state table or another carefully-audited structure, but avoid introducing two conflicting sources of truth for active options.

## 4.4 Nested / conditional dropdown critical case

Example:

```text
Department
├── A
├── B
│   ├── Vehicle Type = Car
│   └── Vehicle Number = GJ01AB1234
├── C
└── D
```

After B is retired:

- new expenses cannot choose B;
- old expenses continue to show B;
- historical dependent values remain readable;
- editing an unrelated field must not delete hidden/retired dependent values;
- only an explicit controlling choice change away from B may intentionally invalidate B-specific values.

The current custom-field replacement path has replace semantics for visible branch fields. This is the critical regression risk.

One safe implementation direction:

1. Capture originally persisted template and branch values when opening an expense for edit.
2. Track which controlling selections the user actually changed.
3. Build the final atomic replacement payload from:
   - current visible values; plus
   - original hidden/retired values that were not explicitly invalidated.
4. Remove historical hidden branch values only after an explicit controlling choice change makes them obsolete.
5. Keep the entire replacement atomic through the existing custom-field save contract.

## 4.5 Historical display/filter requirements

Retired values must remain visible in:

- Expense Detail;
- Expense Edit;
- Review Expenses;
- Reports;
- Team Reports / Claim Verification where applicable;
- exports;
- custom-field filters;
- corrections/resubmission;
- batch expense flows.

A retired option may continue appearing in historical report filters even though it cannot be chosen for a new expense.

---

# 5. User lifecycle — deactivate, never hard-delete from an organization

The current product already behaves partly like deactivation while using misleading Delete wording.

Required final contract:

```text
Active organization member
-> Deactivate User
-> organization membership becomes inactive
-> user disappears from active-user lists
-> user cannot use that organization
-> user does not count toward active organization seat/user limit
-> historical expenses remain intact
-> approvals remain intact
-> transfers remain intact
-> reports remain intact
-> audit history remains intact
-> 10-second Undo can immediately reactivate
-> Deactivated Users view allows later Reactivate
```

Do not hard-delete the Auth user merely to remove access to one organization.

If multi-organization membership exists, deactivating membership in one organization must not destroy access to another active organization.

Explicitly test the AuthContext / ProtectedRoute / membership-bootstrap path so inactive membership cannot still enter the deactivated organization.

---

# 6. Other master data

After user lifecycle and form-field retirement are proven, standardize:

```text
Category -> Archive / Restore
Location -> Archive / Restore
Used Team -> Archive / Restore
Used Template -> Retire / Restore
Dropdown option -> Retire / Restore
Dependent field -> Retire / Restore
```

An unused item with no historical references may later qualify for the Recycle Bin, but this must be determined by an authoritative backend usage/reference check.

Every archive/retire/deactivate action should use the shared 10-second Undo toast.

---

# 7. Recycle Bin design

The Recycle Bin is Milestone 2, not the first feature to build.

Potential soft-delete metadata:

```text
deleted_at
deleted_by
purge_after
recycle_event_id
```

The unified Recycle Bin page should show:

```text
item / label
entity type
deleted by
deleted on
remaining retention / purge date
Restore
```

Restore must be:

- server-side;
- organization-scoped;
- permission checked;
- idempotent;
- auditable.

Permanent purge must run through a trusted backend/scheduled path rather than an open browser tab.

Do not expand current delete permissions/status rules simply because recovery now exists.

---

# 8. Financial/workflow Undo design

This is Milestone 3 and should be implemented only after the non-financial safety foundation is proven.

Integrate one contract at a time:

1. balance set/edit/reset;
2. single approval/rejection;
3. manager override;
4. bulk approve/reject;
5. transfer accept/reject/cancel;
6. bank-account state changes;
7. any other financial/workflow mutations discovered by inventory.

Each reversal must be atomic and permanently audited.

Bulk actions must preserve the exact scope that was originally applied.

Do not partially reverse an atomic business batch unless the current business contract explicitly supports partial reversal.

---

# 9. Expected shared frontend additions

Exact paths must be confirmed against the reconciled `dev` branch before coding, but likely additions include:

```text
src/contexts/UndoActionContext.tsx
src/hooks/useUndoableAction.ts
src/services/undoableActionService.ts
src/components/UndoActionToast.tsx
src/pages/RecycleBin.tsx
src/components/recycle-bin/*
src/lib/actionTimeline.ts
```

Prefer extending/adapting the current PesoWise toast system rather than building another unrelated notification stack.

Likely integration areas include:

```text
src/pages/Expenses.tsx
src/pages/ExpenseDetail.tsx
src/pages/ExpenseForm.tsx
src/services/ExpenseService.ts
src/pages/UserManagement.tsx
src/pages/CategoryManagement.tsx
src/components/FormFieldTemplateEditorDialog.tsx
src/lib/formBuilder/templateEditor.ts
src/lib/optionBranchPersistence.ts
src/lib/expenseFormFieldPayload.ts
src/components/CategoryFormFieldsSection.tsx
src/components/SearchableSelectField.tsx
src/pages/EngineerReview.tsx
src/pages/Balances.tsx
src/pages/TransferOffers.tsx
bank-account/settings/admin surfaces discovered by audit
src/App.tsx
src/components/Layout.tsx or current navigation shell
locale files
feature documentation
```

This list is intentionally not exhaustive. The destructive-action inventory controls the final list.

---

# 10. Expected database work

Use additive migrations with matching rollback files.

Likely migration groups:

```text
01 action-event / Undo journal
02 master-data retirement/deactivation helpers
03 form-option retirement + historical branch preservation
04 recycle-bin / soft-delete infrastructure
05 financial/workflow reversal functions
06 purge/retention job
```

Do not create one giant generic SECURITY DEFINER function with unrestricted mutation authority.

Any shared dispatch mechanism must still apply action-specific authorization and organization checks.

---

# 11. Mechanical destructive-action inventory — mandatory before implementation

Before designing exact RPCs, search the reconciled repository and migrations for every user-visible or backend path that can:

- `.delete()`;
- Storage `.remove()`;
- `DELETE FROM`;
- `ON DELETE CASCADE`;
- archive/deactivate;
- unlink/unassign;
- clear/reset values;
- overwrite history;
- restore/replace data;
- approve/reject/override;
- change balances;
- accept/reject/cancel transfers;
- perform bulk mutations.

For each action capture:

```text
UI action
allowed role
backend call/RPC
DB tables changed
Storage objects changed
cascades/dependencies
financial impact
current confirmation
current audit history
current recoverability
recommended model
```

Classify each as exactly one of:

```text
A Recycle Bin
B Archive / Deactivate / Retire
C Compensating / Reversal Undo
D No additional recovery required
E Needs architecture decision
```

Do not fix actions during the inventory phase unless a severe active data-integrity bug is discovered and the owner separately authorizes the fix.

---

# 12. Implementation milestones

## Milestone 0 — DEV reconciliation + baseline + inventory

**Goal:** Produce a clean development baseline before feature coding.

Steps:

1. Preserve the current `dev` SHA before any merge.
2. Fetch latest `main` and `dev`.
3. Merge latest `main` **into** `dev`.
4. Do not merge `dev` into `main`.
5. Do not rebase/force-push shared DEV history.
6. Resolve conflicts deliberately.
7. Run full existing test/build/type/lint/migration gates.
8. Run review/manager-override regression tests.
9. Run maintenance/auth-storage-isolation regression tests.
10. Complete the destructive-action inventory.
11. Record the reconciled DEV SHA and test baseline in this document.

**Exit gate:** DEV is reconciled, tests are green in tested scope, and every destructive/state-changing action is classified.

---

## Milestone 1 — Safety Foundation

This is the first implementation milestone.

Scope:

### 1A. Shared action/Undo foundation

- action journal/event schema;
- action IDs;
- server-authoritative undo expiry;
- idempotent Undo contract;
- shared 10-second toast with progress timeline;
- multiple simultaneous undo toasts;
- permanent audit trail.

Prove first on one low-risk action such as category Archive/Restore.

### 1B. Form-field/template/dropdown historical safety

- Retire/Restore form templates where historical usage exists;
- Retire/Restore dropdown options;
- nested/dependent field retirement;
- preserve historical values when editing unrelated expense fields;
- keep retired values visible in historical views/filters/exports;
- 10-second Undo for retire/restore actions.

### 1C. User Deactivate/Reactivate

- change misleading Delete terminology;
- deactivate organization membership rather than destroying user history;
- block organization access for inactive membership;
- exclude inactive membership from active seat/user limit;
- preserve all history;
- Deactivated Users view;
- Reactivate action;
- 10-second Undo.

### 1D. Master-data parity

- Category Archive/Restore;
- Location Archive/Restore;
- Used Team Archive/Restore;
- common Undo toast integration.

**Explicitly out of Milestone 1:**

- full Recycle Bin;
- 15-day purge scheduler;
- financial approval/balance/transfer Undo;
- Production rollout before Preview QA passes.

**Exit gate:** Historical data cannot be destroyed by the supported configuration changes; user deactivation is safe; shared Undo infrastructure is proven on multiple non-financial actions.

---

## Milestone 2 — 15-day Recycle Bin

Scope after Milestone 1 is stable:

- eligible expenses;
- drafts;
- attachments/files;
- other disposable entities discovered in the inventory;
- unified Recycle Bin UI;
- Restore;
- 15-day retention;
- delayed Storage/MinIO purge;
- purge scheduler/job;
- RLS and authorization;
- audit history preserved.

**Exit gate:** Eligible deleted entities can be restored reliably before retention expires and purged safely afterward.

---

## Milestone 3 — Financial/workflow Undo

Integrate in small slices:

1. balances;
2. single approval/rejection;
3. manager override;
4. bulk review actions;
5. transfers;
6. bank-account state;
7. remaining discovered financial/workflow actions.

Every slice requires reconciliation tests proving exact-once forward mutation and exact-once compensating reversal.

**Exit gate:** Financial Undo is atomic, auditable, conflict-safe and does not rewrite history.

---

## Milestone 4 — App-wide completion + polish

- integrate remaining eligible actions;
- remove inconsistent one-off Undo implementations;
- standardize wording;
- mobile parity;
- accessibility;
- audit timeline UX;
- documentation.

---

# 13. Required QA matrix

## 13.1 Shared Undo toast

```text
action succeeds
-> toast appears
-> visible 10-second timeline
-> Undo inside window succeeds
-> Undo after server expiry is rejected truthfully
-> double Undo is idempotent
-> multiple fast actions each keep their own Undo handle
-> page/tab state cannot change server expiry
```

## 13.2 Simple dropdown retirement

```text
Create A/B/C/D
Create historical expense with B
Retire B
New expense cannot select B
Old expense still displays B
Edit old expense amount only
Save
B remains B
Restore B
B becomes selectable on new expenses again
```

## 13.3 Nested dropdown preservation

```text
Historical B has dependent values
Retire B
Open old expense
Change unrelated field
Save
All historical dependent values remain
```

Then explicitly test:

```text
B -> C
```

and verify only intentionally obsolete B-specific values are removed according to the defined rule.

## 13.4 User deactivation

```text
deactivate user
-> removed from active lists
-> active seat/user count decreases
-> organization access blocked
-> historical expenses/audit intact
-> Undo within 10 seconds reactivates
-> later Reactivate from Deactivated Users works
```

## 13.5 Category/location/team archive

```text
archive
-> disappears from new-selection surfaces
-> historical references remain readable
-> Undo restores
-> later Restore works
```

## 13.6 Recycle Bin

```text
delete eligible item
-> hidden from normal view
-> appears in Recycle Bin
-> immediate Undo works
-> later Restore works before 15 days
-> unauthorized restore fails
-> audit history remains
-> associated file remains recoverable during retention
```

## 13.7 Financial reversal

For each financial/workflow action:

```text
forward action applies exactly once
-> action event recorded
-> Undo within window
-> compensating state applies exactly once
-> original history remains
-> reversal references original action
-> balances/totals reconcile
```

Test a later conflicting action and prove Undo refuses rather than corrupting newer state.

## 13.8 Bulk action

```text
bulk operation applies its defined scope
-> one parent action event
-> Undo reverses the same scope
-> no duplicate financial/audit mutations
```

## 13.9 Authorization / RLS

Test:

- cross-organization denial;
- role denial;
- inactive user denial;
- server enforcement independent of hidden UI controls.

## 13.10 Regression

Run the full existing suite plus specifically:

- Review Expenses / Manager Override;
- maintenance control plane;
- local vs maintenance Supabase auth-storage isolation;
- form-field bulk import/matrix;
- expense form create/edit/resubmit;
- reports/custom-field filtering;
- storage/receipt flows.

---

# 14. Likely complexity and engineering budget

Overall complexity: **High — approximately 8/10**.

The toast itself is straightforward. The difficult parts are historical form preservation, concurrency, financial compensating transactions, Storage retention and ensuring Undo never widens permissions.

Approximate safe engineering budget for one experienced engineer with AI assistance and proper review:

```text
DEV sync + inventory                         0.5–1 day
Shared action journal + Undo toast           1–2 days
Master-data + dropdown/template retirement   2–3 days
Recycle Bin + restore/purge/storage          2–3 days
Financial/workflow Undo                      3–5 days
Regression + Preview + manual QA             2–3 days
-----------------------------------------------------
Complete safe implementation                 ~10–15 working days
```

Milestone 1 alone is expected to take approximately **3–5 focused working days**, potentially longer if the destructive-action audit reveals unexpected cascades or historical-data coupling.

Do not compress the financial Undo work simply because code generation is fast.

---

# 15. DEV continuation point

At the time this plan was created, the important known state was:

```text
main after roadmap docs: 77857cf2823001b66402a48ee5e138575744deea
previous dev tip:         a17f2827af2e7e0b90843404362e619747212b2c
historical merge base:    bf798862cdd52bc6224de124ff230044831f9aab
```

DEV was intentionally parked after the Review Expenses / Manager Override stabilization work.

That line contains reviewed work including:

- one canonical `/review` surface;
- removal of abandoned alternate/debug review surfaces;
- retention of `reviewQueueServer` transport used by `EngineerReview`;
- Manager Override RLS and RPC authorization fixes;
- reporting-chain RLS hardening;
- additional review/custom-field reliability tests;
- relevant Production-applied migrations;
- no intentional merge of DEV into MAIN yet.

MAIN moved separately with:

- Cloud maintenance control plane;
- local auth-storage isolation work;
- `FUTURE_PLANS.md`;
- this DOC-081 plan.

Therefore the next implementation session must merge **latest MAIN into DEV first** before feature coding.

---

# 16. Interruption-safe resume protocol

This section exists so unrelated work can happen without losing this workflow.

Whenever this feature is paused:

1. Update the **Progress Ledger** below.
2. Record the current DEV SHA.
3. Record the last completed checkpoint.
4. Record any migration applied to Preview/Production.
5. Record test results.
6. Record open defects or decisions.
7. Commit the documentation update on DEV with the implementation work.

When the feature resumes:

1. Fetch latest branches.
2. Read this entire document first.
3. Read `FUTURE_PLANS.md` §29.
4. Check whether MAIN moved while work was paused.
5. Reconcile MAIN into DEV if needed before further coding.
6. Verify already-applied migrations before replaying anything.
7. Start from the **first incomplete checkpoint** below.

Never restart the feature from scratch merely because a new coding session or model is being used.

---

# 17. Progress Ledger

Update this section during implementation.

## Branch baseline

- [ ] Current DEV preserved before reconciliation
- [ ] Latest MAIN merged into DEV
- [ ] Conflicts resolved deliberately
- [ ] Full baseline suite passes
- [ ] Reconciled DEV SHA recorded: `PENDING`

## Milestone 0

- [ ] Complete destructive-action inventory
- [ ] Classify every discovered mutation
- [ ] DB cascade/storage removal inventory complete
- [ ] Authorization baseline captured

## Milestone 1A — shared Undo

- [ ] Action-event schema designed
- [ ] Action-event migration added
- [ ] Rollback SQL added
- [ ] Server Undo contract added
- [ ] Idempotency tests
- [ ] Expiry tests
- [ ] Conflict tests
- [ ] Global Undo toast
- [ ] Visible countdown/progress
- [ ] Multiple concurrent toasts
- [ ] Mobile/accessibility QA
- [ ] Low-risk action proven end-to-end

## Milestone 1B — form-field safety

- [ ] Simple dropdown Retire/Restore
- [ ] Historical B remains visible
- [ ] Old expense unrelated edit preserves B
- [ ] Nested branch retirement
- [ ] Hidden historical branch values preserved
- [ ] Explicit controlling change invalidation tested
- [ ] Template Retire/Restore
- [ ] Reports/review/export/filter historical visibility verified

## Milestone 1C — users

- [ ] UI says Deactivate User, not Delete User
- [ ] Membership deactivation server contract verified
- [ ] Organization access blocked
- [ ] Active seat count excludes deactivated user
- [ ] History preserved
- [ ] 10-second Undo
- [ ] Deactivated Users view
- [ ] Reactivate later
- [ ] Multi-org behavior tested

## Milestone 1D — master data

- [ ] Category Archive/Restore standardized
- [ ] Location Archive/Restore
- [ ] Used Team Archive/Restore
- [ ] Historical references preserved
- [ ] Shared Undo integration complete

## Milestone 1 QA

- [ ] Unit tests
- [ ] Integration tests
- [ ] Migration checks
- [ ] Typecheck
- [ ] Lint
- [ ] Build
- [ ] Preview migration proof
- [ ] Preview manual QA
- [ ] No Production mutation without owner approval

## Milestone 2 — Recycle Bin

- [ ] NOT STARTED

## Milestone 3 — Financial/workflow Undo

- [ ] NOT STARTED

## Milestone 4 — App-wide completion

- [ ] NOT STARTED

---

# 18. Stop conditions

Stop and report before continuing if any of these occur:

- latest MAIN introduces major conflicting schema/runtime behavior;
- merging MAIN into DEV creates ambiguous business-logic conflicts;
- an existing delete path physically removes historical financial/audit data in a way that cannot be safely migrated without owner decision;
- a proposed Undo would allow broader permissions than the original action;
- a financial operation cannot be reversed atomically with the current schema;
- a migration would require destructive Production data rewriting;
- historical form values cannot be preserved without changing the agreed edit semantics;
- an applied Production migration differs materially from the repository migration history.

Do not improvise around these conditions. Produce evidence and request an owner decision.

---

# 19. Current first action when implementation begins

The first coding session must do exactly this:

```text
1. Read DOC-081 completely.
2. Read FUTURE_PLANS.md §29.
3. Fetch origin/main and origin/dev.
4. Preserve current DEV ref.
5. Merge current MAIN into DEV.
6. Resolve/test the branch reconciliation.
7. Perform the destructive-action inventory.
8. Only after the inventory is complete, begin Milestone 1A.
```

Do **not** begin by adding a toast component directly.

The action inventory and reconciled DEV baseline come first.

---

# 20. Final implementation principle

The feature is successful only if PesoWise becomes safer **without rewriting history**.

The core rules are:

```text
Mistake immediately?              -> 10-second Undo
Actually deleted entity?          -> 15-day Recycle Bin
Historical master/config data?    -> Archive / Deactivate / Retire
Financial/workflow state?         -> Compensating reversal
Historical audit/event?           -> Preserve permanently
```

Every implementation decision should be tested against those five rules.
