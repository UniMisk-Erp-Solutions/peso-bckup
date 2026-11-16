# Final production architecture (locked)

**Status:** LOCKED — 2026-10-06  
**Do not redesign** report engine, delivery queue, pairing, or localhost Tally transport.

## Product

| Artifact | Role |
|----------|------|
| **PesoWise-for-Tally-Setup.exe** | One universal Windows installer for all customers (planned packaging) |
| **PesoWise Tally Agent** | Background service — foundation: `connector/tally` → `PesoWise-Tally-Connector.exe` |
| **PesoWise.tcp** / **`tally-extension/PesoWise-Reports.tdl`** | Phase 6 — **Daily Project** TDL in repo; load manually in TallyPrime (see `PHASE-06-INSTALL-PESOWISE-REPORTS.md`) |

## Flow (daily)

PesoWise Admin → Reports → **one** report → **Sync to Tally** → backend preparation → delivery batches → **Agent** (HTTPS outbound) → `127.0.0.1:9000` → configured Tally company → ACK → job `completed`.

User does **not** act inside Tally for normal sync.

## Tally availability

If Tally is unreachable at delivery time: **no success ACK**, job stays **`waiting_for_connector`** / retry. UI message (target): *“TallyPrime is unavailable. Open TallyPrime and try again.”*

## Multi-customer

- No org/company IDs in the Agent binary.
- Pairing binds **organization + device + Tally company** per installation.
- Config `configVersion: 1` today; future `pairings[]` allowed without breaking v1.

## Multi-company invariant

Before import: validate **device org**, **server `tally_company_name`**, and **local configured company**. Mismatch → **failed ack**, no write.

## Metadata (not vouchers)

- Logical key **K** = `metadata_delivery_key`
- Content **H** = `content_hash`
- Physical ledger = immutable CREATE per `(K, H)`
- Current logical row = **max(`metadata_revision`)** per **K** — **never** `max(content_hash)`
- HTTP Alter **not** used in production

## Preserved completed work

Phases 2–5.3 report isolation, preparation, mapping, connector claim/lease/ACK, real Tally metadata CREATE/SKIP, append-only versions, 213 tally-scoped tests (local).

## References

- Transport: `PHASE-05-CONNECTOR-TRANSPORT.md`
- Revisions: `METADATA-REVISION-MODEL.md`
- Pairing: `AGENT-PAIRING-AND-SECURITY.md`
- Installer: `UNIVERSAL-INSTALLER-DESIGN.md`
- TDL read model: `TALLY-TDL-READ-MODEL-CONTRACT.md`
