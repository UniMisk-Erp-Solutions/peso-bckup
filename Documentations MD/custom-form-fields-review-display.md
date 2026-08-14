# Custom Form Fields — Review Display Issue (Full Handoff)

**Doc ID:** DOC-001  
**Document purpose:** Complete technical handoff for another developer or consultant.  
**Product:** Pesowise (expense management)  
**Supabase host (prod):** `pesowise-supabase.unimisk.com`  
**Test org:** Microlink (`admin@microlink.com`, org id `6709c1fe-e8c8-404d-bc68-d1edda923344`)  
**Last updated:** 2026-05-29  
**Status:** **Fixes implemented locally (Pass 8 + Pass 9)** — requires hard refresh / redeploy + **run migration `20260630120000`** on prod. Old expenses with **zero DB rows** may need re-submit.

---

## Table of contents

1. [Executive summary](#1-executive-summary)  
2. [What the feature is](#2-what-the-feature-is)  
3. [Symptoms (chronological)](#3-symptoms-chronological)  
4. [Where fields should appear](#4-where-fields-should-appear)  
5. [Data model](#5-data-model-postgres)  
6. [End-to-end data flow](#6-end-to-end-data-flow)  
7. [Root causes (complete list)](#7-root-causes-complete-list)  
8. [Fix logic (how each layer works now)](#8-fix-logic-how-each-layer-works-now)  
9. [Timeline of fix attempts](#9-timeline-of-fix-attempts)  
10. [Migrations reference](#10-migrations-reference)  
11. [Diagnostic SQL & network checks](#11-diagnostic-sql--network-checks)  
12. [Git / deploy state](#12-git--deploy-state)  
13. [Acceptance criteria](#13-acceptance-criteria)  
14. [How to reproduce & interpret failures](#14-how-to-reproduce--interpret-failures)  
15. [Key files index](#15-key-files-index)  
16. [Summary for non-technical stakeholders](#16-summary-for-non-technical-stakeholders)  
17. [Pass 9 — Labels shown but values empty (—)](#17-pass-9--labels-shown-but-values-empty-)

---

## 1) Executive summary

**Problem:** When admins or reviewers open an expense, the **“Additional Information”** section (category-specific custom form fields) is often **missing entirely**, or shows every label as generic **“Field”**.

**Why it kept coming back:** This was **not one bug** but a **stack of independent failures** across React state, PostgREST queries, RLS policies, RPC deployment, invalid SQL column names, and save-path upsert errors. Fixing one layer exposed the next.

**Latest fix (Pass 8 + Pass 9, 2026-05-29):**

| Layer | Fix |
|-------|-----|
| **React stale state (Pass 8)** | Review dialog uses `reviewExpense` — live row from `expenses[]` |
| **Prefetch wiring (Pass 8)** | `prefetchedFields={reviewExpense.custom_fields}` from list enrichment |
| **Empty em-dash values (Pass 9)** | Category fallback no longer shows labels without data; dedicated per-expense map fetch; merge values by field name |
| **Org-filter drops rows (Pass 9)** | Value/template queries try with org, then without org |
| **Fetch merge** | Parallel value rows + RPC; `applyFieldMapToRows` + `mergeDisplayRowsByName` |
| **Save reliability** | Delete+insert fallback; throw on save failure; migration `20260630120000` |

**If fields still missing for a specific expense after deploy:** That expense may have **zero rows** in `expense_form_field_values` because values failed to save at submit time (before upsert fix). Re-submit or backfill SQL.

---

## 2) What the feature is

Organizations attach **custom form fields** to expense categories (Form Builder in Settings). On submit, values are stored per expense — e.g. Project Name, Location, odometer reading, conditional sub-fields when a dropdown option is selected.

**Business requirement:**

- Reviewers and admins see **all saved custom field values** in review dialogs (Admin Panel, Engineer Review, batch review, expense detail).
- Labels show the **real field name** (e.g. “Project Name”), not **“Field”**.
- Show **all saved values** regardless of `show_on_review` / `show_on_detail` flags.

**i18n note:** Field **labels** come from the database (org-defined). Only section headings (`Additional Information`) are translated via `admin:review.additionalInformation`.

---

## 3) Symptoms (chronological)

| # | What the user saw | Where |
|---|-------------------|--------|
| 1 | Custom fields **completely missing** | Admin Panel dialog, Engineer Review, batch review |
| 2 | Visible on employee detail sometimes, **not for reviewers** | Same expense, different role |
| 3 | After commit `83b567f`, fields appeared but **every label was “Field”** | Expense detail card |
| 4 | After label refactor, fields **disappeared again** | Admin Panel review dialog |
| 5 | Console: `[i18n] missing key: admin:review.additionalInformation` | Cosmetic (fallback text still renders) |
| 6 | Latest screenshot: expense “wrwer”, Petrol Expense — **no Additional Information** between Current Status and Admin Comment | Admin Panel |
| 7 | Network tab: bulk queries return **200** but dialog empty | Admin Panel |
| 8 | After Pass 8: section appears but **all values show "—"** (Project Name, Project ID, From/To location) | Admin Panel |

**Not this bug:** Sentry invalid DSN, PWA manifest blob warnings, WebSocket notification churn, browser extension `runtime.lastError`.

---

## 4) Where fields should appear

Shared component: **`ExpenseFormFieldsDisplay`**

| Surface | File | Notes |
|---------|------|-------|
| Admin expense review dialog | `src/pages/AdminPanel.tsx` | Uses `reviewExpense` + `prefetchedFields` |
| Manager / hierarchy review | `src/pages/EngineerReview.tsx` | Same `reviewExpense` pattern |
| Batch review card | `src/components/BatchExpenseDetailCard.tsx` | Per-expense fetch only (no prefetch yet) |
| Employee expense detail | `src/pages/ExpenseDetail.tsx` | `variant="card"` |
| Legacy wrapper | `src/components/ExpenseBranchValuesDisplay.tsx` | Delegates to shared component |

**Critical render rule:** If `fetchExpenseFormFieldDisplay()` returns `[]`, the component returns **`null`** — the section is **silently hidden**. No error banner. This makes failures look like “no custom fields configured.”

---

## 5) Data model (Postgres)

```
expense_form_field_templates          — definitions (name, field_key, field_type, options)
expense_category_form_fields          — links templates to categories (display_order lives HERE)
expense_form_field_option_branches    — conditional sub-fields (dropdown branches)
expense_form_field_values             — saved values (template_id OR branch_field_id, not both)
```

**Value row rule:** Exactly one of `template_id` or `branch_field_id` must be set.

**Save path:** `ExpenseService.saveExpenseFormFieldValues()` and `saveBranchFieldValues()` write to `expense_form_field_values` with `organization_id`.

**Original RLS (20250130000004):** Values visible only to expense owner, assigned engineer, or org admin — **not** hierarchy reviewers who could still read the parent `expenses` row.

---

## 6) End-to-end data flow

### 6.1 Submit (employee)

```
Expense form UI
  → collects formFieldValues: Record<templateId, string>
  → ExpenseService.saveExpenseFormFieldValues(expenseId, orgId, formFieldValues)
       → upsert on (expense_id, template_id)
       → on failure: delete existing rows for those template_ids + insert
  → saveBranchFieldValues() for conditional dropdown sub-fields
```

If upsert fails (no unique index on prod) and delete+insert also fails, **no rows are saved** — review will show nothing forever for that expense until re-submitted.

### 6.2 List load (Admin Panel)

```
AdminPanel.fetchExpenses()
  ├── Phase 1 (fast): setExpenses with custom_fields: {}
  └── Phase 2 (async enrichment):
        fetchExpenseCustomFieldsMap(orgId, expenseIds)
          → bulk SELECT expense_form_field_values (chunked .in(expense_id))
          → bulk SELECT templates/branches for id → name
          → returns Record<expenseId, Record<fieldName, value>>
        setExpenses(... custom_fields: customByExpense[expenseId] ?? {})
```

This bulk path **works** on Microlink (user logs: 200, ~2.1 kB for values).

### 6.3 Review dialog (where the bug was)

**Before fix:**

```
User clicks expense row
  → setSelectedExpense(expense)     // snapshot at click time
  → Dialog opens ExpenseFormFieldsDisplay(selectedExpense.id)
  → selectedExpense.custom_fields === {}   // enrichment not done yet OR never updated
  → fetchExpenseFormFieldDisplay() may also return []
  → component returns null → section missing
```

**After fix:**

```
const reviewExpense = useMemo(() =>
  expenses.find(e => e.id === selectedExpense.id) ?? selectedExpense,
  [selectedExpense, expenses]);

<ExpenseFormFieldsDisplay
  key={`${reviewExpense.id}-${Object.keys(reviewExpense.custom_fields ?? {}).sort().join(",")}`}
  prefetchedFields={reviewExpense.custom_fields}
  ...
/>
```

When enrichment completes, `expenses` updates → `reviewExpense.custom_fields` populates → `key` changes → component remounts → `fetchExpenseFormFieldDisplay` merges prefetched rows immediately.

### 6.4 Display fetch (shared library)

```
fetchExpenseFormFieldDisplay(supabase, expenseId, orgId, context, { prefetchedFields })
  │
  ├─ prefetchedRows = rowsFromPrefetchedFields(prefetchedFields)   // instant from list map
  │
  ├─ Promise.all([
  │     loadValueRows(expenseId),          // direct SELECT on values table
  │     fetchViaRpc(..., p_context: 'all') // SECURITY DEFINER backup
  │   ])
  │
  ├─ fetchTemplateRowsByIds + fetchBranchRowsByIds (batched, progressive SELECT)
  ├─ buildDisplayRows + enrichRowsWithMeta (fix "Field" labels via field_key)
  ├─ mergeDisplayRows(clientRows, rpcRows)
  ├─ mergeDisplayRows(result, prefetchedRows)
  │
  └─ if still empty → fetchCategoryFallbackRows (category assignments + saved values)
```

---

## 7) Root causes (complete list)

### A) RLS on `expense_form_field_values` too strict

Reviewers could SELECT `expenses` but not joined form values.

**Fix:** Policy “View form field values for visible expenses” — EXISTS subquery on parent expense (migration `20260621120000`, reinforced in `20260630120000`).

---

### B) PostgREST nested embeds unreliable on self-hosted Supabase

`.select('..., expense_form_field_templates(name)')` failed silently → empty UI.

**Fix:** Flat batched queries in `fetchExpenseFormFieldDisplay.ts` (commit `83b567f`).

---

### C) RPC returns generic `"Field"` when template join fails

v1 RPC: `coalesce(t.name, b.name, 'Field')` with strict org JOIN.

**Fix:** Label chain `name → field_key → humanize` in migration `20260629120000`; client-side `resolveFieldLabel()` + `enrichRowsWithMeta()`.

---

### D) Regression — early return when value rows empty

```typescript
if (valueRows.length === 0) return [];  // skipped RPC entirely
```

**Fix:** Parallel fetch + `mergeDisplayRows()` — never discard RPC data when direct SELECT is empty.

---

### E) Rows dropped in `buildDisplayRows`

Orphan value rows skipped if template/branch meta missing.

**Fix:** Always emit a row per value row; minimum generic label.

---

### F) `show_on_review` / `show_on_detail` filtering

Old RPC hid fields when `p_context === 'review'`.

**Fix:** Client ignores flags; RPC called with `p_context: 'all'` first.

---

### G) Template metadata not readable by non-admin roles

**Fix:** Migration `20260402100000` — org members can SELECT templates.

---

### H) Silent UI on failure

`ExpenseFormFieldsDisplay` returns `null` when empty — looks like “no fields.”

**Status:** Still true; recommended future improvement (see §13).

---

### I) **Stale React state in review dialog (critical, Pass 8)**

**Symptom:** Bulk `fetchExpenseCustomFieldsMap` succeeds (Network 200), but dialog shows nothing.

**Cause:**

1. `setSelectedExpense(expense)` on row click captures expense **before** async enrichment adds `custom_fields`.
2. When enrichment completes, only `expenses[]` updates — **`selectedExpense` state is never synced**.
3. Dialog passed `prefetchedFields={selectedExpense.custom_fields}` → always `{}`.
4. If per-expense fetch also failed, section hidden.

**Fix:**

```typescript
// AdminPanel.tsx & EngineerReview.tsx
const reviewExpense = useMemo(() => {
  if (!selectedExpense) return null;
  return expenses.find((e) => e.id === selectedExpense.id) ?? selectedExpense;
}, [selectedExpense, expenses]);
```

Pass `reviewExpense.custom_fields` to `ExpenseFormFieldsDisplay`. Use dynamic `key` so component remounts when enrichment arrives.

**ExpenseFormFieldsDisplay:** `useEffect` depends on `JSON.stringify(prefetchedFields)` not object reference, so enrichment updates trigger re-fetch.

---

### J) Invalid SELECT column → HTTP 400 on template lookup

Code once selected `display_order` from `expense_form_field_templates`. That column **does not exist** on templates — it lives on `expense_category_form_fields`.

**Symptom:** All template batch queries return 400 → no labels → every field shows **“Field”**, or merge fails → empty section.

**Fix:** `TEMPLATE_SELECT_ATTEMPTS` progressive fallback:

```typescript
const TEMPLATE_SELECT_ATTEMPTS = [
  "id, name, field_key, field_type, show_on_review, show_on_detail",
  "id, name, field_key, field_type",
  "id, name, field_type",
  "id, name",
] as const;
```

`display_order` loaded separately via `fetchCategoryDisplayOrders()` from `expense_category_form_fields`.

---

### K) Form values never saved at submit (upsert failure)

**Symptom:** Category has form fields; employee filled them; review shows nothing; SQL query 1 returns 0 rows.

**Cause:** `upsert(..., { onConflict: "expense_id,template_id" })` requires unique index. Partially migrated prod DB lacked index → 400 on save → silent failure (before delete+insert fallback).

**Fix:**

- Client: `ExpenseService.saveExpenseFormFieldValues` — on upsert error, delete+insert retry.
- DB: `20260630120000` creates partial unique indexes:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_field_values_expense_template
  ON expense_form_field_values (expense_id, template_id) WHERE template_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_form_field_values_expense_branch
  ON expense_form_field_values (expense_id, branch_field_id) WHERE branch_field_id IS NOT NULL;
```

**Test case “wrwer” (Petrol Expense, Jun 23 2026):** If this expense was submitted **before** save fix + has 0 value rows, section will correctly stay empty until employee re-submits or values are backfilled.

---

### L) RPC `get_expense_form_field_display` returns 400 on prod

Function not deployed or PostgREST schema cache stale.

**Fix:** Run `20260630120000` (or `20260629120000`) and **reload PostgREST schema** / restart API on Coolify. Client still works via direct SELECT + prefetch when RPC fails.

---

## 8) Fix logic (how each layer works now)

### 8.1 `rowsFromPrefetchedFields`

Converts Admin Panel list map `{ "Project Name": "ABC", ... }` into display rows immediately — no DB round-trip needed for labels (keys are already human-readable names from `fetchExpenseCustomFieldsMap`).

### 8.2 `loadValueRows`

- Tries SELECT with/without `branch_field_id` column (schema drift tolerance).
- Tries with/without `organization_id` filter.
- Returns `[]` only when both queries succeed with zero rows (expense truly has no saved values).

### 8.3 `queryTableBatchWithSelectFallback`

For each batch of template/branch IDs, tries multiple SELECT strings until one succeeds — handles prod schemas missing optional columns.

### 8.4 `resolveFieldLabel`

```
if (name.trim() && name !== "Field") → use name
else if (field_key) → humanize(field_key)  // "project_name" → "Project Name"
else → "Field"
```

### 8.5 `mergeDisplayRows`

Union by value row `id`. Prefer non-generic names. Prefer non-empty values. Used to combine client + RPC + prefetched sources without duplicates.

### 8.6 `fetchCategoryFallbackRows`

When no saved values merge to visible rows:

1. Load expense category name from `expenses.category`
2. Load template assignments from `expense_category_form_fields`
3. Build rows for assigned templates that **have** saved values
4. Filter: keep rows with non-empty value OR non-generic label

Does **not** show empty placeholders for unfilled fields (product could change this).

### 8.7 `fetchViaRpc`

Tries `p_context` in order: `'all'`, `'review'`, `'detail'`. Uses first non-empty result. Logs non-schema errors only.

### L) Category fallback shows empty labeled rows (Pass 8 regression → Pass 9 fix)

**Symptom:** "Additional Information" visible; every field shows **—**.

**Cause:** Category assignments loaded labels; value fetch failed; filter kept rows with labels but empty values.

**Fix:** Pass 9 — always fetch `fetchExpenseCustomFieldsMap` for single expense; merge by name; `rowsWithValuesOnly` at end.

---

### M) Org-filtered queries drop legacy value rows

**Symptom:** Bulk map returns partial data; per-expense values missing.

**Cause:** `.eq("organization_id", organizationId)` on values/templates when row org_id mismatches parent expense.

**Fix:** Pass 9 — try with org, then without org on values and template lookups.

---

## 9) Timeline of fix attempts

| Phase | What was done | Outcome |
|-------|---------------|---------|
| Initial | PostgREST embeds in review pages | Fields missing |
| Pass 1 | `fetchExpenseFormFieldDisplay` + shared component | Partial |
| Pass 2 | RLS migration `20260621120000` | Needed SQL on prod |
| Pass 3 | RPC v1 + RPC-first client | Partial; self-transfer separate |
| Pass 4 | Push `83b567f`, RPC v2 `20260621140000` | Some paths fixed |
| Pass 5 | Label resolution + `20260629120000` draft | Labels still “Field” on some paths |
| Pass 6 | Client-first refactor with early `return []` | **Regression** — fields gone |
| Pass 7 | Parallel merge, `p_context: 'all'`, i18n keys | Better but dialog still empty |
| **Pass 8** | **`reviewExpense` stale-state fix**, prefetchedFields wiring | Section appears |
| **Pass 9** | **Empty values (—)** — category skeleton without data; org-filter dropped values; map fetch always runs | Values should populate when DB has rows |

---

## 17) Pass 9 — Labels shown but values empty (—)

### What the user saw (after Pass 8)

Admin Panel review dialog showed **Additional Information** with correct labels:

- Project Name: **—**
- Project ID: **—**
- From location: **—**
- To location: **—**

This is **worse UX than hidden fields** — it looks broken and damages trust.

### Root cause

Pass 8 made the section visible via **category fallback** (`fetchCategoryFallbackRows`). That path:

1. Loads field **definitions** from `expense_category_form_fields` + `expense_form_field_templates` (labels work).
2. Tries to attach **values** from `expense_form_field_values` by `template_id`.
3. When value rows are empty or not matched, it still kept rows because of this filter:

```typescript
.filter((row) => row.field_value.trim() !== "" || !isGenericFieldLabel(row.name));
//                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                      keeps labeled rows even with NO value
```

So the UI rendered category field names with em-dash placeholders.

### Why values were not loading

Multiple compounding issues:

| Issue | Effect |
|-------|--------|
| `fetchExpenseCustomFieldsMap` always used `.eq("organization_id", organizationId)` | Rows with mismatched/null `organization_id` excluded from bulk map and prefetch |
| Template name lookup skipped value rows when name resolve failed (`if (!name) continue`) | Values in DB discarded silently during map build |
| Review dialog prefetch could be `{}` while values existed under different query path | Display never received name→value map |
| Category fallback ran when primary fetch returned no **value** rows, not when labels missing | Showed skeleton instead of real data |
| Values never saved at submit (upsert 400 before save fix) | **No rows in DB at all** for some expenses (e.g. older "wrwer" submission) |

### Pass 9 fixes (code)

**1. `fetchExpenseCustomFieldsMap` (`expenseCustomFieldFilters.ts`)**

- Value query: try **with org filter**, then **without org filter** per batch.
- Template/branch meta: try with org, then without; include `field_key` for label fallback.
- Never drop a value row silently — resolve label via `name → field_key → humanize`.

**2. `fetchExpenseFormFieldDisplay` (`fetchExpenseFormFieldDisplay.ts`)**

- **`resolveFieldValueMap`**: always calls `fetchExpenseCustomFieldsMap(orgId, [expenseId])` even when inline prefetch is empty.
- **`applyFieldMapToRows`**: merges name→value map into display rows by normalized field name.
- **`mergeDisplayRowsByName`**: combines category skeleton rows with RPC/client/prefetch rows by name; prefers row that has a value.
- **`rowsWithValuesOnly`**: final output **only includes fields with non-empty values** — no more labeled em-dash placeholders.
- Category fallback only runs when **no row has a value yet**; then merges map again.

**3. `ExpenseForm.tsx`**

- Load existing values: org filter, then fallback without org filter.
- Save failure on insert retry now **throws** so submit does not silently succeed without custom field data.

### Logic flow after Pass 9

```
fetchExpenseFormFieldDisplay(expenseId)
  │
  ├─ resolveFieldValueMap()
  │     ├─ fetchExpenseCustomFieldsMap([expenseId])  ← always, dedicated fetch
  │     └─ merge with inline prefetchedFields from AdminPanel
  │
  ├─ loadValueRows + RPC (parallel)
  ├─ build client rows + enrich labels
  ├─ merge all sources
  ├─ applyFieldMapToRows(fieldMap)
  ├─ mergeDisplayRowsByName()
  │
  ├─ if still no values → category fallback + applyFieldMap again
  └─ return rowsWithValuesOnly()   ← never show "Project Name: —"
```

### If values are STILL missing after Pass 9

The expense likely has **no saved rows** in `expense_form_field_values`. Confirm:

```sql
SELECT * FROM expense_form_field_values WHERE expense_id = '<EXPENSE_UUID>';
```

**If 0 rows:** Employee must re-open and re-submit the expense (after migration `20260630120000` + deploy), or admin backfills manually. Pass 9 cannot invent data that was never persisted.

**If rows exist but UI empty:** Check RLS (run `20260630120000`), reload PostgREST schema, verify template IDs in value rows still match current category assignments.

---

*End Pass 9 section.*

## 10) Migrations reference

| Migration | Purpose | Prod? |
|-----------|---------|-------|
| `20250130000004_create_expense_form_fields.sql` | Base tables + strict RLS | Yes |
| `20260402100000_allow_org_members_select_expense_form_fields.sql` | Org members read templates | Verify |
| `20260514120000_conditional_dropdown_branches.sql` | Branch fields | Verify |
| `20260621120000_expense_form_field_display_access.sql` | Values RLS + RPC v1 | Likely yes |
| `20260621140000_form_fields_display_v2_and_self_transfer.sql` | RPC v2 | Likely yes |
| `20260629120000_form_field_display_labels.sql` | RPC label chain | **Verify / run** |
| **`20260630120000_custom_form_fields_review_fix.sql`** | **RLS + upsert indexes + consolidated RPC** | **NOT deployed — run next** |

**After any RPC migration:** Reload PostgREST schema or restart Supabase API.

---

## 11) Diagnostic SQL & network checks

Replace UUIDs with failing expense from Microlink.

```sql
-- 1) Saved values for this expense?
SELECT id, expense_id, organization_id, template_id, branch_field_id, field_value
FROM public.expense_form_field_values
WHERE expense_id = '<EXPENSE_UUID>'
ORDER BY created_at;

-- 2) Label resolution
SELECT v.id,
       t.name AS template_name, t.field_key,
       b.name AS branch_name, b.field_key AS branch_key,
       v.field_value
FROM public.expense_form_field_values v
LEFT JOIN public.expense_form_field_templates t ON t.id = v.template_id
LEFT JOIN public.expense_form_field_option_branches b ON b.id = v.branch_field_id
WHERE v.expense_id = '<EXPENSE_UUID>';

-- 3) RPC (as authenticated org member)
SELECT * FROM public.get_expense_form_field_display(
  '<ORG_UUID>'::uuid,
  '<EXPENSE_UUID>'::uuid,
  'all'
);

-- 4) Category assignments (Petrol Expense example)
SELECT c.name AS category, t.name AS field_name, cc.display_order
FROM public.expense_categories c
JOIN public.expense_category_form_fields cc ON cc.category_id = c.id
JOIN public.expense_form_field_templates t ON t.id = cc.template_id
WHERE c.organization_id = '<ORG_UUID>'
  AND c.name ILIKE '%petrol%'
ORDER BY cc.display_order;

-- 5) Upsert indexes exist?
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'expense_form_field_values'
  AND indexname LIKE 'idx_form_field_values_expense%';
```

**Browser DevTools (Admin Panel → open expense):**

| Request | Healthy | Problem |
|---------|---------|---------|
| Bulk `expense_form_field_values?...in.(expense_ids)` | 200, non-empty | RLS or no data org-wide |
| Per-expense values (inside dialog load) | 200 with rows | RLS or no rows for this expense |
| `expense_form_field_templates?id=in.(...)` | 200 | **400** = bad SELECT columns (should be fixed in client) |
| `rpc/get_expense_form_field_display` | 200 with rows | **400** = RPC not deployed / schema cache |

**React DevTools check:** After enrichment completes, `expenses[n].custom_fields` should be non-empty for expenses with saved values. `reviewExpense.custom_fields` in dialog should match — not `{}`.

---

## 12) Git / deploy state

| Item | State |
|------|--------|
| Commit `83b567f` | Pushed — initial RPC + display component |
| `src/lib/fetchExpenseFormFieldDisplay.ts` | Modified — merge, prefetch, fallbacks |
| `src/components/ExpenseFormFieldsDisplay.tsx` | Modified — prefetchedFields, prefetchKey dep |
| `src/pages/AdminPanel.tsx` | Modified — **`reviewExpense` useMemo** |
| `src/pages/EngineerReview.tsx` | Modified — **`reviewExpense` useMemo** |
| `src/services/ExpenseService.ts` | Modified — delete+insert save fallback |
| `src/lib/expenseCustomFieldFilters.ts` | Modified — org fallback on value/template fetch (Pass 9) |
| `src/pages/ExpenseForm.tsx` | Modified — load/save value reliability (Pass 9) |
| `supabase/migrations/20260630120000_custom_form_fields_review_fix.sql` | **Local — must run on prod** |

**User rule:** Do not push unless explicitly requested.

**Deploy checklist:**

1. Run migration `20260630120000` on prod Supabase.
2. Reload PostgREST schema.
3. Deploy frontend with Pass 8 changes.
4. Hard refresh browser (Ctrl+Shift+R) to pick up new bundle + i18n.
5. Test expense **known to have** value rows in SQL query 1.
6. Submit **new** expense with custom fields filled — confirm query 1 has rows after submit.

---

## 13) Acceptance criteria

1. Admin opens expense **with saved custom field values** → **Additional Information** shows all fields with correct labels.
2. Opening dialog **before** list enrichment finishes → fields appear once enrichment completes (no re-open needed).
3. Hierarchy reviewer sees same fields on Engineer Review.
4. Employee sees same fields on Expense Detail.
5. Conditional branch fields show branch labels.
6. Fields with `show_on_review = false` still appear.
7. Works when direct SELECT returns 0 but RPC returns data.
8. Works when RPC 400 but direct SELECT + prefetch succeed.
9. New expense submit persists values (no upsert 400 in console).

---

## 14) How to reproduce & interpret failures

1. Log in as `admin@microlink.com`.
2. Admin Panel → All Expenses → open an expense with known custom data.
3. Look for **Additional Information** between **Current Status** and **Admin Comment**.

| Observation | Likely cause | Action |
|-------------|--------------|--------|
| Section missing; SQL query 1 empty | Values never saved | Run migration; re-submit expense |
| Section missing; SQL has rows; bulk 200 | Stale state (pre-Pass-8) | Deploy Pass 8 `reviewExpense` fix |
| Section shows labels, all values **—** | Category skeleton without loaded values (Pass 8) | Deploy Pass 9; verify SQL has rows |
| Section missing; SQL has rows; prefetch empty | Enrichment failed silently | Check console for `custom fields map` warnings |
| All labels “Field” | Template SELECT 400 or missing `20260402100000` | Deploy client fallbacks + template RLS migration |
| RPC 400 | Function missing on prod | Run `20260630120000`, reload schema |
| i18n missing key warning | Old bundle cached | Hard refresh |

---

## 15) Key files index

```
src/lib/fetchExpenseFormFieldDisplay.ts       — load, merge, label, prefetch, category fallback
src/lib/expenseCustomFieldFilters.ts          — fetchExpenseCustomFieldsMap (list enrichment)
src/components/ExpenseFormFieldsDisplay.tsx   — UI (null if empty)
src/pages/AdminPanel.tsx                      — reviewExpense + dialog
src/pages/EngineerReview.tsx                  — reviewExpense + dialog
src/services/ExpenseService.ts                — saveExpenseFormFieldValues, saveBranchFieldValues
src/pages/ExpenseDetail.tsx
src/components/BatchExpenseDetailCard.tsx

supabase/migrations/20260630120000_custom_form_fields_review_fix.sql  ← run on prod
supabase/migrations/20260629120000_form_field_display_labels.sql
supabase/migrations/20260621120000_expense_form_field_display_access.sql
```

---

## 16) Summary for non-technical stakeholders

Employees answer extra questions when submitting expenses (project name, location, etc.). Managers and admins **must see those answers** when reviewing.

The app had a chain of problems: permissions blocked some users from reading saved answers; the review popup used **outdated data** from when you first clicked the row instead of the fully loaded expense list; some database requests used wrong column names and failed; and sometimes answers **never saved** when the employee submitted.

The latest fix makes the review popup read from the **live expense list** (which already loads custom fields successfully), loads data through **multiple backup paths**, and adds database changes so new submissions **save reliably**.

**For the consultant:** Run migration `20260630120000`, deploy the latest frontend, verify with SQL that the test expense actually has saved values, then test in Admin Panel. If a specific old expense still shows nothing, the data was likely never saved — re-submit or backfill.

---

*Agent transcript: `b2377ad7-4794-4f00-833a-195fbb6c5ed7`. Conversation spans commits `83b567f` through Pass 8 local changes (2026-05-29).*

---

## 17) Pass 10 — Canonical field display unification (2026-07-15)

**Branch:** `feature/user-activity-insights`

### New files

| File | Purpose |
|------|---------|
| `src/lib/expenseFieldDisplayModel.ts` | Canonical identity model: `base:<key>` / `template:<uuid>` / `branch:<uuid>` / `legacy:<uuid>`. Pure types + helpers. 52 tests. |
| `src/hooks/useOrganizationExpenseFormConfig.ts` | React Query hook for `organization_expense_form_fields`. Exposes `getFieldLabel`, `isVisibleOnReview`, `isVisibleOnDetail`. Translates labels only when not org-customized. |
| `src/components/ExpenseBaseFieldsDisplay.tsx` | Shared read-only renderer for the 6 base fields. Applies org config + context visibility. Use on all review/detail surfaces instead of hardcoded labels. |
| `docs/sql/custom-form-fields-display/00_verify_expense_field_display_health.sql` | Read-only health check queries (orphan rows, null flags, duplicate names, unrecognized field keys). DO NOT execute via migrations. |

### Modified files

| File | Change |
|------|--------|
| `src/lib/fetchExpenseFormFieldDisplay.ts` | (1) `_context` param renamed to `context` and now passed to `buildDisplayRows` — `show_on_review`/`show_on_detail` flags applied as filter. (2) `stableId` field added to `ExpenseFormFieldDisplayRow`. (3) `buildDisplayRows` assigns `template:<uuid>` / `branch:<uuid>` / `legacy:<uuid>` stableIds. (4) `mergeDisplayRowsByName` replaced with stable-ID-first dedup. (5) New `fetchExpenseFormFieldDisplaySafe` returns `FieldDisplayResult`. |
| `src/components/ExpenseFormFieldsDisplay.tsx` | Added error state + Retry button. No longer silently returns null on fetch failure. |
| `src/lib/batchExpenseReview.ts` | Checkbox-false bug fixed (line 180): `raw === "false"` no longer skipped; renders as "No" to reviewers. |
| `src/locales/en/expenses.json` | Added `fieldDisplay.*`, `baseFields.*`, `customFields.loadError`, `loadingFields` keys. |
| `src/locales/hi/expenses.json` | Same keys in Hindi. |
| `src/locales/gu/expenses.json` | Same keys in Gujarati. |

### Root causes fixed in this pass

1. All review/detail surfaces hard-coded base-field labels — now `ExpenseBaseFieldsDisplay` reads from `useOrganizationExpenseFormConfig`.
2. `_context` param in `fetchExpenseFormFieldDisplay` was dead code — now applied as `show_on_review`/`show_on_detail` filter.
3. `mergeDisplayRowsByName` used display name as merge key — now uses stable `template:<uuid>` / `branch:<uuid>` identity.
4. Checkbox-false explicitly skipped in batch review — now preserved and shown as "No".
5. `ExpenseFormFieldsDisplay` silently returned null on error — now shows error + retry UI.

---

## Pass 11 — Base field label surface rollout (Phase M/N, 2026-07-15)

**Commit:** `d8b8a66`  **Branch:** `feature/user-activity-insights`

Applied `useOrganizationExpenseFormConfig` + `ExpenseBaseFieldsDisplay` to all 5 remaining review/detail surfaces that still used hardcoded English labels.

### Surfaces updated

| File | Change |
|------|--------|
| `src/pages/AdminPanel.tsx` | Review dialog: replaced 5 hardcoded base-field label blocks with `<ExpenseBaseFieldsDisplay context="review">`. Correction dialog: 5 labels replaced with `getBaseFieldLabel()`. |
| `src/pages/EngineerReview.tsx` | Trip Details card body: replaced 4 hardcoded fields with `<ExpenseBaseFieldsDisplay context="review">`. Correction dialog: labels replaced with `getBaseFieldLabel()`. |
| `src/pages/ExpenseDetail.tsx` | Icon-layout read-only fields: "Destination", "Date of Expense", "Category", "Purpose" replaced with `getBaseFieldLabel()` + `isVisibleOnDetail()` guards. |
| `src/components/mobile/MobileAdminExpenseDetailView.tsx` | `DetailRow` labels for amount, category, purpose, expense_date replaced with `getBaseFieldLabel()` + `isVisibleOnDetail()` guards. |
| `src/components/mobile/MobileReviewDetailView.tsx` | Trip Details card: "Destination" and "Purpose" labels + visibility guards applied. |

### Test fix

Three mobile test files gained a `vi.mock("@/hooks/useOrganizationExpenseFormConfig", ...)` block returning stub helpers (`getFieldLabel: key => key`, `isVisibleOnReview: () => true`, `isVisibleOnDetail: () => true`). This replaces the need for a `QueryClientProvider` wrapper in tests. Files fixed: `MobileAdminPhase6A.test.tsx`, `MobileReview.test.tsx`, `mobileFinalStabilisation.test.tsx`.

### Test count: 933/933 pass

## Pass 12 — Batch review UX hardening (2026-07-15)

**Branch:** `feature/user-activity-insights`

Two components improved for loading/error resilience and field layout.

### Changes

| Component | Before | After |
|-----------|--------|-------|
| `BatchExpenseDetailCard` | `Loader2` + `animate-spin` spinner | `AsyncOperationProgress` with `status="running"` |
| `BatchExpenseDetailCard` | No error handling | Error state via `AsyncOperationProgress status="error"` + Retry button |
| `BatchExpenseDetailCard` | No stale-response guard | `seqRef = useRef(0)` + `seq !== seqRef.current` guard on each fetch |
| `ExpenseFormFieldsDisplay` | `grid grid-cols-1 sm:grid-cols-2` | `flex flex-nowrap` + `overflow-x-auto` horizontal scroll |
| `ExpenseFormFieldsDisplay` | Loading: `Loader2` spinner | `AsyncOperationProgress status="running"` |
| `ExpenseFormFieldsDisplay` | Error: plain `Alert` + `RefreshCw` | `AsyncOperationProgress status="error"` + `onRetry` |

### New i18n keys (EN/HI/GU, namespace `expenses`)

```
fieldDisplay.loading
fieldDisplay.loadingDescription
fieldDisplay.loadFailed
fieldDisplay.loadFailedDescription
batchReview.loadingDetails
batchReview.loadingDetailsDescription
batchReview.loadDetailsFailed
batchReview.loadDetailsFailedDescription
```

### Tests added (43 total passing)

| File | Tests | Coverage |
|------|-------|----------|
| `src/components/__tests__/ExpenseFormFieldsDisplay.test.tsx` | T-EFF-01–17 (17) | AsyncOperationProgress render, flex-nowrap layout, overflow-x-auto, dt/dd structure, field order, checkbox Yes/No, error/retry |
| `src/lib/__tests__/localesFieldDisplayKeys.test.ts` | T-LOC-31–33 (8) | EN/HI/GU locale key presence + HI/GU not English copies |
| `src/lib/__tests__/baseFieldConfigParity.test.ts` | T23–T25, T33 (4) | Pure logic: resolver chain label preservation, field_key immutability |
| `src/components/__tests__/batchReviewConfigParity.test.tsx` | T26–T32 (14) | Structural source-code checks: label props declared + wired in BatchExpenseDetailCard and MobileBatchLineDetail |

### Vitest config change

`vitest.config.ts`: switched `pool` to `'forks'` with `execArgv: ['--max-old-space-size=8192']` to prevent worker OOM on Windows when running component test suites.
