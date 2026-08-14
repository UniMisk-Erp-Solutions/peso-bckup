# Approved expense — atomic balance deduction

**Doc ID:** DOC-089  
**Status:** Backend V2 live and verified · V1 unchanged · MicroLink historical repair COMPLETED 2026-08-08 · **controlled end-to-end app → V2 → PostgreSQL approval VERIFIED on the DEV preview (transaction 00088)** · **PRODUCTION-MAIN frontend deployment and Production-domain verification still PENDING** · runtime concurrency still unproven · V1 retirement pending  
**Last updated:** 2026-08-09 (rev 3.0)  
**Owner / area:** Expense approval, Supabase RPC, financial integrity  

---

## 1) Summary

An approved expense did not reduce the employee's balance.

Expense approval was server-side; the balance deduction was **client-side**. For
every approval performed by a user acting as `engineer`, the browser's write to
`public.profiles` was silently filtered to zero rows by RLS. The expense
committed as `approved`; the balance never moved; and the audit log recorded the
deduction the browser had *calculated* rather than the one PostgreSQL had
*committed*.

This change makes approval and deduction a single database transaction via a new
`review_approve_expense_v2`, removes the browser's balance write entirely, and
records structured financial evidence. **The code and migration in this
repository repair no historical balance** — that was done separately as a
controlled server operation, now **completed**; see §8.

**Current position:** backend V2 is live and verified, the MicroLink historical
balances are corrected, and a controlled end-to-end approval through the deployed
**DEV preview** has been verified against the live backend (transaction 00088,
§8d). What remains is **deployment of the V2 frontend to Production-main** and a
controlled verification from the Production domain. Runtime concurrency is still
unproven. See §8c/§8d before treating this feature as shipped.

---

## 2) Confirmed production evidence (anonymised)

From the original read-only Production investigation. No Production data or
configuration was modified during that investigation, nor by any code or
migration in this repository. (Production data *was* subsequently modified by
the separate, controlled historical repair on 2026-08-08 — §8.)

| Fact | Value |
|---|---|
| Organization | MicroLink |
| `strategy_slug` | `standard` |
| Active profiles | 404 |
| Approved expenses | 6 |
| Approved total | ₹880.00 |
| Paid expenses | 0 |
| Affected employees | 3 |
| Approver role on all 6 | `engineer` |

Because the organization runs the **`standard`** strategy, this is **not** a
MicroLink-specific or strategy-specific defect. It is a general PesoWise
financial-consistency defect that would reproduce in any organization where a
manager (`engineer`) approves an expense.

Confirmed characteristics:

* Affected employees' balances were not reduced when the expenses were approved.
* The frontend shows the approved expenses, but the matching deductions never happened.
* All 6 approvals carry `expense_approved` audit entries that claim `Balance deducted: ₹X` and a remaining/negative balance — none of which occurred.
* Concurrent approvals were observed in production.
* No server trigger performs an expense deduction anywhere in the schema.

### Explicitly NOT evidence

MicroLink's transfer history is empty. **That is expected** — no balance
transfers have been performed in that organization yet. Transfer history is a
separate credit/allocation system, is unrelated to this incident, and was **not**
used to infer whether any expense was deducted. Nothing in this change reads,
writes or backfills `cash_transfer_history`.

---

## 3) Repository V1 matches live Production

Verified before designing V2. `public.review_approve_expense` is defined once, in
`20260702120000_expense_review_admin_approve_rpc.sql`, and the repository
definition matches every observed live property:

| Property | Repo V1 | Live |
|---|---|---|
| `SECURITY DEFINER` | yes | yes |
| Locks the expense (`FOR UPDATE`) | yes | yes |
| Validates approval authority | yes | yes |
| Sets `status = 'approved'` | yes | yes |
| Rejects repeated approval | yes | yes |
| Locks the employee profile | **no** | no |
| Updates `profiles.balance` | **no** | no |

**No schema drift.** V2 was built against the correct function.

---

## 4) Primary root cause

> Expense approval and balance deduction were split across two trust boundaries.
> The **server** approved the expense. The **browser** then tried to alter the
> employee's profile balance. Engineers have no `UPDATE` policy on
> `public.profiles`, so that second write was filtered to zero rows.
>
> Result: **approved expense + unchanged balance.**

The client sequence was:

