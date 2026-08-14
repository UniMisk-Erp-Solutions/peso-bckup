# DOC-052 — Transfer Offer Login Popup

**Status:** complete  
**Branch:** `feature/transfer-offer-login-popup`  
**Date:** 2026-07-14  
**Author:** Agent

---

## Purpose

When an admin or cashier sends a balance transfer request to a recipient, the recipient now sees a **blocking modal popup immediately on login (or on next app open)** that lets them accept or reject the transfer from the popup itself — without having to navigate to `/transfer-offers`.

Previously the only way to action a pending transfer was to visit the Transfer Offers page directly or see a toast notification that auto-dismissed after 5 s.

---

## Feature Flag

| Flag key | Default | Controlled by |
|---|---|---|
| `transfer_recipient_acceptance` | **off** | PesoWise master admin (per-org) |

The gate renders `null` and makes **zero network calls** when this flag is disabled.

---

## Existing Transfer System (unchanged)

| Layer | Location | What it does |
|---|---|---|
| Proposal | `Balances.tsx` | Admin/cashier creates offer via `propose_balance_transfer_offer` RPC |
| Service | `BalanceTransferOfferService.ts` | `proposeOffer`, `acceptOffer`, `rejectOffer`, `cancelOffer`, `fetchPendingForRecipient`, `countPendingForRecipient`, `fetchHistoryForUser` |
| Page | `TransferOffers.tsx` + `MobileTransferOffersView.tsx` | Shows pending + history; accept/reject from cards |
| Actions | `TransferOfferActions.tsx` | Reusable accept/reject buttons (used by the page) |
| Notifications | `NotificationService.ts` | Creates `transfer_offer_received` / `_accepted` / `_rejected` / `_cancelled` rows |
| Translation | `translateNotification.ts` | Already handled all four transfer notification types |

No SQL was changed. No new RPCs were created. No existing tables were modified.

---

## New Component: `TransferOfferPromptGate`

**File:** `src/components/TransferOfferPromptGate.tsx`

### Render conditions

The gate renders `null` (no query, no subscription) when **any** of the following are true:

- `transfer_recipient_acceptance` feature flag is **disabled**
- No user is authenticated (`user === null`)
- `userRole === "master_admin"`
- `isAccountantCashier === true`

### On mount / user change

1. Calls `BalanceTransferOfferService.fetchPendingForRecipient(user.id)`.
2. Builds a local queue of pending offers.
3. Displays the first offer in a shadcn `<Dialog>` that **cannot be dismissed by clicking outside or pressing Escape** — the user must act or click "Review later".

### Queue behaviour

- Multiple pending offers are shown one by one.
- After accepting or rejecting one, the next offer surfaces automatically.
- After all offers are actioned or dismissed the dialog closes.
- "Review later" clears the local queue and navigates to `/transfer-offers`.

### Data freshness

| Trigger | Behaviour |
|---|---|
| Mount | Initial `fetchPendingForRecipient` |
| Window focus | Refetch |
| `visibilitychange → visible` | Refetch |
| 60 s interval | Refetch (only while feature enabled) |
| Supabase realtime INSERT on `balance_transfer_offers` where `recipient_id = user.id` | Refetch |
| Supabase realtime UPDATE on `balance_transfer_offers` | Refetch (handles cancellations from other tabs) |

The realtime channel is named `transfer-offer-gate-{userId}` and is cleaned up on unmount.

### Accept flow

1. Calls `BalanceTransferOfferService.acceptOffer(offerId, …)`.
2. Shows toast: _"Transfer accepted — Your balance has been updated by ₹X."_
3. Calls `refreshBalance()` from `useAuth` to update the header balance display immediately.
4. Removes the offer from the local queue.
5. Refetches to pick up any remaining pending offers.

### Reject flow

1. On "Reject" click: shows a text-area step (inside the same dialog).
2. Validates reason via `validateTransferRejectionReason` (≥ 3 chars after trim).
3. Calls `BalanceTransferOfferService.rejectOffer(offerId, reason, …)`.
4. Shows toast: _"Transfer rejected."_
5. Removes offer from queue, refetches.

### Error handling

- Any RPC/service error shows a destructive toast.
- The current offer stays visible (the user can retry or click "Review later").
- A refetch runs after every error to sync state.

### Dialog content

```
Transfer request           [X close → Review later]
─────────────────────────────────────
        ₹1,000.00          ← amber highlight box
─────────────────────────────────────
From           Ravi Kumar
Payment mode   Cash
Proposed at    Jul 14, 9:30 AM
Note           Monthly advance
─────────────────────────────────────
[Reject]   [Review later →]   [Accept transfer]
```

On mobile (`max-w-sm`, `w-[calc(100vw-2rem)]`) buttons wrap vertically to prevent overflow.

---

## Mount Point: `Layout.tsx`

`<TransferOfferPromptGate />` is mounted in **both** layout branches:

1. **Mobile path** — after `<MobileAppShell>`, before the notification popup stack.
2. **Desktop path** — before the notification popup stack (`fixed bottom-4 right-4`).

The gate is inside the authenticated layout (`Layout`) so it only runs for logged-in users and never on public marketing pages.

---

## NotificationPopup & useNotificationManager Updates

### Type widening

Both `useNotificationManager.ts` (local `Notification` interface) and `NotificationPopup.tsx` (`NotificationPopupProps.type`) now include:

```ts
| "transfer_offer_received"
| "transfer_offer_accepted"
| "transfer_offer_rejected"
| "transfer_offer_cancelled"
```

