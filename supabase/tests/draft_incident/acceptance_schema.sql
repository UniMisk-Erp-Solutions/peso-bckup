-- DOC-148 acceptance test, part 1: minimal schema for a THROWAWAY database. No Production data.
-- Mirrors only the columns / policies the three new RPCs and the live validator touch.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
              IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
GRANT USAGE ON SCHEMA public TO authenticated, anon;

CREATE TYPE expense_status AS ENUM ('draft','submitted','rejected','approved');
CREATE TABLE organization_memberships (user_id uuid, organization_id uuid, is_active boolean, role text DEFAULT 'employee');
CREATE TABLE organization_settings (organization_id uuid, allow_cashier_expense_submission boolean DEFAULT false);
CREATE TABLE audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), expense_id uuid, user_id uuid, organization_id uuid, action text, comment text, created_at timestamptz DEFAULT now());
CREATE FUNCTION is_accountant_cashier(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, organization_id uuid NOT NULL,
  title text NOT NULL, destination text NOT NULL, trip_start date NOT NULL, trip_end date NOT NULL,
  purpose text, category text, status expense_status NOT NULL DEFAULT 'draft', total_amount numeric,
  batch_id uuid, transaction_number text, approval_tier text, assigned_reviewer_id uuid, approved_by uuid,
  deleted_at timestamptz, revision bigint NOT NULL DEFAULT 0, updated_at timestamptz DEFAULT now());
CREATE TABLE expense_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, user_id uuid, label text, shared_category text, shared_expense_date date, line_count int, total_amount numeric, created_at timestamptz DEFAULT now());
CREATE TABLE expense_categories (id uuid PRIMARY KEY, organization_id uuid, name text);
CREATE TABLE expense_form_field_templates (id uuid PRIMARY KEY, name text, field_type text, required boolean, show_on_submit boolean);
CREATE TABLE expense_category_form_fields (category_id uuid, organization_id uuid, template_id uuid, required boolean, show_on_submit boolean);
CREATE TABLE expense_form_field_values (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, expense_id uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  template_id uuid, field_value text NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), branch_field_id uuid);
CREATE TABLE organization_required_expense_fields (organization_id uuid, template_id uuid, required boolean, required_branch_field_keys text[]);
CREATE TABLE expense_form_field_option_branches (id uuid PRIMARY KEY, organization_id uuid, parent_template_id uuid, parent_branch_id uuid, parent_option_value text,
  name text, field_key text, required boolean, display_order int, retired_at timestamptz);

GRANT SELECT, UPDATE ON expenses TO authenticated;
-- The LIVE owner policy set (pg_policies 2026-10-16): the only owner draft door is draft -> submitted.
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_select ON expenses FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can submit their draft expenses" ON expenses FOR UPDATE
  USING (auth.uid() = user_id AND status = 'draft') WITH CHECK (auth.uid() = user_id AND status = 'submitted');