1. read the employee's current balance,
2. call `review_approve_expense` — server commits `approved`,
3. compute `newBalance = currentBalance - expenseAmount` **in JavaScript**,
4. `profiles.update({ balance: newBalance }).eq('user_id', expense.user_id)`,
5. log an audit entry describing step 3.

Step 4 is the failure. `public.profiles` has `RLS` and `FORCE RLS` enabled, with
UPDATE policies for **own profile**, **admins**, and **cashiers over managed
profiles** — and none for engineers.

---

## 5) Secondary defects

1. **Zero-row UPDATE not verified.** PostgREST does not raise an error when RLS filters an UPDATE to zero rows, so `balanceUpdateError` stayed null and the client's "revert the approval" branch never ran. The failure was invisible.
2. **Missing organization scoping.** The write was filtered by `user_id` only, never `organization_id + user_id`. The pre-read used `selectFirstProfileRow`, which is `.eq("user_id").limit(1)` — it would silently pick an arbitrary row for a user with profiles in more than one organization.
3. **Audit logs recorded client arithmetic.** The `Balance deducted: ₹X` text was built from JavaScript's `newBalance`, with no confirmation that any row changed. The audit trail asserts financial events that did not occur.
4. **Read-modify-write is concurrency-unsafe.** Three approvals for one employee could each read ₹10,000 and write ₹9,000 / ₹8,000 / ₹7,000 — a final ₹7,000 instead of ₹4,000. Classic lost update.
5. **Batch approval makes that race routine, not theoretical.** `processBatchReview` fans approvals out through `Promise.allSettled`, so same-employee approvals genuinely run concurrently.

---

## 6) The fix

**Migration:** `20260808140000_atomic_expense_approval_balance_deduction.sql` (additive)

### `review_approve_expense_v2(p_expense_id uuid, p_comment text DEFAULT NULL)`

`LANGUAGE plpgsql`, `VOLATILE`, `SECURITY DEFINER`, `SET search_path = public`,
returning `jsonb`. `REVOKE ALL` from `PUBLIC` and `anon`; `GRANT EXECUTE` to
`authenticated`.

The signature accepts **no** approver id, employee id, organization id, amount,
balance or role. Everything is derived from `auth.uid()` and the expense row, so
a caller cannot nominate whose balance to debit.

Transaction order:

1. authenticate via `auth.uid()`;
2. `SELECT … FROM public.expenses WHERE id = … FOR UPDATE` — **expense locked first**;
3. reject an already-approved expense *before* locking anything else;
4. resolve the employee profile by `organization_id AND user_id`, requiring **exactly one** row;
5. lock that single profile row `FOR UPDATE` and capture `balance_before`;
6. **call V1** to perform the approval decision;
7. re-read the expense and assert it reached `approved`;
8. `UPDATE public.profiles SET balance = COALESCE(balance,0) - v_amount … RETURNING balance`;
9. insert the deduction record;
10. insert the truthful audit entry (plus `expense_verified` when an admin auto-verified);
11. return server truth.

Consistent lock ordering (**expense → profile**) across all callers is what keeps
concurrent approvals deadlock-free.

### V1 is wrapped, not copied

V2 **calls** `public.review_approve_expense`. A nested function call runs in the
same transaction, so if the deduction fails afterwards the approval rolls back
with it.

**Why wrap rather than port:** V1 carries roughly a hundred lines of security
logic — admin/engineer role checks, organization isolation, hierarchy tier
gating, `expense_manager_can_review`, `engineer_approval_limit`, allowed source
statuses, duplicate rejection and the admin auto-verify step. Copying it would
create two implementations that drift, and a drift in *that* code is a security
regression. Wrapping keeps exactly one implementation. A test asserts V2 does not
reimplement those rules.

### Atomic arithmetic

```sql
UPDATE public.profiles
SET balance = COALESCE(balance, 0) - v_amount, updated_at = now()
WHERE organization_id = v_org_id AND user_id = v_employee_id
RETURNING balance INTO v_balance_after;
```

PostgreSQL owns the subtraction, against a locked row. Nothing is computed in
JavaScript. `v_balance_after IS NULL` (a zero-row UPDATE — the exact original
failure) raises and rolls back.

**Negative balances remain valid.** ₹500 balance − ₹1,000 expense = **−₹500**, and
the approval still succeeds.

### Structured evidence — `public.expense_balance_deductions`

