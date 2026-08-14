# Batch Review query storm, Additional Information UUID leak, and timeline raw i18n key

**Doc ID:** DOC-093
**Status:** deployed
**Last updated:** 2026-08-13
**Owner / area:** Review Expenses (Batch Review, Additional Information, review timeline)

---

## 1) Summary

Three related fixes shipped as a single hotfix commit (`dd259849f2385dbdc556c9a2af61cbc5ff05f3a0`) on `hotfix/review-load-and-custom-field-display-20260813`, then merged to `main`: (1) `fetchBatchExpenseCustomFields` no longer fires one unchunked `expense_form_field_values` query per Batch Review load — it is now chunked, sequential, single-flight per `organizationId+batchId`, abortable, and surfaces failures instead of silently returning empty data; (2) Additional Information no longer renders a raw internal UUID as a field label, and no longer duplicates a field already shown under its real name; (3) the review timeline no longer renders a raw `review.timeline.actions.*` i18n key literally when the action has no translation.

---

## 2) Problem / requirement

**Production incident (2026-08-13, 04:19–05:02 UTC):** `fetchBatchExpenseCustomFields` fired one unchunked `expense_form_field_values` query per Batch Review load. A retrying client generated 1,378 requests (335 HTTP 500 / 1,043 HTTP 504) in 43 minutes, pinning Postgres CPU and degrading Search/Approve for other reviewers sharing the same database.

**Additional Information bug (owner-reported screenshot):** each field's correct label showed once, then the same value again keyed by a raw internal UUID. Root cause: `get_debug_review_expense_detail_v1` falls back `field_key` to the template/branch's own `id` when unconfigured; `ReviewExpenseDetail.tsx` used that as a `prefetchedFields` map key; the shared formatter `fetchExpenseFormFieldDisplay.ts` rendered any map key directly as a label with no validation, and its RPC/client-row merge dropped `stableId`, so identity-based dedup couldn't catch the duplicate either.

**Timeline bug:** `review.timeline.actions.expense_updated` rendered literally instead of "Expense updated" — the i18n instance's `returnEmptyString: false` means `t(key, {defaultValue: ""})` returns the raw key (not `""`) for a missing key.

---

## 3) Solution

- `CUSTOM_FIELD_FETCH_CHUNK_SIZE = 10` (proven safe via live `EXPLAIN ANALYZE` on Production, ~25ms for 10 ids under normal load). `BatchCustomFieldResult` is now a discriminated union (`status: "ok" | "error" | "aborted"`). Chunks fetch strictly sequentially (never `Promise.all`), check `signal?.aborted` before/after each chunk, and return `{status: "error"}` on the first failed chunk rather than continuing to hammer the DB or returning partial success as complete. Single-flight via a module-level `Map<string, Promise<BatchCustomFieldResult>>` keyed by `${organizationId}:${batchId}`.
- `BatchExpenseReviewPanel.tsx` aborts the previous in-flight fetch before starting a new one (`AbortController` per batch load, cleaned up on unmount), and handles all three result states — `aborted` (no-op), `error` (destructive toast + empty columns), `ok` (render).
- `fetchExpenseFormFieldDisplay.ts`: new `isUuidLikeLabel()` guard drops any prefetched field whose label/key is UUID-shaped (never applied to field *values*, only the label/key position); `mergeDisplayRows()` now preserves `stableId`/`templateId`/`branchId`/`parentTemplateId`/`parentBranchId`/`fieldKey` through merges (previously dropped, breaking identity-based dedup); a name-collision filter drops prefetched rows that duplicate an already-known field by name.
- `ReviewExpenseDetail.tsx`: `prefetchedFields` key changed from `f.label ?? f.field_key` to `f.label ?? (isUuidLikeLabel(f.field_key) ? null : f.field_key)`.
- `ExpenseReviewTimeline.tsx`: `formatAction()` switched from `t(key, {defaultValue: ""})` to `i18n.exists(key) ? t(key) : <fallback>`.

