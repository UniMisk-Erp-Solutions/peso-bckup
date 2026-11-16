# Phase 4 — Tally data mapping & XML generation engine

**Status:** **PASS** (library + migration + tests; no Tally I/O)  
**Date:** 2026-10-06 (metadata persistence updated 2026-10-06 — see **PHASE-05-METADATA-LEDGER-ARCHITECTURE.md**)

| Gate | Status |
|------|--------|
| Metadata persistence (real Tally 7.1) | **PASS** — ledger + UDF |
| Production serializer (this repo) | **IMPLEMENTED** — automated tests **PASS** |
| Connector end-to-end delivery | **NOT YET VALIDATED** |

---

## 1. Objective

Convert Phase 3 **`prepared`** datasets (`tally_sync_job_items`) into deterministic, validated Tally-compatible **command models** and **Import XML envelopes**, with stable accounting identity, cross-report deduplication, report metadata for future TDL, CREATE/SKIP/UPDATE foundations, and batched output — **without** contacting TallyPrime.

## 2. Input from Phase 3

| Source | Shape |
|--------|--------|
| `tally_sync_job_items.payload` | Envelope: `organization_id`, `report_type`, ids + inner `payload`/`row` from RPC |
| `source_key` | `{org}:expense:{id}`, `{org}:balance_event:{event_id}`, `{org}:daily_row:{date\|user\|project}` |
| `content_hash` | SHA-256 of canonical row json (worker) |

Evidence: `supabase/functions/run-tally-sync-job/index.ts`, `src/lib/tallySync/normalize.ts`, Phase 1 audit.

## 3. Architecture

```
tally_sync_job_items (prepared)
        ↓
mapPreparedJobItems()  — src/lib/tallyMapping/pipeline.ts
        ↓
Per-item mapPreparedItem() + AccountingRegistry
        ↓
TallyCommand[] (masters | vouchers | report_metadata)
        ↓
sortCommands → serializeCommand → wrapEnvelope
        ↓
XmlBatch[] (default 50 messages / batch)
```

**Not in React.** Phase 3.6 UI unchanged. Worker **not** wired to XML yet (Phase 5 connector).

## 4. Mapping model

| Layer | Role |
|-------|------|
| `PreparedJobItem` | Phase 3 row |
| `TallyCommand` | Typed master / voucher / metadata |
| `PesowiseTallyMetadataV1` | Versioned JSON for TDL (embedded in XML UDF) |
| `tally_delivery_state` | Persistent CREATE/SKIP/UPDATE ledger (future ack) |

## 5. Accounting vs report metadata vs derived

| Class | Examples | Tally treatment |
|-------|----------|-----------------|
| **Accounting** | Expense amount; cash/bank transfers; allocations | At most **one expense voucher per** `{org}:acct:expense:{expense_id}`; balance events → `{org}:acct:balance_event:{event_id}` |
| **Report metadata** | CV/CA columns, workflow labels, custom fields, timeline balances | **Ledger** under group **`PesoWise Metadata`** + UDF **`PESOWISE_METADATA_JSON`** (index **25001**) — **not** a Journal voucher |
| **Derived report** | Daily aggregates, opening/closing on CV rows, percentages | Metadata only; **no** extra expense vouchers from `source_expenses` |

## 6. Tally masters (minimum)

| Master | Why | Stable key | Create/reuse |
|--------|-----|------------|--------------|
| Employee ledger | Party for expense credit side | `{org}:master:employee:{user_id}` | Reuse; name from profile + code suffix in display |
| Category ledger | Expense debit classification | `{org}:master:category:{slug(category)}` | Reuse; slug avoids duplicate ledgers for same label |
| Project cost centre | Daily / project context | `{org}:master:project:{project_id}` | Reuse |
| Voucher types | `PesoWise Expense`, `PesoWise Balance` | Fixed names | Created via XML ACTION |
| Metadata group | **`PesoWise Metadata`** | `{org}:master:group:pesowise_metadata` | CREATE under **Primary** when any metadata command is emitted |
| Metadata ledger | **`PW-META-{sha256(delivery_key)[0:12]}`** | `{org}:meta:{report_type}:{source_key}` | CREATE / ALTER; no opening balance |

Collision: all keys prefixed with `organization_id`.

## 7. Employee mapping

- **Stable id:** `user_id` (UUID), not display name.
- **Display:** `employee_id` / `employee_code` when present.
- **Ledger:** One employee ledger per `user_id`; renames change display only on ALTER.
- Same name / inactive: still unique by `user_id`.

