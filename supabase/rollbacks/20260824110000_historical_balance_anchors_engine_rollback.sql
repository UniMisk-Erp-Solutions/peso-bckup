-- Rollback for 20260824110000_historical_balance_anchors_engine.sql
-- Must run AFTER 20260824120000/20260824130000 (they call these functions).
BEGIN;

DROP FUNCTION IF EXISTS public.get_balance_historical_anchors_v1(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.balance_reverse_historical_anchor_v1(uuid, text);
DROP FUNCTION IF EXISTS public.balance_preview_historical_anchor_v1(uuid, uuid, text, date, numeric, text, uuid, text);
DROP FUNCTION IF EXISTS public.balance_apply_historical_anchor_v1(uuid, uuid, text, date, numeric, text, text, uuid, text, uuid, uuid);
DROP FUNCTION IF EXISTS public._balance_apply_historical_anchor_core_v1(uuid, uuid, text, date, numeric, text, text, uuid, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public._balance_cascade_downstream_anchors_v1(uuid, uuid, date, smallint, integer, uuid);
DROP FUNCTION IF EXISTS public._balance_materialize_anchor_v1(uuid, uuid, text);
DROP FUNCTION IF EXISTS public._balance_next_anchor_sequence_v1(uuid, uuid, date, text);
DROP FUNCTION IF EXISTS public._balance_historical_position_before_v1(uuid, uuid, date, smallint, integer, uuid);

COMMIT;

NOTIFY pgrst, 'reload schema';