---

## 4) Key files

```
src/components/BatchExpenseReviewPanel.tsx
src/components/ExpenseReviewTimeline.tsx
src/components/__tests__/ExpenseReviewTimelineI18nKeyLeak.test.tsx
src/features/reviewExpensesServer/ReviewExpenseDetail.tsx
src/lib/__tests__/batchExpenseReviewCustomFieldsChunking.test.ts
src/lib/__tests__/fetchExpenseFormFieldDisplayUuidLeak.test.ts
src/lib/batchExpenseReview.ts
src/lib/fetchExpenseFormFieldDisplay.ts
src/locales/en/admin.json
src/locales/en/expenses.json
src/locales/gu/expenses.json
src/locales/hi/expenses.json
```

12 files, 688 insertions / 78 deletions. No SQL migration, no dependency/config change.

---

## 5) Database / migrations

None. This is a frontend/query-shape fix only.

---

## 6) Test plan

- [x] 13 new tests — chunking/dedup, error surfacing (no auto-retry, stops at first failed chunk), abort/single-flight behavior (`batchExpenseReviewCustomFieldsChunking.test.ts`)
- [x] 7 new tests — UUID-label suppression, no duplication, legitimate UUID-shaped *values* preserved (`fetchExpenseFormFieldDisplayUuidLeak.test.ts`)
- [x] 3 new tests — missing i18n key renders fallback text, known key still translates, no raw `review.timeline.actions.*` literal (`ExpenseReviewTimelineI18nKeyLeak.test.tsx`)
- [x] Full suite: 3051/3051 passing on the exact release SHA
- [x] `tsc --noEmit`, production build, migrations check, secrets scan — all clean
- [x] Lint on the 12 touched files: 2 pre-existing warnings, byte-identical to `main`'s pre-hotfix versions — zero new issues
- [x] Cherry-picked onto `debug/6456-supervisor-auth-runtime` and load-tested at Production scale: 200 → 600 → 1,200 synthetic expenses, staged rollout, zero errors; live network inspection proved exact chunking (80-expense batch → 8×10-id requests, zero overlap; 225-expense batch → 22×10 + 1×5, zero overlap)
- [x] Read-only SSH Production audit before merge: 353/355 recent `57014` statement-timeout errors fall exactly within the documented 04:19–05:02 incident window; 2 isolated post-window stragglers consistent with the still-unpatched bug, not a new issue
- [x] Read-only frontend QA on real Mistry & Shah production data (pre- and post-merge): Additional Information renders cleanly on a real expense with a non-default custom field value, review timeline shows no raw i18n keys
- [x] Post-merge: deployed bundle (`assets/index-94Zoz0lG.js` on `pesowise.unimisk.com`) confirmed to contain the new `customFieldsLoadFailed` i18n string, proving the fix is live; server/DB health and console/network clean after deploy

---

## 7) Related docs

- [Supervisor hierarchy runtime fixes](./supervisor-hierarchy-runtime-fixes-2026-08-12.md) (DOC-091) — same debug branch used as the QA/load-test environment for this hotfix (cherry-picked on top), not itself the release source
- [MicroLink 6546 Level 2 routing & audit repair](./6546-level2-routing-audit-repair-2026-08-12.md) (DOC-092)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-13 | 1.0 | Agent | Hotfix implemented, tested, and load-tested at Production scale (1,200 synthetic expenses) on a debug branch. |
| 2026-08-13 | 1.1 | Agent | Full release-gate audit re-run against the exact release SHA on `hotfix/review-load-and-custom-field-display-20260813` (independent of the debug-branch QA): tests/build/lint/typecheck/migrations/secrets clean, read-only Production SSH + frontend QA clean. Merged to `main` (`9b7d1ac235841feca1799d374e0e874900d91b8a`). Vercel auto-deploy to `pesowise.unimisk.com` confirmed READY and serving the new bundle; post-merge smoke test clean, no new errors. |
