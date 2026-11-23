-- PostgREST RPC runs SECURITY DEFINER with search_path=public only; digest() lives in extensions.

ALTER FUNCTION public.create_tally_connector_pairing_code_v1(uuid, integer)
  SET search_path = public, extensions;

ALTER FUNCTION public.exchange_tally_connector_pairing_v1(text, text, text, text)
  SET search_path = public, extensions;

ALTER FUNCTION public.resolve_tally_connector_device_v1(text)
  SET search_path = public, extensions;

COMMENT ON FUNCTION public.exchange_tally_connector_pairing_v1(text, text, text, text) IS
  'Anon/authenticated pairing exchange; requires extensions in search_path for digest().';
