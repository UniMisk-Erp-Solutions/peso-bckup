# Expense Amount Wheel-Input Fix

**Doc ID:** DOC-070  
**Status:** complete  
**Last updated:** 2026-07-27  
**Owner / area:** ExpenseForm, BaseExpenseFieldInput, BatchExpenseReviewPanel, mobile correction/balance  

---

## 1) Summary

Production hotfix applied directly to `main` on 2026-07-27.

**Root cause:** Native `<input type="number">` elements increment or decrement their value when the user scrolls a mouse wheel or trackpad while the field is focused. On the New Expense / Edit Expense form, entering an amount such as `41.58` and then scrolling downward toward Bill Photos silently changed the amount to `41.59` or `41.57` before the field blurred, corrupting the expense value.

**Fix:** A single reusable helper, `blurFocusedNumberInputOnWheel`, blurs the focused number input during the wheel capture phase. Blur removes the focused state before the browser can step the value; the wheel event continues propagating normally so the page still scrolls. No `preventDefault`, no `stopPropagation`, no global listeners.

---

## 2) Problem / requirement

### Reported workflow

1. Open New Expense.
2. Enter `41.58` in the Amount field.
3. Leave Amount focused.
4. Scroll downward (mouse wheel or trackpad) toward Bill Photos.
5. **Bug:** Chrome steps the value to `41.59` or `41.57` before the field blurs.

### Root cause detail

`<input type="number">` in Chrome (and other browsers) responds to wheel events while focused by incrementing or decrementing the value by `step` (here `0.01`). There was no wheel guard on:

| File | Control | Risk |
|---|---|---|
| `src/pages/ExpenseForm.tsx:2113` | Default Amount `<Input type="number">` | Primary — all expense submissions |
| `src/components/BaseExpenseFieldInput.tsx:63` | Configurable number override | When org sets `input_type = "number"` |
| `src/components/BatchExpenseReviewPanel.tsx:923` | Correction amount | Financial correction data |
| `src/components/mobile/MobileCorrectionFields.tsx:91` | Mobile correction amount | Financial correction data |
| `src/components/mobile/MobileBatchLineDetail.tsx:182` | Mobile batch correction | Financial correction data |
| `src/components/mobile/MobileBalancesView.tsx:262` | Balance add amount (admin) | Financial balance data |

Note: `ExpenseBatchForm` batch line amounts already used `<NumberInput>` (the existing component with an `onWheel` blur guard) and were not affected.

---

## 3) Solution

### Helper — `src/lib/numberInputWheel.ts` (new)

```ts
export function blurFocusedNumberInputOnWheel(
  event: WheelEvent<HTMLInputElement>,
): void {
  const input = event.currentTarget;
  if (document.activeElement === input) {
    input.blur();
  }
}
```

**Why blur and not preventDefault:**  
`preventDefault` on a wheel event blocks page scrolling — the exact opposite of the desired behavior. Blurring the focused input removes the precondition the browser uses to step the value. The wheel event is untouched and continues through the DOM, so the page scrolls normally.

**Why `onWheelCapture` not `onWheel`:**  
The capture phase fires before the bubble phase, so the field loses focus as early as possible in the event path, leaving the least opportunity for the browser to act on the focused state.

**Why check `document.activeElement`:**  
Defensive guard: only blur when this specific input is the active element. A single handler can be placed on a parent without accidentally blurring sibling inputs.

### Changes per file

| File | Change |
|---|---|
| `src/lib/numberInputWheel.ts` | **New** — exports `blurFocusedNumberInputOnWheel` |
| `src/pages/ExpenseForm.tsx` | Added import + `onWheelCapture` + `inputMode="decimal"` to Amount `<Input>` |
| `src/components/BaseExpenseFieldInput.tsx` | Added import + `onWheelCapture` + `inputMode="decimal"` to number control |
| `src/components/BatchExpenseReviewPanel.tsx` | Added import + `onWheelCapture` + `inputMode="decimal"` to correction amount |
| `src/components/mobile/MobileCorrectionFields.tsx` | Added import + `onWheelCapture` + `inputMode="decimal"` to mobile correction amount |
| `src/components/mobile/MobileBatchLineDetail.tsx` | Added import + `onWheelCapture` + `inputMode="decimal"` to mobile batch correction |
| `src/components/mobile/MobileBalancesView.tsx` | Added import + `onWheelCapture` + `inputMode="decimal"` to balance add amount |
| `src/lib/__tests__/numberInputWheel.test.tsx` | **New** — 20 tests |

### What was NOT changed

- `src/pages/Dashboard.tsx` — untouched (not in scope for this hotfix)
- `src/pages/ExpenseBatchForm.tsx` — already uses `<NumberInput>` ✓
- `src/components/NumberInput.tsx` — existing component untouched (still uses `onWheel`)
- Any maintenance, review, CSV, receipt, category, or RLS logic
- The `fix/dashboard-health-and-user-feedback` branch — untouched

---

## 4) Browser manual test

**Test case (exact reported workflow):**

| Step | Action | Expected |
|---|---|---|
| 1 | Open New Expense | Form renders |
| 2 | Type `41.58` in Amount | Shows `41.58` |
| 3 | Keep Amount focused, scroll down | Amount stays `41.58`; page scrolls; field blurs |
| 4 | Repeat scrolling up, fast, slow | Amount unchanged |
| 5 | Type `123.45`, press Tab | `123.45` confirmed after Tab |
| 6 | Open Edit Expense | Saved amount loads correctly |

**Browsers:** Chrome, Edge, Firefox desktop + mobile touch (no change in touch behavior).

---

## 5) Key files

```
src/lib/numberInputWheel.ts                              (new — wheel guard helper)
src/lib/__tests__/numberInputWheel.test.tsx              (new — 20 tests)
src/pages/ExpenseForm.tsx                                (modified — Amount input)
src/components/BaseExpenseFieldInput.tsx                 (modified — number control)
src/components/BatchExpenseReviewPanel.tsx               (modified — correction amount)
src/components/mobile/MobileCorrectionFields.tsx         (modified — mobile correction)
src/components/mobile/MobileBatchLineDetail.tsx          (modified — mobile batch correction)
src/components/mobile/MobileBalancesView.tsx             (modified — balance add)
```

---

## 6) Tests

20 new tests — all passing (1 408 total, zero regressions):

| Group | Count | What they cover |
|---|---|---|
| Unit — handler behavior | 6 | blurs focused, ignores unfocused, no value change, no preventDefault, no stopPropagation, uses currentTarget |
| React integration | 4 | handler attachment on number controls; text/dropdown not affected |
| Amount value acceptance | 5 | accepts 41.58, 0.01; min=0 attribute; onChange state update; value unchanged after wheel |
| Attachment + edit mode | 2 | attachment threshold logic; parseFloat decimal preservation |
| Regression | 3 | no health-module imports, CSV still importable, named export only |

---

## 7) Database / migrations

None. Pure frontend change — no SQL, no migrations, no RLS changes.

---

## 8) Related docs

- [DOC-004 — Customizable base field inputs](./base-field-input-customization.md) (BaseExpenseFieldInput context)
- [DOC-069 — Admin Expense CSV Export Fix](./admin-expense-csv-fix.md) (previous hotfix)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-07-27 | 1.0 | Mithil Mistry | Initial — production hotfix; 6 money inputs fixed; 20 tests; 1 408 total; no SQL |