No suitable table existed; a repository-wide search for deduction/debit/ledger
structures found only unrelated cashier balance-update RLS.
`cash_transfer_history` was deliberately **not** reused — transfers are credits,
expense approval is a debit, and merging them would corrupt the transfer-history
feature.

| Column | Notes |
|---|---|
| `organization_id`, `expense_id`, `employee_user_id`, `approved_by` | all NOT NULL |
| `expense_amount`, `balance_before`, `balance_after` | server-captured |
| `source` | `'approval'` \| `'historical_repair'` (CHECK) |
| `created_at` | default `now()` |

**`UNIQUE (expense_id)`** — the structural guarantee that one expense can never be
debited twice, by a retry, a concurrent approval, or the future repair.

RLS is enabled with **no** write policy: the `SECURITY DEFINER` function is the
only writer. `authenticated` holds `SELECT` only, narrowed further to org admins
by policy. Employees get no direct access.

### Truthful audit

`expense_approved` is written **inside** the transaction, after the balance
UPDATE returns, from `v_amount`, `v_balance_before` and `v_balance_after`.
`organization_id` is always included (the live `audit_logs` requires it —
see §9). Admin auto-verification still writes `expense_verified`, now computed
from the **pre-approval** status so it is true only when a verify step really
happened, and written once, server-side.

### Client changes

`ExpenseService.approveExpense` now calls `review_approve_expense_v2` and the
following are **removed**: the pre-approval balance read, the JavaScript
subtraction, the `profiles.balance` write, the client-built "Balance deducted"
audit text, and the manual expense-status rollback. Notifications remain, fired
only after V2 confirms success; a notification failure cannot alter financial
state.

The RPC payload is parsed by `parseApproveExpenseV2Result` (`src/lib/approvalResult.ts`)
rather than cast with `as any`. A missing or malformed balance block raises
instead of defaulting to `0` — a wrong balance shown after a real deduction is
worse than a visible failure.

---

## 7) V1 retained deliberately

V1 is **not** modified and **not** dropped.

If V1 started deducting server-side, a cached or older frontend still carrying
the browser-side write would deduct **twice**: once in the RPC and once from the
browser. V1 must keep its exact current behaviour until the new frontend is fully
rolled out. A test asserts V1's migration still contains no balance logic, so a
later well-meaning "fix" to V1 fails CI.

Retiring V1 is a separate task, after rollout is stable.

---

## 8) MicroLink historical remediation — **COMPLETED 2026-08-08**

**Scope: 6 approved expenses · ₹880.00 total · 3 affected employees.**

Executed as **one PostgreSQL transaction**, committed **2026-08-08T18:16:27Z**,
batch identifier `historical-repair-20260808T181501Z`. The migration in this
repository did not and does not perform this repair — it was a separate,
controlled server operation.

### Pre-repair state (verified before the repair ran)

| Check | Value |
|---|---|
| Organization | MicroLink, `strategy_slug = standard` |
| Active profiles | 404 |
| Approved expenses | 6 |
| Approved total | ₹880.00 |
| Paid expenses | 0 |
| Affected employees | 3 |
| All three affected balances | **₹0.00** |
| Organization total profile balance | **₹-517.00** (belonging to one unrelated profile) |
| Existing deduction rows for those 6 expenses | **0** |
| `cash_transfer_history` rows | 0 — expected, no transfers have been made |
| Repair preconditions | **ALL PASSED** |

### Per-employee results (employee identifiers redacted to prefixes)

| Employee | Expenses | Amounts | Balance before | Balance after |
|---|---|---|---|---|
| `60d83044…` | 1 | ₹180 | ₹0 | **₹-180** |
| `c42da7ae…` | 2 | ₹200, ₹200 | ₹0 → ₹-200 | **₹-400** |
| `a97a70c6…` | 3 | ₹100, ₹100, ₹100 | ₹0 → ₹-100 → ₹-200 | **₹-300** |

### Per-expense proof, in processing order (expense identifiers redacted)

| # | Expense | Amount | Balance before → after |
|---|---|---|---|
| 1 | `dff83058…` | ₹180 | ₹0 → ₹-180 |
| 2 | `11e45915…` | ₹200 | ₹0 → ₹-200 |
| 3 | `94b187a7…` | ₹200 | ₹-200 → ₹-400 |
| 4 | `3123c291…` | ₹100 | ₹0 → ₹-100 |
| 5 | `fc0176cb…` | ₹100 | ₹-100 → ₹-200 |
| 6 | `39cb84aa…` | ₹100 | ₹-200 → ₹-300 |

