-- Draft-incident audit (read-only against Production; this file runs ONLY on a throwaway database).
-- Reproduces the live owner-UPDATE policy set on public.expenses (pg_policies, 2026-10-16) and proves:
--   1. an owner can promote own draft -> submitted
--   2. an owner CANNOT keep a draft a draft while changing any column (e.g. batch_id, title)
--      => ExpenseService.submitBatchExpenses' `.update({batch_id})` and ExpenseService.updateExpense()
--         on a draft are rejected by RLS since 20260922090000 (client ignores / surfaces the error).
CREATE ROLE authenticated NOLOGIN;
CREATE TYPE expense_status AS ENUM ('draft','submitted','rejected','approved');
CREATE TABLE expenses (id uuid primary key default gen_random_uuid(), user_id uuid, organization_id uuid, status expense_status, title text, batch_id uuid);
CREATE TABLE organization_memberships (user_id uuid, organization_id uuid, is_active boolean);
CREATE FUNCTION is_accountant_cashier(uuid, uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION auth_uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT SELECT, UPDATE ON expenses TO authenticated; GRANT SELECT ON organization_memberships TO authenticated;
GRANT EXECUTE ON FUNCTION auth_uid(), is_accountant_cashier(uuid, uuid) TO authenticated;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_select ON expenses FOR SELECT USING (auth_uid() = user_id);
CREATE POLICY "Users can submit their draft expenses" ON expenses FOR UPDATE
  USING (auth_uid() = user_id AND status = 'draft') WITH CHECK (auth_uid() = user_id AND status = 'submitted');
CREATE POLICY "Users can update their own submitted expenses" ON expenses FOR UPDATE
  USING (auth_uid() = user_id AND status = 'submitted' AND EXISTS (SELECT 1 FROM organization_memberships om WHERE om.user_id = auth_uid() AND om.organization_id = expenses.organization_id AND om.is_active))
  WITH CHECK (auth_uid() = user_id AND organization_id IS NOT NULL AND status = 'submitted' AND EXISTS (SELECT 1 FROM organization_memberships om WHERE om.user_id = auth_uid() AND om.organization_id = expenses.organization_id AND om.is_active));
CREATE POLICY "Users can update their submitted or rejected expenses" ON expenses FOR UPDATE
  USING (auth_uid() = user_id AND status IN ('submitted','rejected') AND NOT is_accountant_cashier(auth_uid(), organization_id) AND EXISTS (SELECT 1 FROM organization_memberships om WHERE om.user_id = auth_uid() AND om.organization_id = expenses.organization_id AND om.is_active))
  WITH CHECK (auth_uid() = user_id AND organization_id IS NOT NULL AND status IN ('submitted','rejected') AND NOT is_accountant_cashier(auth_uid(), organization_id) AND EXISTS (SELECT 1 FROM organization_memberships om WHERE om.user_id = auth_uid() AND om.organization_id = expenses.organization_id AND om.is_active));

DO $t$
DECLARE u uuid := gen_random_uuid(); o uuid := gen_random_uuid(); d uuid; n int; failed boolean;
BEGIN
  INSERT INTO organization_memberships VALUES (u, o, true);
  INSERT INTO expenses (user_id, organization_id, status, title) VALUES (u, o, 'draft', 'x') RETURNING id INTO d;
  PERFORM set_config('request.jwt.claim.sub', u::text, true);
  SET LOCAL ROLE authenticated;

  failed := false;
  BEGIN UPDATE expenses SET batch_id = gen_random_uuid() WHERE id = d; GET DIAGNOSTICS n = ROW_COUNT;
  EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  RAISE NOTICE 'TEST draft->draft (set batch_id) rejected by RLS: %', CASE WHEN failed THEN 'PASS' ELSE 'FAIL' END;

  failed := false;
  BEGIN UPDATE expenses SET title = 'edited draft' WHERE id = d; EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  RAISE NOTICE 'TEST draft->draft (edit title) rejected by RLS: %', CASE WHEN failed THEN 'PASS' ELSE 'FAIL' END;

  UPDATE expenses SET status = 'submitted' WHERE id = d; GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'TEST draft->submitted allowed (the only door): %', CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END;

  UPDATE expenses SET title = 'edited submitted' WHERE id = d; GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'TEST submitted->submitted edit allowed: %', CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END;
END $t$;
