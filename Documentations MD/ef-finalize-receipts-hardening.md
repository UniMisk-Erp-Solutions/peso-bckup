# DOC-018 — Edge Function hardening: finalize-expense-receipts 500 fix + Admin/Accountant sticky Actions

**Status:** in progress
**Last updated:** 2026-06-30
**Area:** Expense submission — Edge Function reliability; Review table usability

---

## Summary

Phase 3 of the receipt finalization work. Phase 2 (DOC-017) created the
`finalize-expense-receipts` Edge Function but it was returning HTTP 500 in
production because:

1. Env vars loaded with non-null assertion `!` (no null check) — if either
   `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is missing, `createClient`
   throws a `TypeError` before the handler body runs.
2. No global `try/catch` — any unhandled exception produced a raw 500 with no
   JSON body, making the browser see `functions.invoke` error and fall back to
   `"temporary_fallback"` for every receipt.

Additionally, the browser-side `invokeFinalizeExpenseReceipts` did not
distinguish structured EF errors (`ok: false, stage, code`) from network
failures — both logged the same generic warning, making it hard to diagnose
production failures.

Finally, the sticky Actions column was missing from the Admin panel
(`AdminPanel.tsx` at `/admin/expenses`) and the Accountant approved-expenses
view (`AccountantApprovedExpenses.tsx`).

---

## Root cause details

### EF 500 — confirmed in `supabase/functions/finalize-expense-receipts/index.ts`

**Before (Phase 2):**
```typescript
// ← no null check; if var is absent, throws before handler body
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const serviceClient = createClient(...); // ← outside try/catch
// ← no global try/catch at all
```

This differed from `compress-upload` which wraps everything in
`try { } catch(e)` and explicitly null-checks env vars.

---

## Fixes

### A. `supabase/functions/finalize-expense-receipts/index.ts` — complete hardening

**New constants:**
```typescript
const VERSION = "receipt-finalizer-v2";
type ReceiptFinalizationStage =
  | "environment" | "method" | "auth" | "input" | "ownership" | "finalization";
