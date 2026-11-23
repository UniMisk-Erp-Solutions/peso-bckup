# Doctor — Tally company detection

> **Safety:** After **TallyPrime 7.1 c0000005** during doctor XML probes, see **`TALLY-DOCTOR-C0000005-INCIDENT.md`**.  
> **Doctor must not send HTTP/XML to Tally** until a validated passive probe is approved.

## Current behavior (0.2.1-agent+)

| Check | Method |
|--------|--------|
| Integration port | **TCP connect** to configured host/port (default `127.0.0.1:9000`), **3s**, **one** attempt |
| Backend | Device token **heartbeat** (HTTPS) |
| Company name | From **paired `config.json`** only |
| `tally_company_found` | **`false`** — verification **disabled** (`tally_company_verification: disabled_pending_safe_probe`) |

Doctor **does not**: Load Company, Object export, Voucher Type export, catalog export, Import, or start `tally.exe`.

## Superseded (unsafe — removed)

~~Company catalog + Voucher Type + Load Company fallback~~ — removed after c0000005 incident.

## Offline tests

- `src/lib/__tests__/tallyDoctorSafety.test.ts`
- `src/lib/__tests__/tallyCompanyVerify.test.ts` (parser fixtures only)
