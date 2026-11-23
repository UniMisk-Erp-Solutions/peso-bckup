# Agent pairing and security

## Stored locally (`%USERPROFILE%\PesoWise\TallyConnector\config.json`)

| Field | Purpose |
|-------|---------|
| `deviceToken` | Revocable device credential (only secret) |
| `organizationId` | Bound org UUID |
| `connectorId` | Device row id |
| `tallyCompanyName` | Local Tally company target |
| `pesoApiUrl` | Supabase project URL (public) |
| `configVersion` | Schema version (1) |

**Never store:** PesoWise user password, service role key, admin JWT.

## One-time pairing

1. **Admin** (authenticated): RPC `create_tally_connector_pairing_code_v1(p_organization_id, p_ttl_minutes)`
2. **Agent** (once): exchange via `exchange_tally_connector_pairing_v1` — implemented as:

```text
PesoWise-Tally-Connector.exe pair --url <SUPABASE_URL> --anon-key <ANON> --code <CODE> --company "<TALLY COMPANY>"
```

Dev equivalent: `node connector/tally/dist/main.js pair …`

**pkg / EXE (2026-10-06):** Pairing must use `node:crypto` `randomUUID()` via `randomId.ts` — global `crypto` is undefined in packaged Windows binaries (`crypto is not defined`).

**Pairing transport:** Agent calls **PostgREST** `POST /rest/v1/rpc/exchange_tally_connector_pairing_v1` with **public anon** `apikey` + `Authorization: Bearer <same anon>`. It does **not** use the `tally-connector` Edge function (device token only).

**401 `{ "message": "Unauthorized", "request_id": … }`:** Kong rejected the JWT — anon key does not match `https://pesowise-backup-supabase.unimisk.com`. Resolve: `DEPLOY_SSH_PASSWORD=… PRINT_ANON_KEY=1 node scripts/tally-integration/resolve-backup-anon-key.mjs`.

**RPC `digest(text, unknown)` after auth OK:** apply `20261007160000_tally_connector_pgcrypto_search_path.sql` via `scripts/tally-integration/apply-pgcrypto-search-path-only.mjs` (sets `search_path = public, extensions` on pairing RPCs).

3. Backend issues **device_token**; Agent saves to config; pairing code invalidated.

Helper script (admin env): `scripts/tally-integration/create-connector-pairing-code.mjs`

### Test bootstrap only (no smoke-org admin password)

When admin JWT for org `80ab039f-f9e2-4c76-8b5b-e65b15d66af9` is unavailable:

1. `ssh-verify-queue-safe.mjs` — pending batches must be **0**.
2. `ssh-issue-test-pairing-code.mjs` with `ISSUE_PAIRING_CONFIRM=1` — inserts the **same** `code_hash` / prefix / TTL shape as `create_tally_connector_pairing_code_v1`; plaintext code printed **once** on stderr.

Guards: smoke org UUID only, company **PesoWise Integration Test**, no RLS changes, no user/password reset. Exchange still uses `exchange_tally_connector_pairing_v1` (anon). **Not** for production customers.

## Org ↔ company

Admin RPC `set_tally_org_company_v1(org, tally_company_name)` — server sends company on **claim**; Agent verifies list + injects `<SVCURRENTCOMPANY>`.

## Revocation

`revoke_tally_connector_v1(connector_id)` — heartbeat/claim fail with 403.

## Future installer UX

`PesoWise-for-Tally-Setup.exe` will run a **Connect PesoWise** wizard step that collects the pairing code only (no Supabase password). Publishable anon key may be embedded in installer (public client key).