Rows 2→3 and 4→5→6 are the sequential-deduction proof: the balance carries
forward correctly across multiple expenses for the same employee, which is
exactly what the old browser read-modify-write could not guarantee.

Full UUIDs are deliberately **not** reproduced here; they exist in the server
ops directory only.

### Financial invariant

```
organization total before : ₹-517.00
repair amount             : ₹  880.00
organization total after  : ₹-1,397.00

-517 - 880 = -1397   ✔ PASSED
```

### Evidence written

* **6** new `expense_balance_deductions` rows, all with `source = 'historical_repair'`.
* **6** new corrective audit rows, action `expense_balance_historical_repair`.
* The **original misleading `expense_approved` audit rows were NOT deleted or modified.** They remain intact as the historical record of what the defect produced; the corrective rows document the remediation separately. Rewriting history would have destroyed the evidence of the incident.

### Unchanged by the repair

* All 6 expense statuses remain `approved`.
* `cash_transfer_history` remains at **0 rows** — expense debits are not transfers, and nothing wrote to it.
* Unrelated employee profiles were not touched.

---

## 8a) Backup receipt

A **full Production database backup was taken before the repair.**

| Item | Value |
|---|---|
| Path | `/home/webadmin/pesowise-safe-backups/20260808T181501Z-atomic-approval/pesowise-before.dump` |
| Size | 14 MB |
| SHA-256 | `59cf9c3da0c289cbd5aacbc45c81a531cc5dd4d475ca30410ad2c075930c34f4` |
| Verification | `pg_restore --list` succeeded through the PostgreSQL container — **1886 TOC entries** |

### ⚠️ Limitation — targeted pre-repair CSV snapshots are INVALID

The attempted **targeted pre-repair CSV snapshots failed because of a quoting bug
and produced empty files.** They must not be relied on, cited as evidence, or
treated as a restore source.

Rollback is still fully supported, by four other means:

1. the **full verified `pg_restore`-checked dump** above;
2. the **exact pre-repair values** captured in the server report and reproduced in §8;
3. the **post-repair snapshots** (hashes below);
4. the **saved rollback script**, `rollback-microlink-repair.sql`, in the server ops directory.

Post-repair snapshot SHA-256 hashes:

| File | SHA-256 |
|---|---|
| `microlink-expenses-after.csv` | `13eb2c577e8d81e0cb5620a6e0d577a9e34b3b6c9f5fbb52e74d4c6f301f5ca0` |
| `microlink-profiles-after.csv` | `a50640e59203f35376af7119b1ad1292b173763025d71c06f3b7d1acbd83be5c` |
| `microlink-deductions-after.csv` | `c83e8c6606eb4dddd9d83c586633d993aff192422754dad9b419b248352c7148` |
| `microlink-repair-audits.csv` | `c8df924751576b238cea1ffb2acf737f53b0abb4bf7d39b2f42e00188d7d15aa` |

Repair script `microlink-historical-repair.sql` and rollback script
`rollback-microlink-repair.sql` are retained in the server ops directory. Their
full UUIDs are **not** copied into this repository.

---

## 8b) Production backend verification — 2026-08-08

Infrastructure: host `websrv`, container
`supabase-db-evo3o0fdjaroxq7uohrm21cp`, PostgreSQL **15.8**
(`supabase/postgres:15.8.1.085`). After the operation: PostgreSQL healthy,
PostgREST up, Auth healthy, Storage healthy, and **no repair/migration
transaction left open.**

### No migration was applied during this session

`review_approve_expense_v2` **and** `expense_balance_deductions` were found to
**already exist in Production before this server session began.** This session
therefore **verified** them, reloaded the PostgREST schema cache, and then ran
the historical repair. It is **not** correct to say a migration was applied
during the repair.

### V2 as it exists live

| Property | Verified value |
|---|---|
| Signature | `review_approve_expense_v2(uuid, text)` |
| Security | `SECURITY DEFINER`, `VOLATILE`, `search_path = public` |
| `authenticated` EXECUTE | **YES** |
| `anon` EXECUTE | **NO** |
| `PUBLIC` EXECUTE | **NO** |
| Response keys | `ok`, `expense`, `balance.before/deducted/after`, `deduction.record_id/source` |

