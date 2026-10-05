-- MONTH+YEAR filtering (My Expenses): a dedicated, server-paged, server-
-- filtered owner-list contract for the "My Expenses" page.
--
-- Today src/pages/Expenses.tsx fetches a bounded window of rows (or, via
-- "Load all", the caller's entire history) and does search/status/sort/
-- custom-field filtering ENTIRELY client-side over whatever happened to be
-- loaded. That is correct only in the page's existing default ("All months")
-- mode. Selecting an exact calendar month must become TRUE server-paged,
-- server-filtered browsing -- a month with 3,500 rows must show page 1
-- without ever downloading the other 3,475, and status/search/custom-field
-- filters must narrow the FULL monthly population before pagination, not
-- whatever 25 rows happened to load first.
--
-- No existing contract does this (checked: get_my_expense_deductions_v1 is
-- balance-deduction history, not the expense list; list_manager_visible_
-- review_expenses_page / list_reviewer_visible_expenses_page are reviewer-
-- scoped, not the submitting employee's own list) -- hence this new RPC.
--
-- Security model (the caller can NEVER read another employee's expenses):
--   - auth.uid() IS NOT NULL, fail otherwise;
--   - active organization_memberships row required for p_organization_id;
--   - the underlying query is unconditionally scoped to
--     expenses.user_id = auth.uid() AND expenses.organization_id =
--     p_organization_id -- there is deliberately no p_user_id parameter at
--     all, so the browser cannot request anyone else's list;
--   - anon has no EXECUTE (explicit REVOKE -- this database's
--     ALTER DEFAULT PRIVILEGES grants EXECUTE on every new function to
--     anon/authenticated by default, the same gap fixed repeatedly
--     elsewhere in this schema); authenticated keeps EXECUTE (a normal
--     user-facing endpoint). The internal canonical-custom-field helper
--     below takes a raw expense-id array with NO ownership check of its own
--     -- it is safe ONLY because every caller here already scoped that array
--     to the current user's own rows first -- so it REVOKES EXECUTE from
--     anon AND authenticated too; nothing but this function (as its owner)
--     may ever call it.
--
-- Authority: expenses.trip_start, half-open [p_date_from, p_date_to_exclusive)
-- -- a brand-new contract, so it uses true half-open bounds directly (no
-- inclusive-<= adapter needed, unlike the pre-existing Review queue RPCs).
--
-- Drafts are NOT excluded (§10-11 hardening pass): the existing All-months
-- list (Expenses.tsx's fetchExpenses + filterAndSortExpenses) has never
-- excluded status='draft' rows either -- there is no status filter on the
-- base fetch and no draft check in the client filter pipeline, so a draft
-- genuinely appears in the "All" tab's list today. Excluding drafts only in
-- exact-month mode would silently change list membership when a month is
-- selected. (Saved Drafts tab redesign is a separate, out-of-scope concern
-- with its own UI -- this endpoint mirrors the "All" tab's existing list.)
--
-- Search (§5-9 hardening pass): must match the client's existing
-- expenseRowMatchesSearch() (src/lib/expenseListSearch.ts) semantics --
-- lowercase, split the query on whitespace, and require EVERY word to appear
-- SOMEWHERE across title/destination/purpose/category/status/
-- transaction_number/total_amount/custom-field-labels/custom-field-values
-- (a word from one field and a word from a different field both counting --
-- e.g. "sanand 4957" matches destination="Sanand" plus an unrelated custom
-- field valued "4957"). Word membership uses strpos() on lower() text, never
-- ILIKE '%word%' -- ILIKE treats a literal '%' or '_' in the search text as a
-- wildcard, which would make a literal "%" in user input match everything;
-- strpos is a plain substring check with no wildcard semantics at all.
--
-- Custom-field filters: {label, value} pairs (matching the EXISTING
-- client-side FilterableCustomField.key model in expenseCustomFieldFilters.ts
-- -- no field_id resolution round-trip is introduced); all supplied filters
-- AND together.
--
-- CANONICAL custom-field resolution (§24 correction, then §5/§6 of the final
-- correctness pass): a label is resolved against BOTH
-- expense_form_field_templates.name and expense_form_field_option_branches.
-- name. The client's own fetchExpenseCustomFieldsMap() has NO deterministic
-- precedence for a genuine name clash between a template field and a branch
-- field on the same expense -- its backing query has no ORDER BY, so
-- whichever row Postgres happens to return last wins, an order that is not
-- guaranteed. An exact match to that non-determinism is not meaningful (nor
-- reproducible) to replicate in SQL, so this function instead deterministically
-- prefers a template-sourced value over a branch-sourced value on a clash.
-- A live audit of Production (read-only, 2026-09-15) found ZERO expenses
-- where a template value and a branch value resolve to the same display
-- label across 21,918 expenses with any custom field at all, so this
-- forward-looking rule introduces no discrepancy against current data.
--
-- Earlier revision of this migration computed that precedence THREE separate
-- times with three different implementations: once (correctly) for the
-- returned `custom_fields` display map via an ordered jsonb_object_agg, and
-- twice incorrectly for search and for custom-field filter matching, both of
-- which read raw expense_form_field_values rows directly (a template EXISTS
-- OR a branch EXISTS) with no precedence applied at all. That let a FILTER
-- matched only through a losing (branch) value while the DISPLAYED
-- custom_fields showed the winning (template) value for the same label --
-- e.g. selecting "Project = B" (a branch value) could return a row whose
-- visible `custom_fields.Project` reads "A" (the template value), which
-- contradicts the filter that surfaced it. Search had the same latent bug:
-- a word could match only inside a hidden losing branch value.
--
-- Fixed by computing the canonical (expense_id, label, value) map via ONE
-- shared internal helper, `_my_expenses_canonical_custom_fields_v1`, used for
-- ALL THREE: the search haystack, the custom-field filter predicate, and the
-- returned custom_fields display map. There is now exactly one place the
-- template-wins precedence rule is implemented.
--
-- Sort: title | destination | total_amount | trip_start | created_at, each
-- with a stable `id` tiebreaker so no row is ever duplicated or skipped
-- across pages. title/destination sort case-insensitively (ORDER BY
-- lower(...)) to match the client's existing .toLowerCase() sort (§12-13).
-- Filtering runs as static, fully-parameterized SQL; only the ORDER BY
-- column/direction is built dynamically, and only from values already
-- validated against a hardcoded whitelist a few lines above the EXECUTE --
-- no client-supplied string ever reaches format()/EXECUTE.
--
-- Zero DML. Pure SELECT. This migration only creates two functions.

-- Internal helper: ONE canonical (expense_id, label, value) row per label per
-- expense, template-sourced values winning over branch-sourced values on a
-- name clash. Takes a raw expense-id array with NO ownership check of its
-- own -- callers MUST already have scoped that array to the current user's
-- own rows. Never grant this to anon/authenticated (see REVOKE below).
CREATE OR REPLACE FUNCTION public._my_expenses_canonical_custom_fields_v1(p_expense_ids uuid[])
RETURNS TABLE(expense_id uuid, label text, value text)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT DISTINCT ON (cf.expense_id, cf.label)
    cf.expense_id, cf.label, cf.value
  FROM (
    SELECT
      v.expense_id,
      COALESCE(
        NULLIF(btrim(t.name), ''),
        NULLIF(btrim(br.name), ''),
        initcap(replace(COALESCE(t.field_key, br.field_key), '_', ' '))
      ) AS label,
      v.field_value AS value,
      (v.template_id IS NOT NULL) AS is_template
    FROM public.expense_form_field_values v
    LEFT JOIN public.expense_form_field_templates t ON t.id = v.template_id
    LEFT JOIN public.expense_form_field_option_branches br ON br.id = v.branch_field_id
    WHERE v.expense_id = ANY(p_expense_ids)
      AND NULLIF(btrim(v.field_value), '') IS NOT NULL
  ) cf
  ORDER BY cf.expense_id, cf.label, cf.is_template DESC;
$function$;

REVOKE ALL ON FUNCTION public._my_expenses_canonical_custom_fields_v1(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._my_expenses_canonical_custom_fields_v1(uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public._my_expenses_canonical_custom_fields_v1(uuid[]) FROM authenticated;

CREATE OR REPLACE FUNCTION public.get_my_expenses_page_v1(
  p_organization_id uuid,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 25,
  p_status text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_sort_by text DEFAULT 'trip_start',
  p_sort_order text DEFAULT 'desc',
  p_date_from date DEFAULT NULL,
  p_date_to_exclusive date DEFAULT NULL,
  p_custom_filters jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid         uuid := auth.uid();
  v_page        integer := GREATEST(1, COALESCE(p_page, 1));
  v_page_size   integer := LEAST(100, GREATEST(1, COALESCE(p_page_size, 25)));
  v_offset      integer;
  v_total       integer := 0;
  v_total_pages integer := 0;
  v_matched_ids uuid[];
  v_ids         uuid[];
  v_items       jsonb := '[]'::jsonb;
  v_order_sql   text;
  v_order_col   text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = p_organization_id AND om.is_active
  ) THEN
    RAISE EXCEPTION 'This expense endpoint is not available for your organization.'
      USING ERRCODE = '42501';
  END IF;

  IF p_sort_by NOT IN ('title', 'destination', 'total_amount', 'trip_start', 'created_at') THEN
    RAISE EXCEPTION 'invalid sort_by %', p_sort_by USING ERRCODE = '22023';
  END IF;
  IF p_sort_order NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'invalid sort_order %', p_sort_order USING ERRCODE = '22023';
  END IF;

  v_offset := (v_page - 1) * v_page_size;

  -- Canonical custom-field map computed ONCE for this user's own expenses
  -- (scoped_ids), then reused for BOTH the search haystack and the
  -- custom-field filter predicate -- the fix for §5/§6: a filter or a search
  -- word can now only ever match through the SAME visible (template-wins)
  -- value that the response's own `custom_fields` will display, never
  -- through a hidden losing branch value.
  WITH scoped_ids AS (
    SELECT e.id
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND e.user_id = v_uid
  ),
  canonical_cf AS (
    SELECT * FROM public._my_expenses_canonical_custom_fields_v1(
      (SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) FROM scoped_ids)
    )
  ),
  custom_search AS (
    SELECT
      expense_id,
      lower(string_agg(label || ' ' || value, ' ')) AS haystack
    FROM canonical_cf
    GROUP BY expense_id
  ),
  -- Step 1a (static, fully parameterized): every id matching status/date/
  -- search, unordered.
  base AS (
    SELECT e.id
    FROM public.expenses e
    LEFT JOIN custom_search cs ON cs.expense_id = e.id
    WHERE e.organization_id = p_organization_id
      AND e.user_id = v_uid
      AND (p_status IS NULL OR p_status = 'all' OR e.status::text = p_status)
      AND (p_date_from IS NULL OR e.trip_start >= p_date_from)
      AND (p_date_to_exclusive IS NULL OR e.trip_start < p_date_to_exclusive)
      AND (
        p_search IS NULL OR btrim(p_search) = ''
        -- Every whitespace-split word of the (lowercased) search term must be
        -- found in AT LEAST ONE of these fields -- not necessarily the same
        -- field for every word (§5-9 cross-field multi-word matching). Using
        -- NOT EXISTS(word that fails everywhere) is the SQL mirror of the
        -- client's `words.every(word => haystack.includes(word))`.
        OR NOT EXISTS (
          SELECT 1
          FROM regexp_split_to_table(lower(btrim(p_search)), '\s+') AS w(word)
          WHERE w.word <> ''
            AND strpos(lower(e.title), w.word) = 0
            AND strpos(lower(e.destination), w.word) = 0
            AND strpos(lower(COALESCE(e.purpose, '')), w.word) = 0
            AND strpos(lower(COALESCE(e.category, '')), w.word) = 0
            AND strpos(lower(e.status::text), w.word) = 0
            AND strpos(lower(COALESCE(e.transaction_number::text, '')), w.word) = 0
            AND strpos(lower(e.total_amount::text), w.word) = 0
            AND strpos(COALESCE(cs.haystack, ''), w.word) = 0
        )
      )
  )
  -- Step 1b: AND the custom-field {label, value} filters together, each
  -- checked against the SAME canonical_cf map used for search and for the
  -- final display -- one source of truth, not a separate raw-row check.
  SELECT array_agg(b.id)
  INTO v_matched_ids
  FROM base b
  WHERE (
    p_custom_filters IS NULL
    OR jsonb_array_length(p_custom_filters) = 0
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_custom_filters) AS cf(label text, value text)
      WHERE NOT EXISTS (
        SELECT 1
        FROM canonical_cf cm
        WHERE cm.expense_id = b.id
          AND cm.label = cf.label
          AND cm.value = cf.value
      )
    )
  );

  v_matched_ids := COALESCE(v_matched_ids, ARRAY[]::uuid[]);
  v_total := array_length(v_matched_ids, 1);
  IF v_total IS NULL THEN v_total := 0; END IF;
  v_total_pages := CASE WHEN v_total > 0 THEN CEIL(v_total::numeric / v_page_size::numeric)::integer ELSE 0 END;

  -- Step 2: page this SET of ids. title/destination sort case-insensitively
  -- (matching the client's .toLowerCase() sort, §12-13); every sort has a
  -- stable `id` tiebreaker so paging never duplicates or skips a row. %s
  -- inlines p_sort_order and the column expression -- both already validated
  -- above against a hardcoded whitelist, so no client-supplied text ever
  -- reaches this format() call.
  IF v_total > 0 THEN
    v_order_col := CASE
      WHEN p_sort_by IN ('title', 'destination') THEN format('lower(e.%I)', p_sort_by)
      ELSE format('e.%I', p_sort_by)
    END;
    v_order_sql := format(
      'SELECT array_agg(x.id) FROM (SELECT e.id FROM public.expenses e WHERE e.id = ANY($1) ORDER BY %s %s, e.id %s LIMIT $2 OFFSET $3) x',
      v_order_col, p_sort_order, p_sort_order
    );
    EXECUTE v_order_sql INTO v_ids USING v_matched_ids, v_page_size, v_offset;
  END IF;
  v_ids := COALESCE(v_ids, ARRAY[]::uuid[]);

  -- Enrich exactly this page's rows (never the whole filtered population) by
  -- reusing the SAME already-live enrichment RPCs the client calls today,
  -- and the SAME canonical custom-field helper used above (re-scoped to just
  -- this page's ids -- a fresh call, since plpgsql CTEs don't span statements,
  -- but textually the identical shared function, so the precedence rule can
  -- never drift between what matched the filter/search and what is shown).
  WITH resub AS (
    SELECT expense_id FROM public.get_resubmitted_expense_ids(v_ids) AS t(expense_id)
  ),
  corrected AS (
    SELECT expense_id FROM public.get_reviewer_corrected_expense_ids(v_ids, p_organization_id) AS t(expense_id)
  ),
  page_canonical_cf AS (
    SELECT * FROM public._my_expenses_canonical_custom_fields_v1(v_ids)
  ),
  custom_map AS (
    SELECT expense_id, jsonb_object_agg(label, value) AS fields
    FROM page_canonical_cf
    GROUP BY expense_id
  ),
  ordered_ids AS (
    SELECT id, ord FROM unnest(v_ids) WITH ORDINALITY AS u(id, ord)
  )
  SELECT COALESCE(jsonb_agg(row_json ORDER BY oi.ord), '[]'::jsonb)
  INTO v_items
  FROM ordered_ids oi
  JOIN LATERAL (
    SELECT jsonb_build_object(
      'id', e.id,
      'user_id', e.user_id,
      'title', e.title,
      'destination', e.destination,
      'trip_start', e.trip_start,
      'trip_end', e.trip_end,
      'status', e.status::text,
      'total_amount', e.total_amount,
      'created_at', e.created_at,
      'transaction_number', e.transaction_number,
      'purpose', e.purpose,
      'category', e.category,
      'isResubmitted', EXISTS (SELECT 1 FROM resub r WHERE r.expense_id = e.id),
      'wasReviewerCorrected', EXISTS (SELECT 1 FROM corrected c WHERE c.expense_id = e.id),
      'custom_fields', COALESCE((SELECT cm.fields FROM custom_map cm WHERE cm.expense_id = e.id), '{}'::jsonb)
    ) AS row_json
    FROM public.expenses e
    WHERE e.id = oi.id
  ) x ON true;

  RETURN jsonb_build_object(
    'items', v_items,
    'filtered_total', v_total,
    'total_pages', v_total_pages,
    'page', v_page,
    'page_size', v_page_size
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_my_expenses_page_v1(uuid, integer, integer, text, text, text, text, date, date, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_expenses_page_v1(uuid, integer, integer, text, text, text, text, date, date, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_expenses_page_v1(uuid, integer, integer, text, text, text, text, date, date, jsonb) TO authenticated;

COMMENT ON FUNCTION public.get_my_expenses_page_v1(uuid, integer, integer, text, text, text, text, date, date, jsonb) IS
  'Month filter: server-paged, server-filtered "My Expenses" list, scoped unconditionally to auth.uid() -- the caller cannot request another employee''s expenses. Authority column: expenses.trip_start (half-open p_date_from/p_date_to_exclusive). Drafts are included, matching the All-months list. Custom-field search/filter/display all share one canonical (template-wins) resolution via _my_expenses_canonical_custom_fields_v1.';

COMMENT ON FUNCTION public._my_expenses_canonical_custom_fields_v1(uuid[]) IS
  'Internal helper (no EXECUTE for anon/authenticated): ONE canonical (expense_id, label, value) row per label per expense, template-sourced values winning over branch-sourced values on a name clash. Callers MUST already scope the expense-id array to the current user''s own rows -- this function performs no ownership check of its own.';