This eliminates TypeScript errors when the notifications table returns these types via realtime.

### Icon / background colour mapping

| Type | Icon | Background |
|---|---|---|
| `transfer_offer_received` | Coins (amber) | amber-50 / amber-200 |
| `transfer_offer_accepted` | Coins (green) | green-50 / green-200 |
| `transfer_offer_rejected` | XCircle (red) | red-50 / red-200 |
| `transfer_offer_cancelled` | Bell (slate) | slate-50 / slate-200 |

### Click routing in `NotificationPopup`

```
type.startsWith("transfer_offer") → /transfer-offers
expense_id exists                 → /expenses/:id
else                              → /notifications
```

### `handleViewNotification` signature change

`useNotificationManager.handleViewNotification` now accepts an optional second argument `type?: string` and applies the same routing logic. Layout.tsx passes `notification.type` at call sites.

---

## TransferOffers Page — UX Hint

Both `TransferOffers.tsx` (desktop) and `MobileTransferOffersView.tsx` (mobile) now show a small hint below the page description:

> _"Pending transfer requests also appear as a popup when you log in or open the app."_

Translated via i18n key `transfers:promptGate.pageHint` with an English fallback.

---

## SQL Status

**SQL changed: No.**

Uses existing:
- `balance_transfer_offers` table
- `propose_balance_transfer_offer` RPC
- `accept_balance_transfer_offer` RPC
- `reject_balance_transfer_offer` RPC
- Existing RLS policies

---

## Files Changed

| File | Type | Change |
|---|---|---|
| `src/components/TransferOfferPromptGate.tsx` | **NEW** | Global modal gate component |
| `src/components/Layout.tsx` | Modified | Import + mount `TransferOfferPromptGate` in both mobile/desktop paths; pass `notification.type` to `handleViewNotification` |
| `src/hooks/useNotificationManager.ts` | Modified | Widen `Notification.type` union; update `handleViewNotification` signature + routing |
| `src/components/NotificationPopup.tsx` | Modified | Widen `type` prop union; add transfer icon/color cases; fix click routing |
| `src/pages/TransferOffers.tsx` | Modified | Add popup hint text |
| `src/components/mobile/MobileTransferOffersView.tsx` | Modified | Add popup hint text |
| `src/components/__tests__/TransferOfferPromptGate.test.tsx` | **NEW** | Unit tests (guard logic, queue management, validation) |
| `Documentations MD/transfer-offer-login-popup.md` | **NEW** | This document |
| `Documentations MD/index.md` | Modified | DOC-051 entry + revision log |

---

## Tests

**New test file:** `src/components/__tests__/TransferOfferPromptGate.test.tsx`

| # | Test | Coverage |
|---|---|---|
| 1–4 | `validateTransferRejectionReason` edge cases | Rejection reason gate |
| 5 | `transfer_recipient_acceptance` key exists in feature keys | Flag registration |
| 6–12 | `shouldRun` guard (feature off, no user, master_admin, accountant-cashier, admin, cashier) | Render guard |
| 13–16 | Queue merge logic (removes stale, appends fresh, no duplicates, empty result) | Queue management |

**Skipped UI tests:** Full render tests for `TransferOfferPromptGate` are skipped because the component requires live Supabase realtime, `react-router-dom`, i18n, and shadcn Dialog — mocking all of these for DOM tests is disproportionate. The guard and queue logic are extracted as pure functions and tested directly.

---

## Manual Testing Checklist

- [ ] Enable `transfer_recipient_acceptance` for test org (Master Admin → org features)
- [ ] Login as admin or cashier → navigate to Balances → send transfer to an employee
- [ ] Login (or refresh) as the recipient employee
  - [ ] Popup appears immediately with amount, sender name, payment mode, proposed date
  - [ ] Note is shown if present
  - [ ] "Accept transfer" button calls accept RPC and shows toast "Transfer accepted — ₹X"
  - [ ] Header balance updates without page reload
  - [ ] Sender receives "transfer_offer_accepted" notification
- [ ] Send another transfer request to same employee while they are already logged in
  - [ ] Popup surfaces within ~5 s (realtime) or 60 s (polling)
- [ ] Click "Reject" on popup → text area appears → cannot confirm with empty/short reason
  - [ ] Enter reason ≥ 3 chars → confirm → toast "Transfer rejected"
  - [ ] Sender receives "transfer_offer_rejected" notification
- [ ] Send two transfer requests → employee sees first → after action, second appears
- [ ] Click "Review later" (X button) → navigated to `/transfer-offers` — page shows pending offer
- [ ] `/transfer-offers` page shows hint text about popup
- [ ] Disable `transfer_recipient_acceptance` → no popup rendered, no DB queries fired
- [ ] Login as `master_admin` → no popup rendered
- [ ] Login as accountant-cashier → no popup rendered
- [ ] Mobile viewport: popup fits screen, buttons stack vertically, no horizontal overflow
- [ ] Notification bell: clicking a `transfer_offer_received` toast routes to `/transfer-offers`
- [ ] Toast for `transfer_offer_accepted` / `_rejected` / `_cancelled` shows correct icon and color

---

## Rollback Notes

All changes are pure frontend. To roll back:

1. `git revert <commit-hash>` or delete the branch.
2. No SQL to revert.
3. No new tables, RPCs, or edge functions were created.
4. Existing `TransferOfferActions`, `TransferOffers`, and `BalanceTransferOfferService` are **unmodified** — the page still works independently.

---

## Confirmation

- NO SQL RUN
- NO DEPLOY
- NO MAIN PUSH
- NO FORCE PUSH