The live definition confirms V2 authenticates via `auth.uid()`, locks the
expense `FOR UPDATE`, resolves the profile by `organization_id + user_id`
requiring exactly one match, locks that profile `FOR UPDATE`, calls
`review_approve_expense()` inside the same transaction, deducts database-side,
permits negative balances, writes `expense_balance_deductions`, uses
`source = 'approval'` for normal approvals, writes truthful server audit, and
accepts only `p_expense_id` and `p_comment` — **no browser-supplied employee id,
organization id, balance, amount or approver id is trusted.**

`public.expense_balance_deductions` live: all ten columns present,
`UNIQUE(expense_id)` enforced via `expense_balance_deductions_expense_key`, RLS
enabled with the `Admins read org deductions` read policy. It is **not** an
unrestricted browser-writable ledger.

### V1 fingerprint — unchanged

| | SHA-256 |
|---|---|
| Before | `44945d4dac8f238516c68d7a43297d0705e5239af663a34c51d819c6e3bb81a4` |
| After | `44945d4dac8f238516c68d7a43297d0705e5239af663a34c51d819c6e3bb81a4` |

**Identical — V1 was not modified.** This matters: V1 is retained deliberately
(§7) until the frontend V2 rollout completes, because a cached client that still
performs the browser-side write would double-deduct against a deducting V1.

---

## 8c) What is verified, and what is NOT

| Item | State |
|---|---|
| Live V2 structure | ✅ verified |
| Live V2 function definition | ✅ verified |
| Live historical repair | ✅ verified |
| **Approval through the actual frontend** | ✅ **VERIFIED — DEV preview, transaction 00088, see §8d** |
| **Runtime concurrency** | ❌ **still NOT verified** |
| **Production-main domain verification** | ❌ **pending frontend deployment** |

During the 2026-08-08 server session the optional runtime approval test was
deliberately skipped: the agent could not establish a legitimate `auth.uid()`
reviewer context with fully reversible cleanup, and declined to weaken auth/RLS
to manufacture one. That gap has since been closed properly — by a real approval
through a real signed-in session on the deployed DEV frontend (§8d) rather than
by a synthetic one.

---

## 8d) Controlled V2 end-to-end verification — transaction 00088

**Date:** 2026-08-08 · **Verdict: PASS — transaction 00088 V2 financial approval verified.**

A real approval was performed by a signed-in admin through the deployed **DEV
preview frontend** against the **live backend**, then audited independently from
PostgreSQL. The database audit ran strictly read-only
(`BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`) — **no database or server
change was made by the verification itself.**

| Item | Value |
|---|---|
| Transaction number | **00088** |
| Expense (redacted) | `efdfdd48…` |
| Organization | Mistry And Shah |
| Title | `pesowise v2` |
| Amount | **₹34,534.00** |
| Approved at | 2026-08-08 18:31:39.324095+00 |
| Final status | `approved` |
| Approver | admin, active organization membership |

Full UUIDs, the employee's name and email are deliberately **not** reproduced
here; the transaction number and redacted prefixes are sufficient to correlate
with the server-side evidence.

### The frontend really called V2

The captured browser HAR shows a genuine

```
POST /rest/v1/rpc/review_approve_expense_v2
{ "p_expense_id": "efdfdd48…", "p_comment": "" }
→ HTTP 200
```

so the DEV frontend uses **V2**, not V1, as its approval RPC — and it passes only
the expense id and comment, exactly the two-argument contract, with no
browser-supplied balance, amount, employee or approver.

### The money actually moved

```
balance before : ₹-210,892.00
expense amount : ₹ 34,534.00
balance after  : ₹-245,426.00

-210,892 - 34,534 = -245,426   ✔ matches the stored value
```

Note this approval ran against an **already-negative** balance and drove it
further negative without objection — the intended behaviour (§6), now confirmed
at runtime rather than only by inspection.

### It persisted, exactly once

| Check | Result |
|---|---|
| `expense_balance_deductions` rows for this expense | **exactly 1** |
| `source` | **`approval`** (not `historical_repair`) |
| Live `profiles.balance` after approval | ₹-245,426.00 — **matches `balance_after`** |
| `profiles.updated_at` vs `deduction.created_at` | identical, 18:31:39.324095+00 |
| Later approvals / deductions / transfers on that profile | **0 / 0 / 0** |
| Duplicate deduction, historical-repair row, second balance mutation | **none** |