```

**Per-request `requestId`:** generated with `crypto.randomUUID()` at the very
start of each handler invocation.

**Env var null check → 503:**
```typescript
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) {
  return errResponse(requestId, origin, 503, "environment",
    "SERVER_MISCONFIGURATION", "Missing required environment variables");
}
```

**Global `try { } catch (e: unknown)` wrapping all handler logic →** returns
`500 / stage:"finalization" / code:"INTERNAL_ERROR"` instead of a raw crash.

**All responses now include `{ ok, requestId, version: "receipt-finalizer-v2" }`:**
- Success: `{ ok: true,  requestId, version, results: [...] }`
- Error:   `{ ok: false, requestId, version, stage, code, message }`

**No stack traces, no env var values, no secrets in any response body.**

**Console logs** include `requestId` for correlation with Coolify EF logs.

**Status codes:**

| Stage | Code | HTTP |
|-------|------|------|
| environment | SERVER_MISCONFIGURATION | 503 |
| method | METHOD_NOT_ALLOWED | 405 |
| auth | MISSING_AUTH_HEADER | 401 |
| auth | INVALID_JWT | 401 |
| input | INVALID_JSON | 400 |
| input | MISSING_EXPENSE_ID | 422 |
| input | INVALID_RECEIPTS | 422 |
| ownership | EXPENSE_ACCESS_DENIED | 403 |
| finalization | INTERNAL_ERROR | 500 |

---

### B. `src/lib/receiptFinalization.ts` — structured error parsing

`invokeFinalizeExpenseReceipts` now detects structured EF errors (`data?.ok === false`)
separately from network failures:

```typescript
if (error || !data || data.ok === false || !data.results) {
  if (data?.ok === false) {
    console.warn("[...] edge function returned structured error", {
      expenseId,
      requestId: data.requestId,  // correlate with EF logs
      stage: data.stage,
      code: data.code,
    });
  } else {
    console.warn("[...] edge function unavailable", { expenseId, error: ... });
  }
  // synthetic fallback unchanged
}
```

Safe log: only `{ requestId, stage, code }` logged — no tokens, blobs, or secrets.

---

### C. Sticky Actions column — AdminPanel.tsx (`/admin/expenses`)

| Location | Before | After |
|----------|--------|-------|
| Wrapper `<div>` | `overflow-x-auto -mx-4 sm:mx-0` | `relative overflow-x-auto -mx-4 sm:mx-0` |
| Actions `<TableHead>` | `text-right font-semibold min-w-[120px]` | `sticky right-0 z-30 min-w-[120px] border-l bg-background shadow-[-4px_0_8px_-6px_rgba(0,0,0,0.25)] text-right font-semibold` |
| `<TableRow>` | (no class) | `className="group"` |
| Actions `<TableCell>` | `text-right` | `sticky right-0 z-20 min-w-[120px] border-l bg-background group-hover:bg-muted/50 text-right` |

---

### D. Sticky Actions column — AccountantApprovedExpenses.tsx

| Location | Before | After |
|----------|--------|-------|
| Wrapper `<div>` | `overflow-x-auto -mx-4 sm:mx-0` | `relative overflow-x-auto -mx-4 sm:mx-0` |
| Actions `<TableHead>` | `text-right font-semibold min-w-[100px]` | `sticky right-0 z-30 min-w-[100px] border-l bg-background shadow-[-4px_0_8px_-6px_rgba(0,0,0,0.25)] text-right font-semibold` |
| `<TableRow>` | (no class) | `className="group"` |
| Actions `<TableCell>` | `text-right` | `sticky right-0 z-20 min-w-[100px] border-l bg-background group-hover:bg-muted/50 text-right` |

---

### E. Missing i18n keys — `src/locales/*/expenses.json`

Added under `form` in all three locales (en / hi / gu):

| Key | en value |
|-----|----------|
| `submitSuccess` | `"Expense submitted successfully."` |
| `receiptsTempFallback` | `"Expense submitted. Some receipts are temporarily stored and will be finalized later."` |

---

## Invariants preserved

- No `storage.move` / `copy` / `createSignedUrl` / `download` from browser
- Service-role key never leaves the Edge Function
- Temp-path fallback from DOC-013 remains: if EF fails and blob cached → `"temporary_fallback"`
- No unique index on `(expense_id, storage_path)`
- No Storage RLS changes; no receipts bucket visibility change
- No production SQL, no migration repair
- No approvals, workflow status, or Settings changes

---

## Deployment

No new database migrations. Edge Function changes require the standard Coolify
EF deploy (see `docs/coolify-edge-functions-deploy.md`, DOC-L12).

After deploy, monitor EF logs in Coolify for `[finalize-receipts]` log lines
with `requestId`. Production receipts should show `status: "finalized"` in
the browser console instead of falling back.

---

## Test coverage

### `src/lib/__tests__/efStructuredResponseParsing.test.ts` — 15 tests (Phase 3 new)

| # | Test |
|---|------|
| 1 | ok:true — results extracted correctly |
| 2 | ok:true — cachedBlob enriched |
| 3 | ok:true — version field doesn't break extraction |
| 4 | ok:false stage=environment + blob → temporary_fallback |
| 5 | ok:false stage=environment + no blob → failed |
| 6 | ok:false stage=auth + blob → temporary_fallback |
| 7 | ok:false stage=auth + no blob → failed, null resolvedPath |
| 8 | ok:false stage=input + blob → temporary_fallback at temp path |
| 9 | ok:false stage=ownership + blob → temporary_fallback |
| 10 | ok:false — logs requestId/stage/code (no secrets) |
| 11 | ok:true mixed statuses — all 3 mapped correctly |
| 12 | ok:true counts: 1 finalized + 1 fallback + 1 failed |
| 13 | ok:true batch (no blobCache) — cachedBlob undefined |
| 14 | ok:false + no blobCache → all receipts failed |
| 15 | ok:false finalization stage + blob → temporary_fallback |

### `src/lib/__tests__/i18nExpensesKeys.test.ts` — 6 tests (Phase 3 new)

Verifies `submitSuccess` and `receiptsTempFallback` exist and are non-empty strings
in all three locales (en, hi, gu) — 1 test per key × 3 locales.

### `src/lib/__tests__/reviewTableStickyClasses.test.ts` — 16 tests total (Phase 3: +10)

- EngineerReview: 3 tests (Phase 2, unchanged)
- BatchExpenseReviewPanel: 3 tests (Phase 2, unchanged)
- AdminPanel: 8 tests (Phase 3 new)
- AccountantApprovedExpenses: 4 tests (Phase 3 new)

---

## Revision log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-30 | Initial: EF hardened (env check, try/catch, requestId, structured responses), frontend parses structured errors, sticky tables on AdminPanel + AccountantApprovedExpenses, i18n keys added, 21 new tests | Agent |
