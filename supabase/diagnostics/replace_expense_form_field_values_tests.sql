-- Manual RPC test scenarios for replace_expense_form_field_values.
--
-- Run in a STAGING environment, inside a transaction you can ROLLBACK.
-- These exercise the database contract that the Vitest suite cannot
-- (RLS / authorization / atomicity live in Postgres).
--
-- Replace the placeholder UUIDs with real staging values:
--   :owner_uid       an auth user who owns :expense_id
--   :other_uid       a different auth user (no rights on :expense_id)
--   :org_id          the expense's organization
--   :expense_id      an editable (draft/submitted/rejected) expense in :org_id
--   :tpl_a, :tpl_b   template ids assigned to the expense's category in :org_id
--   :branch_a        a branch field id in :org_id
--   :foreign_tpl     a template id in a DIFFERENT organization
--
-- Auth in SQL editor is simulated with request.jwt.claims; adjust to your setup.

BEGIN;

-- Helper to act as a specific user inside this transaction.
-- (Supabase: set the JWT claims so auth.uid() resolves to the test user.)
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-000000000001')::text, -- :owner_uid
  true
);

-- 1) Save two regular template fields.
SELECT public.replace_expense_form_field_values(
  '00000000-0000-0000-0000-0000000000AA', -- :expense_id
  '00000000-0000-0000-0000-0000000000BB', -- :org_id
  '[{"template_id":"<tpl_a>","branch_field_id":null,"field_value":"ABC"},
    {"template_id":"<tpl_b>","branch_field_id":null,"field_value":"Pune"}]'::jsonb
);
-- Expect: {"saved_count": 2}

-- 2) Save one regular + one branch field.
SELECT public.replace_expense_form_field_values(
  '00000000-0000-0000-0000-0000000000AA',
  '00000000-0000-0000-0000-0000000000BB',
  '[{"template_id":"<tpl_a>","branch_field_id":null,"field_value":"ABC"},
    {"template_id":null,"branch_field_id":"<branch_a>","field_value":"child"}]'::jsonb
);
-- Expect: {"saved_count": 2}; one template row + one branch row.

-- 3) Re-save with changed values (atomic replace).
SELECT public.replace_expense_form_field_values(
  '00000000-0000-0000-0000-0000000000AA',
  '00000000-0000-0000-0000-0000000000BB',
  '[{"template_id":"<tpl_a>","branch_field_id":null,"field_value":"CHANGED"}]'::jsonb
);
-- Expect: {"saved_count": 1}; tpl_b and branch_a rows removed.

-- 4 & 5) Exactly one row per (expense_id, template_id) / (expense_id, branch_field_id).
SELECT expense_id, template_id, branch_field_id, COUNT(*)
FROM public.expense_form_field_values
WHERE expense_id = '00000000-0000-0000-0000-0000000000AA'
GROUP BY expense_id, template_id, branch_field_id;
-- Expect: every count = 1.

-- 6) Remove a field by omitting it (already covered by step 3).

-- 7) Duplicate template ids in payload -> error 22023.
DO $$
BEGIN
  PERFORM public.replace_expense_form_field_values(
    '00000000-0000-0000-0000-0000000000AA',
    '00000000-0000-0000-0000-0000000000BB',
    '[{"template_id":"<tpl_a>","branch_field_id":null,"field_value":"x"},
      {"template_id":"<tpl_a>","branch_field_id":null,"field_value":"y"}]'::jsonb
  );
  RAISE EXCEPTION 'TEST FAILED: duplicate template_id was accepted';
EXCEPTION WHEN others THEN
  RAISE NOTICE 'OK duplicate rejected: %', SQLERRM;
END $$;

-- 8) A different user must NOT write another user's expense -> error 42501.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-000000000002')::text, -- :other_uid
  true
);
DO $$
BEGIN
  PERFORM public.replace_expense_form_field_values(
    '00000000-0000-0000-0000-0000000000AA',
    '00000000-0000-0000-0000-0000000000BB',
    '[{"template_id":"<tpl_a>","branch_field_id":null,"field_value":"hack"}]'::jsonb
  );
  RAISE EXCEPTION 'TEST FAILED: foreign user was allowed to write';
EXCEPTION WHEN others THEN
  RAISE NOTICE 'OK foreign user rejected: %', SQLERRM;
END $$;

-- 9) Wrong organization id -> error 42501 (back as owner first).
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-000000000001')::text,
  true
);
DO $$
BEGIN
  PERFORM public.replace_expense_form_field_values(
    '00000000-0000-0000-0000-0000000000AA',
    '00000000-0000-0000-0000-00000000FFFF', -- wrong org
    '[{"template_id":"<tpl_a>","branch_field_id":null,"field_value":"x"}]'::jsonb
  );
  RAISE EXCEPTION 'TEST FAILED: org mismatch accepted';
EXCEPTION WHEN others THEN
  RAISE NOTICE 'OK org mismatch rejected: %', SQLERRM;
END $$;

-- 10) Rollback on invalid row: cross-org template id -> no partial writes.
DO $$
DECLARE
  before_count integer;
  after_count integer;
BEGIN
  SELECT COUNT(*) INTO before_count
  FROM public.expense_form_field_values
  WHERE expense_id = '00000000-0000-0000-0000-0000000000AA';

  BEGIN
    PERFORM public.replace_expense_form_field_values(
      '00000000-0000-0000-0000-0000000000AA',
      '00000000-0000-0000-0000-0000000000BB',
      '[{"template_id":"<tpl_a>","branch_field_id":null,"field_value":"ok"},
        {"template_id":"<foreign_tpl>","branch_field_id":null,"field_value":"bad"}]'::jsonb
    );
    RAISE EXCEPTION 'TEST FAILED: cross-org template accepted';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'OK cross-org template rejected: %', SQLERRM;
  END;

  SELECT COUNT(*) INTO after_count
  FROM public.expense_form_field_values
  WHERE expense_id = '00000000-0000-0000-0000-0000000000AA';

  IF before_count <> after_count THEN
    RAISE EXCEPTION 'TEST FAILED: partial write occurred (% -> %)', before_count, after_count;
  ELSE
    RAISE NOTICE 'OK no partial write (count stable at %)', after_count;
  END IF;
END $$;

ROLLBACK;