The timestamp match plus the absence of any later mutation is what proves the
deduction is the one that persisted — not a coincidental value.

### The audit tells the truth

Timeline: `expense_created` → `expense_submitted` → `expense_verified` →
`expense_approved`. The financial audit recorded `Balance deducted: ₹34,534.00`,
`Balance before: ₹-210,892.00` and a negative balance of `₹245,426.00` — the
wording uses the absolute value, representing **₹-245,426.00**. Every figure
reconciles with both `expense_balance_deductions` and `profiles.balance`.

This is the precise defect that started this incident, now inverted: the audit
text is derived from what PostgreSQL committed, and it agrees with the committed
state.

### Authorization and isolation

The approver held an active `admin` membership. The balance mutation was
performed by V2 under `SECURITY DEFINER` — **the browser never needed direct
`profiles` UPDATE permission**, which is the architectural point of the fix.
Expense, profile, deduction and audit rows all belonged to the same organization;
no cross-organization row was involved.

### Transfer history untouched

The approval created **no `cash_transfer_history` row**, as intended. Expense
debits and transfer credits remain separate systems.

### Live V2 definition rechecked

Signature `review_approve_expense_v2(uuid, text)`; `SECURITY DEFINER`; expense
`FOR UPDATE`; profile `FOR UPDATE`; profile resolved by
`organization_id + user_id`; database-side arithmetic; structured deduction
insert; server audit; calls V1 internally; `authenticated` EXECUTE yes, `anon`
no.

**V1 unchanged:** hash `44945d4dac8f238516c68d7a43297d0705e5239af663a34c51d819c6e3bb81a4`
— identical to the previous verification. V1 still performs no balance
deduction and remains deliberately present for temporary compatibility.

### Scope of this proof

**Proven:** a single controlled approval is atomic, persists, deducts exactly
once, and produces a truthful audit — end to end, through a real app session.

**Not proven:** concurrent same-employee approvals. One approval exercises the
locks but cannot demonstrate they serialise contention. That remains
post-deployment verification.

### Console messages classified as unrelated

Vercel Live CSP block, manifest CSP warning, browser-extension
`runtime.lastError`, Grammarly warnings, a `DialogDescription` accessibility
warning, an earlier invalid refresh token, and Realtime WebSocket navigation
disconnects — none bear on transaction 00088's financial correctness.

One item is a **separate follow-up issue, deliberately not fixed here:**
`get_backend_health` returns **404** even though the database function exists
(created per DOC-088), which points to a PostgREST routing/exposure problem
rather than a missing function. It has no bearing on approval correctness.

---

### Production right now

| Component | State |
|---|---|
| V2 backend | **live** |
| V1 backend | **live and unchanged** |
| MicroLink historical balances | **corrected** |
| DEV preview frontend | **calls V2 — end-to-end verified (§8d)** |
| **Production-main frontend** | **still the OLD frontend — still calling V1** |

The V2 frontend is verified on the DEV preview only. **Production-main
deployment, and controlled verification from the Production domain, remain
pending.**

---

## 9) Schema drift note

