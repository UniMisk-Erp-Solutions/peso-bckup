# Staging network audit (Gate M)

**Scope:** Full React staging `pesowise-react-migration-staging` (`127.0.0.1:5175`) + minimal UI (`5174`).

## Static bundle scan (20260930)

| Pattern | Hits in built JS | Notes |
|---------|------------------|--------|
| `:54321` | 0 | Good |
| `pesowise-supabase` | 0 | Good |
| `rest/v1` | 1 | Likely string literal in source |
| `auth/v1` | 1 | Likely string literal |
| `storage/v1` | 7 | Includes legacy URL helpers / attachment code paths |

**Gate M:** **PARTIAL** — no production host baked into bundle, but **runtime** fetch/WebSocket audit on all major flows is still required. Migration build uses `VITE_MIGRATION_STAGING=true` + `VITE_API_URL` and Supabase client stub (`src/integrations/supabase/migrationStub.ts`).

## Minimal UI (5174)

| Host | Classification |
|------|----------------|
| `127.0.0.1:18787` | Staging API only |
| Production Supabase | **0** requests |
