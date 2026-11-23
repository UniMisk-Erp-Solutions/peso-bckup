# Controlled real-Tally gate — accounting voucher (not metadata)

**Status:** **AUTOMATED PASS** (mapper/registry). **REAL TALLY NOT RUN** (by design until synthetic expense exists).

Metadata ledger CREATE/SKIP/ALTER on `PW-META-*` does **not** validate **PesoWise Expense** vouchers.

---

## Canonical identity

```
{organization_id}:acct:expense:{expense_id}
```

**Dedupe rule (automated):** One expense appearing in Claim Verification, Claim Approval, and Detailed Expense → **one** voucher command per mapping run (`AccountingRegistry.planExpenseVoucher`). Daily Project aggregate rows → **zero** vouchers.

See `tallyMappingMetadataLedger.test.ts` — *cross-report dedupe* and *daily project emits metadata only*.

---

## Proposed controlled test (manual / future script)

Use a **dedicated synthetic expense** in **PesoWise Integration Test** company only:

| Field | Example |
|-------|---------|
| `organization_id` | Test org UUID (not production) |
| `expense_id` | Fixed UUID documented in runbook |
| `total_amount` | Small positive (e.g. ₹1.00) with real category + employee masters |
| `status` | `verified` (verification path) |
| `purpose` | `PHASE53-ACCT-VOUCHER-CONTROLLED` |

**Expected mapper output:**

- One **PesoWise Expense** voucher, Create
- Debit category ledger, credit employee ledger (legitimate amounts)
- Separate **PW-META-*** ledger for report metadata (if synced from a report job)
- **No** fake balancing lines for metadata

**Real Tally gate:** Single HTTP, 15s timeout, expect voucher + masters responses parsed like metadata (CREATED/ALTERED, EXCEPTIONS=0). **Do not** run bulk report import until this passes once.

---

## XML inspection (automated, no Tally)

Run unit tests:

```text
npm.cmd run test -- --run tallyMapping
```

Voucher XML must not contain metadata UDF blocks; metadata XML must not contain `VOUCHER` entries with amount lines for PW-META ledgers.
