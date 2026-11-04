-- Local schema mirroring what report_daily_project_rows_v1 reads in Production (DOC-101 §10).
-- Throwaway database only. Column shapes and the report-relevant indexes are copied
-- from the live catalog; no production data.
DO $r$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END
$r$;

CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.profiles (
  user_id uuid, organization_id uuid, name text, employee_id text
);
CREATE INDEX ON public.profiles (organization_id, user_id);

CREATE TABLE public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, user_id uuid,
  status text, total_amount numeric, trip_start date, transaction_number text,
  title text, category text, purpose text, destination text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_daily_report_scope_idx ON public.expenses (organization_id, trip_start, user_id) WHERE (status = 'approved');

CREATE TABLE public.expense_form_field_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, name text NOT NULL, field_key text
);
CREATE TABLE public.expense_form_field_option_branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  parent_template_id uuid, parent_option_value text NOT NULL DEFAULT '', field_key text NOT NULL,
  name text NOT NULL DEFAULT '', options jsonb, display_order integer NOT NULL DEFAULT 0,
  retired_at timestamptz
);
CREATE INDEX efv_option_branches_org_key_parent_idx ON public.expense_form_field_option_branches (organization_id, field_key, parent_option_value);
CREATE INDEX idx_efob_id_org ON public.expense_form_field_option_branches (id, organization_id) INCLUDE (name, field_key);

CREATE TABLE public.expense_form_field_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, expense_id uuid NOT NULL,
  template_id uuid, field_value text NOT NULL, branch_field_id uuid
);
CREATE UNIQUE INDEX uq_form_field_values_expense_template ON public.expense_form_field_values (expense_id, template_id);
CREATE UNIQUE INDEX uq_form_field_values_expense_branch ON public.expense_form_field_values (expense_id, branch_field_id);
CREATE INDEX idx_efv_org_expense_covering ON public.expense_form_field_values (organization_id, expense_id) INCLUDE (field_value, template_id, branch_field_id);
CREATE INDEX idx_form_field_values_template ON public.expense_form_field_values (template_id);

-- helpers, verbatim from Production
CREATE OR REPLACE FUNCTION public._daily_report_parse_source_v1(p_raw text)
 RETURNS TABLE(kind text, key text)
 LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
  SELECT CASE
           WHEN v IS NULL OR v = ''            THEN 'none'
           WHEN v LIKE 'base:%'                THEN 'base'
           WHEN v LIKE 'branch:%'              THEN CASE WHEN btrim(substr(v, 8))  = '' THEN 'none' ELSE 'branch'   END
           WHEN v LIKE 'template:%'            THEN CASE WHEN btrim(substr(v, 10)) = '' THEN 'none' ELSE 'template' END
           WHEN v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                               THEN 'template'
           ELSE 'none'
         END,
         CASE
           WHEN v IS NULL OR v = ''            THEN NULL
           WHEN v LIKE 'base:%'                THEN substr(v, 6)
           WHEN v LIKE 'branch:%'              THEN NULLIF(btrim(substr(v, 8)),  '')
           WHEN v LIKE 'template:%'            THEN NULLIF(btrim(substr(v, 10)), '')
           WHEN v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                               THEN v
           ELSE NULL
         END
  FROM (SELECT btrim(COALESCE(p_raw, '')) AS v) s;
$function$;

CREATE OR REPLACE FUNCTION public._daily_report_base_value_v1(p_key text, p_title text, p_destination text, p_purpose text, p_category text, p_trip_start date, p_total_amount numeric)
 RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
  SELECT CASE p_key
    WHEN 'title'        THEN btrim(COALESCE(p_title, ''))
    WHEN 'destination'  THEN btrim(COALESCE(p_destination, ''))
    WHEN 'purpose'      THEN btrim(COALESCE(p_purpose, ''))
    WHEN 'category'     THEN btrim(COALESCE(p_category, ''))
    WHEN 'expense_date' THEN COALESCE(p_trip_start::text, '')
    WHEN 'amount'       THEN CASE WHEN p_total_amount IS NULL THEN ''
                                  ELSE trim(to_char(p_total_amount, 'FM9999999999990.999999')) END
    ELSE ''
  END;
$function$;
