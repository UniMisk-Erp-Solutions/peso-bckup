-- =============================================================================
-- PesoWise: run AFTER reloading a Supabase backup (e.g. May 27 5:30 AM restore)
-- =============================================================================
-- Combines everything added/fixed after that backup date:
--   1. Schema grants (public + storage) — fixes 403 / empty app after restore
--   2. Rewrite attachment & org logo URLs to current project
--   3. Manager visibility RPCs (migration 20260528183500)
--
-- Safe to re-run (idempotent where possible).
--
-- HOW TO RUN:
--   A) Supabase Dashboard → SQL Editor → paste this entire file → Run
--   B) Local: npm run post-restore:sql
--
-- CONFIG: If your old/new project refs differ, find-replace the two refs below.
-- =============================================================================

-- ─── CONFIG ─────────────────────────────────────────────────────────────────
-- Old project ref (often in URLs inside a restored backup):
--   briypgrgqagbexudarba
-- Current/live project ref (must match VITE_SUPABASE_URL):
--   kqlqirdneocivumdjtvx

BEGIN;

-- =============================================================================
-- PART 1 — Schema grants (20260530120000_fix_public_schema_grants_after_restore)
-- =============================================================================

GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;

-- Receipt preview/download via storage API
GRANT USAGE ON SCHEMA storage TO postgres, anon, authenticated, service_role;

-- =============================================================================
-- PART 2 — Point Storage URLs at current Supabase project
-- =============================================================================

UPDATE public.attachments
SET file_url = replace(file_url, 'briypgrgqagbexudarba', 'kqlqirdneocivumdjtvx')
WHERE file_url LIKE '%briypgrgqagbexudarba%';

UPDATE public.organizations
SET logo_url = replace(logo_url, 'briypgrgqagbexudarba', 'kqlqirdneocivumdjtvx')
WHERE logo_url IS NOT NULL
  AND logo_url LIKE '%briypgrgqagbexudarba%';

-- Manager RPCs: run manual-section-3-manager-and-verify.sql (Section 3) separately.

COMMIT;

-- =============================================================================
-- PART 4 — Verification (read results in SQL Editor)
-- =============================================================================

SELECT 'expenses' AS tbl, COUNT(*)::bigint AS cnt FROM public.expenses
UNION ALL SELECT 'attachments', COUNT(*) FROM public.attachments
UNION ALL SELECT 'profiles', COUNT(*) FROM public.profiles
UNION ALL SELECT 'organizations', COUNT(*) FROM public.organizations;

SELECT COUNT(*) AS attachments_still_on_old_project
FROM public.attachments
WHERE file_url LIKE '%briypgrgqagbexudarba%';

SELECT COUNT(*) AS receipt_files_in_storage
FROM storage.objects
WHERE bucket_id = 'receipts';

-- Next step (not SQL): upload receipt files from your PC backup folder:
--   npm run post-restore:storage
