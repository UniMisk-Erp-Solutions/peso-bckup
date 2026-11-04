-- Synthetic, sanitized dataset shaped like the failing MicroLink organisation (DOC-101 §10):
-- ~2.7 approved expenses per report group, project id/name/location custom fields,
-- some expenses without a project, name fall-back through branch definitions, noise
-- (non-approved expenses, a second organisation). No production data.
--   psql -v groups=9000 -v employees=450 -f seed.sql
SELECT set_config('dp.groups', :'groups', false), set_config('dp.emps', :'employees', false) \gset
TRUNCATE public.organizations, public.profiles, public.expenses, public.expense_form_field_templates,
         public.expense_form_field_option_branches, public.expense_form_field_values;

DO $s$
DECLARE
  org  uuid := '00000000-0000-0000-0000-00000000000a';
  org2 uuid := '00000000-0000-0000-0000-00000000000b';
  t_pid uuid := '51181324-68cc-4174-bbe0-4834e5e22c48';
  t_pnm uuid := '7ae2b9f5-9c7a-456c-9403-314680526741';
  t_loc uuid := '5308e883-78a4-4bee-abed-67f4e0e5fee8';
  n_groups int := current_setting('dp.groups')::int;
  n_emp int := current_setting('dp.emps')::int;
  n_exp int;
  n_proj int := 300;
BEGIN
  n_exp := (n_groups * 2.66)::int;
  INSERT INTO public.organizations(id, name) VALUES (org, 'Big Org'), (org2, 'Other Org');
  INSERT INTO public.expense_form_field_templates(id, organization_id, name, field_key) VALUES
    (t_pid, org, 'Project ID', 'project_id'), (t_pnm, org, 'Project Name', 'project_name'), (t_loc, org, 'Location', 'location');
  INSERT INTO public.profiles(user_id, organization_id, name, employee_id)
    SELECT ('20000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, org, 'Employee ' || lpad(g::text, 5, '0'), 'E' || g
    FROM generate_series(1, n_emp) g;

  -- branch definitions: project name fall-back keyed by project id
  INSERT INTO public.expense_form_field_option_branches(organization_id, parent_template_id, parent_option_value, field_key, name, options, display_order)
    SELECT org, t_pid, 'P' || lpad(p::text, 4, '0'), 'project_name', 'Project name', jsonb_build_array('Definition name ' || p), 0
    FROM generate_series(1, n_proj) p;

  -- approved expenses: expense i belongs to group triple (i * 7919) % n_groups
  CREATE TEMP TABLE _g ON COMMIT DROP AS
    SELECT i,
           ((i::bigint * 7919) % n_groups)::int AS grp
    FROM generate_series(1, n_exp) i;
  INSERT INTO public.expenses(id, organization_id, user_id, status, total_amount, trip_start, transaction_number,
                              title, category, purpose, destination)
    SELECT gen_random_uuid(), org,
           ('20000000-0000-0000-0000-' || lpad((1 + (((grp * 2) / 3) / 420) % n_emp)::text, 12, '0'))::uuid,
           'approved', 50 + (i * 13) % 900,
           DATE '2025-01-01' + (((grp * 2) / 3) % 420),
           lpad(i::text, 7, '0'), 'Trip ' || i,
           (ARRAY['Petrol Expense (Bike and Car)','Material Purchase','Travelling (Public and Private Transport)',
                  'Mobile Recharges','Hotel/Guest House','Local Manpower','Laptop Rent','Misc'])[1 + (i % 8)],
           'Work', 'Site ' || (i % 40)
    FROM _g;
  -- the project of an expense = f(group): same group => same project => one report group
  CREATE TEMP TABLE _e ON COMMIT DROP AS
    SELECT e.id, e.organization_id, g.i, g.grp, (1 + (g.grp * 17) % n_proj) AS proj
    FROM (SELECT id, organization_id, row_number() OVER (ORDER BY transaction_number) AS rn FROM public.expenses WHERE organization_id = org) e
    JOIN _g g ON g.i = e.rn;

  -- project id for 95% (others fall into the '' project group)
  INSERT INTO public.expense_form_field_values(organization_id, expense_id, template_id, field_value)
    SELECT org, id, t_pid, 'P' || lpad(proj::text, 4, '0') FROM _e WHERE i % 20 <> 0;
  -- project name for 70% (the rest resolve through the branch definition)
  INSERT INTO public.expense_form_field_values(organization_id, expense_id, template_id, field_value)
    SELECT org, id, t_pnm, 'Project ' || proj FROM _e WHERE i % 10 < 7;
  -- location for 80%
  INSERT INTO public.expense_form_field_values(organization_id, expense_id, template_id, field_value)
    SELECT org, id, t_loc, 'Location ' || (grp % 90) FROM _e WHERE i % 5 <> 0;

  -- noise: unapproved expenses and another organisation (must never leak)
  INSERT INTO public.expenses(organization_id, user_id, status, total_amount, trip_start, transaction_number, title)
    SELECT org, ('20000000-0000-0000-0000-' || lpad((1 + g % n_emp)::text, 12, '0'))::uuid,
           CASE WHEN g % 2 = 0 THEN 'submitted' ELSE 'draft' END, 10, DATE '2025-06-01', NULL, 'noise'
    FROM generate_series(1, n_exp / 10) g;
  INSERT INTO public.expenses(organization_id, user_id, status, total_amount, trip_start, transaction_number, title)
    SELECT org2, gen_random_uuid(), 'approved', 5, DATE '2025-03-01', 'X' || g, 'other org' FROM generate_series(1, 300) g;
  ANALYZE;
END
$s$;