## 8. Expense category mapping

- **Stable id:** slug of category text (`slugifyCategory`), not raw string alone.
- **Ledger name:** `PW-Cat {slug} — {category label}`.
- Prevents duplicate ledgers for punctuation/case variants.

## 9. Project mapping

- **Stable ids:** `project_id`, `user_id`, `track_date` in daily `source_key`.
- **Cost centre** for accounting context; **full row** (costs, %, `source_expenses`) in metadata JSON for TDL.

## 10. Voucher mapping

| Source | Voucher? |
|--------|----------|
| Claim Verification / Approval expense row | **One** `PesoWise Expense` per expense id |
| Detailed `expense_deduction` | Links metadata; voucher only if registry has not already emitted for that expense |
| Detailed transfers/credits/etc. | `PesoWise Balance` when `classifyTimelineEvent` → accounting |
| Daily row | **No** expense voucher |

## 11. Cross-report deduplication

**Canonical accounting key:** `{organization_id}:acct:expense:{expense_id}`.

Same expense in CV + CA + Detailed + Daily:

- **1** expense voucher (registry `planExpenseVoucher`)
- **4** report metadata records (keys include `report_type`: `{org}:meta:{report_type}:{source_key}`)

Daily references expense via `source_expenses[]` only in metadata.

## 12. Claim Verification mapping

| PesoWise (RPC row) | Metadata | Accounting |
|--------------------|----------|------------|
| `id`, `transaction_number`, `user_*`, `category`, amounts, dates, purpose, destination, `custom_fields`, `status` | Full `fields` + Manager/HO presentation labels | Shared expense voucher |
| HO Approval | Always `"Pending"` (Phase 1 rule) | — |

## 13. Claim Approval mapping

Same row shape; `status=approved`; HO `"Approved"`; Manager column `"Verified"`.  
Update path: same `acct:expense` key → **ALTER** when `content_hash` changes.

## 14. Detailed Expense mapping

| `event_type` | Voucher |
|--------------|---------|
| `expense_deduction` | Metadata + link to expense acct key; no duplicate expense voucher |
| Transfers, allocations, credits, … | Optional `PesoWise Balance` voucher |
| Historical/report-only types | Metadata / derived only |

Preserves `opening_balance`, `closing_balance`, `credit`, `debit` verbatim from RPC.

## 15. Daily Project mapping

Metadata-only **ledger** payload: `track_date`, project, location, costs, percent, remarks, `source_expenses`.  
**No** accounting vouchers from aggregated amounts.

## 16. Metadata persistence (future TDL)

**Rejected (real Tally 7.1):** Journal **`PesoWise Report Meta`** — cannot import/save zero-line metadata; fake ±₹1 lines pollute accounting and did not persist UDF reliably.

**Accepted:**

- **Group:** `PesoWise Metadata` (bootstrap `GROUP` master when metadata commands exist).
- **Master:** one **Ledger** per `reportMetadataDeliveryKey` — name `metadataLedgerName(delivery_key)` → `PW-META-{12 hex}`.
- **UDF:** `PESOWISE_METADATA_JSON` with `.LIST` wrapper, `INDEX="25001"`, `xmlns:UDF="TallyUDF"`.
- **Schema:** `PesowiseTallyMetadataV1` (`schema_version: 1`); includes **`metadata_delivery_key`** mirroring the delivery key.
- **Accounting link:** optional `accounting_key` inside JSON only — metadata ledgers are **never** voucher lines.

Evidence: **PHASE-05.1-REAL-TALLY-VALIDATION.md**, **PHASE-05-METADATA-LEDGER-ARCHITECTURE.md**.

## 17. Future TDL data contract

TDL will read `PESOWISE_METADATA_JSON` → parse `schema_version` → branch on `report_type` → render four reports offline.

Fields documented in `src/lib/tallyMapping/metadataSchema.ts`.

## 18. XML architecture

- `xml/escape.ts` — `& < > " '`
- `xml/serialize.ts` — masters (incl. group), vouchers, **`serializeMetadataLedger`**; `wrapEnvelope` Import Data
- Deterministic `sortCommands` before batching
- **No** string concat in UI/worker

## 19. XML example (synthetic)

See test fixtures `src/lib/tallyMapping/__fixtures__/synthetic.ts`; generated XML in `tallyMappingPhase4.test.ts` (Unicode + escaped `&` in purpose).

