-- DOC-150 bill-requirement acceptance test. THROWAWAY database only.
-- psql -f this file; it builds its own minimal schema, applies the REAL migration, then asserts.
CREATE TYPE expense_status AS ENUM ('draft','submitted','rejected','approved');
CREATE TABLE organization_settings (organization_id uuid PRIMARY KEY, attachment_required_above_amount numeric);
CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, organization_id uuid NOT NULL,
  title text NOT NULL DEFAULT 't', destination text NOT NULL DEFAULT 'd', trip_start date NOT NULL DEFAULT current_date, trip_end date NOT NULL DEFAULT current_date,
  status expense_status NOT NULL DEFAULT 'draft', total_amount numeric, created_by_admin_id uuid);
CREATE TABLE attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), expense_id uuid REFERENCES expenses(id) ON DELETE CASCADE,
  file_url text, storage_path text, deleted_at timestamptz);
CREATE TABLE restore_locks (organization_id uuid PRIMARY KEY);
CREATE FUNCTION is_organization_locked_for_restore_v1(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM restore_locks WHERE organization_id = p) $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
              IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
              IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$;
\i supabase/migrations/20261028100000_attachment_requirement_on_submit_v1.sql

CREATE FUNCTION pg_temp.rep(label text, pass boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $f$
BEGIN RAISE NOTICE 'TEST % : % %', rpad(label, 66), CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END, detail; END $f$;

-- Try the transition to 'submitted' and force the DEFERRED check now; true = accepted, false = refused.
CREATE FUNCTION pg_temp.submit_ok(p_id uuid) RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
  UPDATE expenses SET status = 'submitted' WHERE id = p_id;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN true;
EXCEPTION WHEN check_violation THEN
  SET CONSTRAINTS ALL DEFERRED;
  RETURN false;
END $f$;

CREATE FUNCTION pg_temp.mk(p_org uuid, p_amount numeric, p_admin uuid DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO expenses (user_id, organization_id, total_amount, created_by_admin_id) VALUES (gen_random_uuid(), p_org, p_amount, p_admin) RETURNING id $f$;

DO $t$
DECLARE o uuid := gen_random_uuid(); o_null uuid := gen_random_uuid(); o_lock uuid := gen_random_uuid();
        e uuid; e2 uuid; msg text;
BEGIN
  INSERT INTO organization_settings VALUES (o, 499), (o_null, NULL), (o_lock, 499);
  INSERT INTO restore_locks VALUES (o_lock);

  -- 12-14: threshold boundary
  PERFORM pg_temp.rep('12 amount 499, no bill -> PASS (not above threshold)', pg_temp.submit_ok(pg_temp.mk(o, 499)));
  PERFORM pg_temp.rep('12b amount 499.00 (numeric), no bill -> PASS', pg_temp.submit_ok(pg_temp.mk(o, 499.00)));
  PERFORM pg_temp.rep('12c amount 100, no bill -> PASS', pg_temp.submit_ok(pg_temp.mk(o, 100)));
  PERFORM pg_temp.rep('13 amount 499.01, no bill -> BLOCK', NOT pg_temp.submit_ok(pg_temp.mk(o, 499.01)));
  PERFORM pg_temp.rep('13b amount 500, no bill -> BLOCK', NOT pg_temp.submit_ok(pg_temp.mk(o, 500)));
  PERFORM pg_temp.rep('14 amount 800, no bill -> BLOCK', NOT pg_temp.submit_ok(pg_temp.mk(o, 800)));

  -- 15: active bill
  e := pg_temp.mk(o, 800);
  INSERT INTO attachments (expense_id, storage_path) VALUES (e, 'org/e/bill.png');
  PERFORM pg_temp.rep('15 amount 800, active bill (storage_path) -> PASS', pg_temp.submit_ok(e));

  -- legacy row that only has file_url
  e := pg_temp.mk(o, 800);
  INSERT INTO attachments (expense_id, file_url) VALUES (e, 'https://x/legacy.jpg');
  PERFORM pg_temp.rep('15b legacy attachment with only file_url -> PASS', pg_temp.submit_ok(e));

  -- 16: the incident - bill uploaded then soft-deleted
  e := pg_temp.mk(o, 800);
  INSERT INTO attachments (expense_id, storage_path, deleted_at) VALUES (e, 'org/e/bill.png', now());
  PERFORM pg_temp.rep('16 INCIDENT: only a soft-deleted bill -> BLOCK', NOT pg_temp.submit_ok(e));

  -- 17: another expense's bill
  e := pg_temp.mk(o, 800); e2 := pg_temp.mk(o, 800);
  INSERT INTO attachments (expense_id, storage_path) VALUES (e2, 'org/e2/bill.png');
  PERFORM pg_temp.rep('17 bill belongs to ANOTHER expense -> BLOCK', NOT pg_temp.submit_ok(e));

  -- blank reference does not count
  e := pg_temp.mk(o, 800);
  INSERT INTO attachments (expense_id, storage_path, file_url) VALUES (e, '  ', '');
  PERFORM pg_temp.rep('17b attachment row with no storage reference -> BLOCK', NOT pg_temp.submit_ok(e));

  -- 18: temp-only upload has NO attachment row, so it cannot satisfy the rule
  PERFORM pg_temp.rep('18 temp-only upload (no attachment row yet) -> BLOCK', NOT pg_temp.submit_ok(pg_temp.mk(o, 800)));

  -- 24/25: draft -> add bill -> same id submit
  e := pg_temp.mk(o, 800);
  PERFORM pg_temp.rep('24a draft without bill is refused', NOT pg_temp.submit_ok(e));
  PERFORM pg_temp.rep('24b ...the SAME row is still a draft (nothing half-submitted)', (SELECT status FROM expenses WHERE id = e) = 'draft');
  INSERT INTO attachments (expense_id, storage_path) VALUES (e, 'org/e/bill.png');
  PERFORM pg_temp.rep('24c after adding the bill, the SAME id submits', pg_temp.submit_ok(e) AND (SELECT count(*) FROM expenses) > 0);
  PERFORM pg_temp.rep('24d no sibling row was created by the failed attempt', (SELECT count(*) FROM expenses WHERE id = e) = 1);

  -- 19: validation message carries the configured threshold, stable hint
  e := pg_temp.mk(o, 800);
  BEGIN PERFORM public.validate_expense_attachment_requirement_v1(e);
  EXCEPTION WHEN check_violation THEN GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; END;
  PERFORM pg_temp.rep('20 friendly message uses the configured threshold', msg = 'Bill photos are required for expenses above ₹499. Please upload at least one receipt or bill before submitting.', msg);

  -- withdrawal -> resubmit keeps the same invariant
  e := pg_temp.mk(o, 800);
  INSERT INTO attachments (expense_id, storage_path) VALUES (e, 'b');
  PERFORM pg_temp.submit_ok(e);
  UPDATE expenses SET status = 'draft' WHERE id = e;                       -- withdrawn
  UPDATE attachments SET deleted_at = now() WHERE expense_id = e;          -- user removed the bill
  PERFORM pg_temp.rep('19b withdrawal -> resubmit without a bill -> BLOCK', NOT pg_temp.submit_ok(e));
  INSERT INTO attachments (expense_id, storage_path) VALUES (e, 'b2');
  PERFORM pg_temp.rep('19c withdrawal -> add bill -> resubmit same id -> PASS', pg_temp.submit_ok(e));

  -- exceptions / configuration
  PERFORM pg_temp.rep('E1 organisation with NULL threshold: no requirement', pg_temp.submit_ok(pg_temp.mk(o_null, 100000)));
  PERFORM pg_temp.rep('E2 organisation in a restore window is not enforced', pg_temp.submit_ok(pg_temp.mk(o_lock, 800)));
  PERFORM pg_temp.rep('E3 admin-created rows are NOT exempt (no admin override): 800 without bill -> BLOCK', NOT pg_temp.submit_ok(pg_temp.mk(o, 800, gen_random_uuid())));
  e := pg_temp.mk(o, 999999);
  PERFORM pg_temp.rep('E4 saving a DRAFT is never checked', (SELECT status FROM expenses WHERE id = e) = 'draft');

  -- non-status updates of an already-submitted expense do not re-validate
  e := pg_temp.mk(o, 800);
  INSERT INTO attachments (expense_id, storage_path) VALUES (e, 'b');
  PERFORM pg_temp.submit_ok(e);
  UPDATE attachments SET deleted_at = now() WHERE expense_id = e;
  UPDATE expenses SET total_amount = 850 WHERE id = e;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.rep('E5 editing an already-submitted expense is not re-validated (no status change)', true);

  PERFORM pg_temp.rep('E6 anon has no EXECUTE on the validator', NOT has_function_privilege('anon', 'public.validate_expense_attachment_requirement_v1(uuid)', 'EXECUTE'));
  RAISE EXCEPTION 'ROLLBACK_TEST_DONE';
END $t$;