`audit_logs.organization_id` is **NOT NULL in production but absent from every
migration in this repository** and from the generated types.
`ExpenseService.logAction` already documents this ("Some deployments have
`audit_logs` without `organization_id`") and try/catches around it. V2 always
supplies `organization_id`, which is correct for the live schema.

**Resolved for this deployment:** the 2026-08-08 repair wrote 6 corrective audit
rows successfully, which proves the live `audit_logs` accepts V2's insert shape.
The drift between repository and production remains, and is worth closing in a
later task, but it is not a risk to this rollout.

---

## 10) Tests

| File | Covers |
|---|---|
| `src/lib/__tests__/atomicApprovalDeduction.test.ts` (41) | Migration contract: additive-only (single `UPDATE public.profiles`, no DELETE/TRUNCATE/DROP), V1 untouched and still balance-free, SECURITY DEFINER + VOLATILE + pinned `search_path`, no caller-supplied identity args, REVOKE PUBLIC/anon + GRANT authenticated, V1 delegated not duplicated, expense `FOR UPDATE`, single-profile `FOR UPDATE`, duplicate rejected before profile lock, org+user scoping, **no `LIMIT 1`**, zero/multi-profile fail closed, SQL arithmetic with `RETURNING`, zero-row UPDATE fatal, negative balances allowed, `UNIQUE(expense_id)`, source CHECK, RLS with no client write grant, audit from server values written after the balance, no email/bank leakage, and **no engineer actor policy on `profiles` in any migration** |
| `src/services/__tests__/approveExpenseAtomic.test.ts` (18) | Calls V2 and never V1; passes only expense id + comment; never updates `profiles`; never writes `audit_logs`; never reverts status; the ₹5,000 → ₹1,200 → ₹3,800 engineer scenario; ₹500 − ₹1,000 = −₹500 succeeds; duplicate / missing-profile / ambiguous-profile all propagate with no local writes; malformed balance rejected; admin auto-approval reuses the path without duplicate audit; source guards proving no balance write, arithmetic, deduction text or rollback remain in `approveExpense`; batch delegates per expense with no browser balance logic |

### Concurrency is STILL NOT proven at runtime

No Docker or reachable Supabase exists in the authoring environment, so the
₹10,000 with concurrent ₹1,000 / ₹2,000 / ₹3,000 approvals settling at exactly
₹4,000 is covered only by contract assertions that the locking and SQL
arithmetic are present. **Row locking can only be observed against a real
database.**

Transaction 00088 (§8d) narrowed this gap but did **not** close it. A single
controlled approval proves atomicity, persistence, exactly-once deduction and a
truthful audit end to end — it exercises the `FOR UPDATE` locks but cannot
demonstrate they *serialise contention*, because there was no contention. So the
strongest current statement is: *one real approval is proven correct end to end;
the implementation is correct by inspection in both the repository and the live
function definition; and it has still never been observed under concurrent load.*

This is classified as **post-deployment controlled verification (PHASE 5)**, not
a merge blocker, because no implementation defect was found in either the
repository code or the live definition. Nothing here should be read as evidence
that simultaneous approvals were actually executed.

---

## 11) Deployment order

| Phase | Action | State |
|---|---|---|
| **1** | Deduction table + V2 present in Production | ✅ **DONE** — found already present 2026-08-08; no migration applied that session |
| **2** | Verify V2 signature/grants, schema cache reloaded, V1 unchanged | ✅ **DONE** — see §8b; V1 hash identical |
| **6** | Controlled historical MicroLink repair (6 / ₹880 / 3) | ✅ **DONE 2026-08-08** — see §8 |
| **4** | One controlled approval through the app: before/amount/after, status, deduction record, audit | ✅ **DONE 2026-08-08** — DEV preview, transaction 00088, §8d |
| **3** | Deploy the V2 frontend to **Production-main** | ⬜ **PENDING — Production-main still runs the old frontend and still calls V1** |
| **4b** | Repeat the controlled approval from the **Production domain** after deployment | ⬜ pending — requires phase 3 |
| **5** | Controlled **concurrent** same-employee approvals; verify cumulative arithmetic | ⬜ pending — closes the §10 gap |
| **7** | Retire V1 once the V2 frontend is fully rolled out and Production-domain verified | ⬜ pending, separate task |

Phases 1, 2 and 6 completed **out of the original order**: the backend and the
historical repair were done first, deliberately, because the repair is
independent of the frontend and removes one variable from the remaining
verification. Phases 4 and 5 cannot run until phase 3 ships, since they require
a real approval through the application.

## 12) Rollback

**Current position (backend live, frontend not yet deployed):** V2 exists but
nothing calls it, because the Production frontend still uses V1. There is
therefore **nothing to roll back** on the application side right now.

* **Before phase 3 (where we are):** no action needed. V2 is inert.
* **After phase 3:** redeploy the previous frontend; it calls V1, which is byte-identical to its pre-incident definition (§8b hash). Do **not** drop V2 while any client may still call it.
* **The historical repair** is reversed by `rollback-microlink-repair.sql` in the server ops directory, or by restoring the verified full dump (§8a). Note the targeted pre-repair CSVs are **empty and unusable** — do not attempt a rollback from them.
* **Backend objects:** `DROP FUNCTION IF EXISTS public.review_approve_expense_v2(uuid, text);` and, only if no evidence must be retained, `DROP TABLE public.expense_balance_deductions;`. Retaining the table is strongly preferred — it now holds the 6 `historical_repair` records that are the only structured proof of the remediation.

---

## Revision log

| Date | Rev | Change | By |
|------|-----|--------|-----|
| 2026-08-09 | 3.0 | Recorded the controlled end-to-end V2 approval proof, closing the "live approval-through-app not yet verified" gap. A real admin approval was performed through the deployed **DEV preview** frontend against the live backend and then audited strictly read-only from PostgreSQL (`BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`) — **verdict PASS**. Transaction **00088**, expense `efdfdd48…`, Mistry And Shah, ₹34,534.00, approved 2026-08-08 18:31:39.324095+00. The browser HAR shows a genuine `POST /rest/v1/rpc/review_approve_expense_v2` carrying only `p_expense_id` and `p_comment` → HTTP 200, confirming the frontend uses V2 and not V1. Money moved exactly: ₹-210,892.00 − ₹34,534.00 = **₹-245,426.00**, matching the stored `balance_after`, the live `profiles.balance`, and an identical `profiles.updated_at` / `deduction.created_at` timestamp, with **0** later approvals, deductions or transfers — so the deduction demonstrably persisted. **Exactly one** `expense_balance_deductions` row exists, `source = 'approval'`, no duplicate and no historical-repair row. The audit reconciles with both the deduction record and the profile — the inverse of the original defect. Approver held an active `admin` membership and the browser never needed `profiles` UPDATE permission, the architectural point of the fix. All rows shared one organization; **no `cash_transfer_history` row** was created. Live V2 definition and V1 hash (`44945d4d…`, unchanged) re-verified. Note the approval ran against an already-negative balance and drove it further negative, confirming §6's negative-balance behaviour at runtime. Status, §1, §8c, §10 and §11 updated; the DEV-preview rollout is now distinguished from the still-pending **Production-main** deployment. **Runtime concurrency remains unproven** — one approval exercises the locks but cannot show they serialise contention. `get_backend_health` 404 recorded as a separate follow-up (PostgREST routing, not a missing function) and deliberately not fixed here. Identifiers redacted; no full UUID, employee name or email reproduced. Documentation only. | Claude Code |
| 2026-08-09 | 2.0 | Recorded the completed Production server phase. **Backend V2 and `expense_balance_deductions` were found ALREADY PRESENT in Production before the server session — no migration was applied during the repair**, so any claim of "migration applied during historical repair" would be false. The session verified V2 live (signature `review_approve_expense_v2(uuid, text)`, SECURITY DEFINER, VOLATILE, `search_path = public`, EXECUTE to `authenticated` only), reloaded the PostgREST schema cache, and fingerprinted V1 before and after: SHA-256 identical (`44945d4d…`), **V1 unchanged**. **MicroLink historical repair COMPLETED 2026-08-08T18:16:27Z** in one transaction — 6 expenses, ₹880.00, 3 employees; all three balances ₹0 → ₹-180 / ₹-400 / ₹-300; organization total ₹-517 → ₹-1,397 (invariant `-517 - 880 = -1397` passed); 6 `historical_repair` deduction rows and 6 `expense_balance_historical_repair` corrective audits written, with the original misleading `expense_approved` audits deliberately preserved rather than rewritten. Backup receipt recorded (14 MB dump, SHA-256 `59cf9c3d…`, `pg_restore --list` verified, 1886 TOC entries) together with the **honest limitation that the targeted pre-repair CSV snapshots were empty due to a quoting bug and must not be used as a restore source**. Employee and expense identifiers are redacted to prefixes; no full UUID is reproduced. Status, §8, §9, §11 and §12 corrected from "pending/not applied". **Frontend V2 rollout remains PENDING — Production still runs the old frontend and still calls V1 — and live approval-through-app plus runtime concurrency remain unverified (§8c).** Documentation only; no code change. | Claude Code |
| 2026-08-08 | 1.0 | Documented the confirmed incident and prepared the fix on `dev`: additive migration adding `expense_balance_deductions` (UNIQUE per expense, RLS, no client write grant) and `review_approve_expense_v2`, which locks the expense then the single org+user profile, wraps V1 for authorization inside one transaction, performs the balance arithmetic in SQL and writes truthful audit + structured evidence. `ExpenseService.approveExpense` rewritten to call V2; client balance read, JavaScript subtraction, `profiles.balance` write, client-built deduction audit and status rollback all removed. V1 deliberately unchanged for rollout compatibility. 59 new tests. **Migration not applied, nothing deployed, MicroLink historical repair (6 / ₹880 / 3) explicitly deferred; runtime concurrency proof deferred to PHASE 5.** | Claude Code |