## 20. XML escaping / security

All user text through `escapeXmlText`; metadata JSON via `stableStringify` then escape. Prevents XML injection from names, remarks, custom fields.

## 21. XML batching

- Default **50** `TALLYMESSAGE` elements per envelope (`batch_size` option).
- Deterministic order: masters → vouchers → metadata.
- Zero-row jobs: empty envelope still well-formed.

## 22. Stable accounting identities

| Entity | Key |
|--------|-----|
| Expense | `{org}:acct:expense:{expense_id}` |
| Balance event | `{org}:acct:balance_event:{event_id}` |
| Report row meta | `{org}:meta:{report_type}:{source_key}` |

## 23. CREATE / SKIP / UPDATE

`decideDelivery(delivery_key, content_hash, state)`:

| State | Action |
|-------|--------|
| No prior hash | CREATE |
| Same hash | SKIP |
| Different hash | UPDATE → metadata **`LEDGER ACTION="Alter"`** (same `PW-META-…` name) |
| Peso soft-delete flag (future) | cancel_planned |

**Generating XML does not write delivery state** — only successful Tally ack in Phase 5+.

## 24. Delivery state schema

Migration `20261006120000_tally_delivery_state_phase4.sql`:

- `tally_delivery_state (organization_id, delivery_key)` PK
- `tally_org_connector_config` — future org ↔ device ↔ Tally company (not populated by sync UI)

## 25. Deletion / cancellation / reversal (design)

| Scenario | Future strategy |
|----------|-----------------|
| Never synced + soft-deleted in Peso | Excluded at Phase 3 boundary (unchanged) |
| Synced then deleted/rejected | `cancel_planned` on delivery row; Phase 5 emits metadata state + optional reversal voucher (document only in Phase 4) |
| Approval downgrade | UPDATE metadata + ALTER expense voucher / reversal per accounting review |

No destructive Tally actions implemented in Phase 4.

## 26. Organization isolation

Every key embeds `organization_id`. Same expense UUID in two orgs → distinct keys.

## 27. Future Tally company targeting

` tally_org_connector_config.tally_company_name` set at pairing time; XML leaves `<SVCURRENTCOMPANY>` placeholder for connector.

## 28. Tests

- `src/lib/__tests__/tallyMappingPhase4.test.ts`
- Fixtures: `src/lib/tallyMapping/__fixtures__/synthetic.ts`
- Cross-report E123 scenario; batching; SKIP; migration contract

## 29. Test results (2026-10-06)

| Suite | Result |
|-------|--------|
| All `vitest run tally` | **176 passed** (includes Phase 4 + **14** metadata-ledger + Phase 5 connector) |
| ESLint `src/lib/tallyMapping` | **PASS** |
| Full `tsc` | Not run (pre-existing failures elsewhere) |
| Full lint | Not run (pre-existing backlog) |
| `vite build` | **PASS** |

## 30. Known limitations

- Worker does not auto-run mapper post-`prepared` (Phase 5).
- Expense voucher uses simplified two-line journal (category debit / employee credit) — refine in connector phase.
- Tally UDF names require company support; TDL contract assumes JSON UDF storage.
- Remote DB: Phase 4 migration **not** deployed unless operator runs deploy script.

## 31. Files changed

| Path |
|------|
| `src/lib/tallyMapping/**` |
| `src/lib/__tests__/tallyMappingPhase4.test.ts` |
| `src/lib/__tests__/tallyMappingMetadataLedger.test.ts` |
| `docs/tally-integration/PHASE-05-METADATA-LEDGER-ARCHITECTURE.md` |
| `supabase/migrations/20261006120000_tally_delivery_state_phase4.sql` |
| `scripts/tally-integration/remote-deploy-46.mjs` (migration list) |

## 32. Migrations

`20261006120000_tally_delivery_state_phase4.sql` — apply after Phase 2/3/3.6 migrations.

## 33. Rollback

Drop `tally_delivery_state`, `tally_org_connector_config`; remove `src/lib/tallyMapping` (no UI/worker dependency).

## 34. Tally communication

**None.** No localhost:9000, no connector, no TDL, no production voucher creation.

## 35. Phase 5 recommendation

Wire **post-prepared** server job: load items → `mapPreparedJobItems` → queue XML batches to connector → update `tally_delivery_state` only on Tally ack. Deploy migration + optional edge copy of mapping lib.
