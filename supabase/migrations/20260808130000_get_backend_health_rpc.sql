-- DOC-088 — restore the missing public.get_backend_health() diagnostic RPC.
--
-- src/hooks/useDashboardBackendHealth.ts calls this RPC on Dashboard mount and
-- every 60 seconds thereafter. No migration in this repository has ever created
-- it: DOC-071 recorded "it does [exist]; it was already present before this fix"
-- and shipped a pure frontend change on that assumption. Production disproves
-- it — /rest/v1/rpc/get_backend_health answers 404, so every dashboard session
-- logs a failed request a minute, forever, and the health chip permanently
-- reads "Unavailable" while the backend is in fact fine.
--
-- The shape below matches what src/lib/backendHealth.ts already parses
-- (status / message / database_reachable / auth_reachable / storage_reachable).
-- That normalizer is deliberately defensive, so this contract is additive: any
-- field it does not recognise is ignored rather than fatal.
--
-- Diagnostic only. It reads nothing, returns no row data, and by design NEVER
-- activates maintenance, blocks a route, signs anyone out or writes Edge Config.

-- Dropped rather than replaced: an earlier definition with a different return
-- type would make CREATE OR REPLACE fail outright. The only caller is the
-- Dashboard health chip, so dropping is safe.
DROP FUNCTION IF EXISTS public.get_backend_health();

CREATE FUNCTION public.get_backend_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth_ok    boolean := false;
  v_storage_ok boolean := false;
BEGIN
  -- Reaching this statement at all proves Postgres and PostgREST are serving
  -- queries, which is exactly what database_reachable means here.

  -- Reachability probes only: `PERFORM ... LIMIT 1` returns no row data to the
  -- caller, so no user record or object key is ever exposed.
  BEGIN
    PERFORM 1 FROM auth.users LIMIT 1;
    v_auth_ok := true;
  EXCEPTION
    WHEN OTHERS THEN
      v_auth_ok := false;
  END;

  BEGIN
    PERFORM 1 FROM storage.objects LIMIT 1;
    v_storage_ok := true;
  EXCEPTION
    WHEN OTHERS THEN
      v_storage_ok := false;
  END;

  RETURN jsonb_build_object(
    'status',              CASE WHEN v_auth_ok AND v_storage_ok THEN 'healthy' ELSE 'degraded' END,
    'message',             CASE WHEN v_auth_ok AND v_storage_ok
                                THEN 'All systems operational'
                                ELSE 'One or more services are degraded' END,
    'database_reachable',  true,
    'auth_reachable',      v_auth_ok,
    'storage_reachable',   v_storage_ok,
    'checked_at',          now()
  );
END;
$$;

-- Authenticated only. The chip lives on the Dashboard, behind a login; anon has
-- no reason to probe backend topology.
REVOKE ALL ON FUNCTION public.get_backend_health() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_backend_health() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_backend_health() TO authenticated;

COMMENT ON FUNCTION public.get_backend_health() IS
  'Diagnostic-only backend health probe for the Dashboard health chip. Returns '
  'status/message plus database, auth and storage reachability booleans. Reads '
  'no row data and exposes no user or object information. Never activates '
  'maintenance, blocks routes or signs users out.';
