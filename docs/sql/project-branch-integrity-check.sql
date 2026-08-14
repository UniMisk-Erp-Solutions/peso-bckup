-- =============================================================================
-- Project Branch Integrity — Read-Only Health Checks
-- DOC-047  2026-07-07
--
-- PURPOSE
--   Verify the state of expense_form_field_option_branches for the Project
--   template after migration 290707_3000_branch_config_atomic_save.sql is
--   applied.  All queries are SELECT-only and safe to run at any time on the
--   live database.
--
-- RUN IN:  Supabase SQL editor (project avrbgpmzabktqwyzqibq)
--          Role: postgres (service-role)
--
-- SECTIONS
--   1. Active-row summary
--   2. Completeness check — every parent option must have both project_id
--      and project_name root branches
--   3. Orphan check — active branches whose parent option is absent from
--      the template options array
--   4. Retired-row audit — how many rows were retired and when
--   5. Stale-edit risk — template updated_at vs most-recent audit revision
--   6. Duplicate active root branches — should be zero after atomic save
--   7. Nested branches health
--   8. Manual recovery guide (comment block)
-- =============================================================================

-- ── 0. Constants ────────────────────────────────────────────────────────────
-- Change this if the template UUID ever differs.
\set project_template_id '51181324-68cc-4174-bbe0-4834e5e22c48'

-- =============================================================================
-- SECTION 1 — Active-row summary
-- =============================================================================
SELECT
  COUNT(*)                                        AS total_active_branches,
  COUNT(*) FILTER (WHERE parent_branch_id IS NULL) AS root_branches,
  COUNT(*) FILTER (WHERE parent_branch_id IS NOT NULL) AS nested_branches,
  COUNT(DISTINCT parent_option_value)             AS distinct_parent_options
FROM expense_form_field_option_branches
WHERE parent_template_id = :'project_template_id'
  AND retired_at IS NULL;

-- Expected: total = 2 × distinct_parent_options (one project_id + one
-- project_name root branch per option).  If total < 2 × distinct, some
-- parent options are incomplete.

-- =============================================================================
-- SECTION 2 — Completeness: parent options missing project_id or project_name
-- =============================================================================
WITH active AS (
  SELECT parent_option_value, field_key
  FROM expense_form_field_option_branches
  WHERE parent_template_id = :'project_template_id'
    AND parent_branch_id   IS NULL
    AND retired_at         IS NULL
),
required AS (
  SELECT unnest(ARRAY['project_id', 'project_name']) AS required_key
),
options AS (
  SELECT DISTINCT parent_option_value FROM active
)
SELECT
  o.parent_option_value,
  r.required_key,
  CASE WHEN a.field_key IS NULL THEN 'MISSING' ELSE 'ok' END AS status
FROM options o
CROSS JOIN required r
LEFT JOIN active a
  ON a.parent_option_value = o.parent_option_value
 AND a.field_key            = r.required_key
WHERE a.field_key IS NULL
ORDER BY o.parent_option_value, r.required_key;

-- Expected: 0 rows.  Any row here is a parent option that will trigger a
-- project_integrity error in the RPC if re-saved without fixing first.

-- =============================================================================
-- SECTION 3 — Orphan branches (parent option absent from template options)
-- =============================================================================
WITH template_opts AS (
  SELECT jsonb_array_elements_text(options) AS opt
  FROM expense_form_field_templates
  WHERE id = :'project_template_id'
)
SELECT
  b.id,
  b.parent_option_value,
  b.field_key,
  b.name,
  b.created_at
FROM expense_form_field_option_branches b
WHERE b.parent_template_id = :'project_template_id'
  AND b.retired_at         IS NULL
  AND b.parent_option_value NOT IN (SELECT opt FROM template_opts)
ORDER BY b.parent_option_value, b.field_key;

-- Expected: 0 rows.  Orphan branches exist when the template's options array
-- was edited but the atomic RPC was not called, or when rows were inserted
-- manually without updating the template options column.

-- =============================================================================
-- SECTION 4 — Retired-row audit
-- =============================================================================
SELECT
  DATE_TRUNC('day', retired_at) AS retired_day,
  retired_reason,
  COUNT(*)                       AS rows_retired,
  COUNT(DISTINCT retired_by)     AS distinct_retirer_uids
FROM expense_form_field_option_branches
WHERE parent_template_id = :'project_template_id'
  AND retired_at IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;

-- Expected after first atomic save: rows equal to branches that were present
-- before the save but absent from the new payload.  retired_reason = 'absent
-- from save payload'.

-- =============================================================================
-- SECTION 5 — Stale-edit risk (last revision vs template updated_at)
-- =============================================================================
SELECT
  t.updated_at                          AS template_updated_at,
  r.created_at                          AS last_revision_at,
  r.source                              AS last_revision_source,
  r.branches_inserted,
  r.branches_updated,
  r.branches_retired,
  CASE
    WHEN r.created_at IS NULL         THEN 'NO REVISION YET (migration not applied or RPC not yet called)'
    WHEN r.created_at < t.updated_at  THEN 'STALE — template was modified after the last atomic save'
    ELSE 'ok'
  END                                   AS stale_status
FROM expense_form_field_templates t
LEFT JOIN LATERAL (
  SELECT *
  FROM expense_form_field_branch_config_revisions
  WHERE template_id = t.id
  ORDER BY created_at DESC
  LIMIT 1
) r ON TRUE
WHERE t.id = :'project_template_id';

-- Expected: stale_status = 'ok'.  A 'NO REVISION YET' result means the atomic
-- RPC has never been called for this template (migration applied but not yet
-- exercised through the UI).

-- =============================================================================
-- SECTION 6 — Duplicate active root branches (must be zero)
-- =============================================================================
SELECT
  parent_option_value,
  field_key,
  COUNT(*) AS duplicates
FROM expense_form_field_option_branches
WHERE parent_template_id = :'project_template_id'
  AND parent_branch_id   IS NULL
  AND retired_at         IS NULL
GROUP BY parent_option_value, field_key
HAVING COUNT(*) > 1
ORDER BY duplicates DESC;

-- Expected: 0 rows.  The partial unique index
-- idx_option_branches_root_field_key_active prevents duplicates after the
-- migration.  If rows appear here the migration may not have been applied.

-- =============================================================================
-- SECTION 7 — Nested branches health
-- =============================================================================
-- 7a. Nested branches whose parent branch is itself retired or missing
SELECT
  c.id                        AS child_id,
  c.parent_option_value,
  c.field_key                 AS child_key,
  c.parent_branch_id,
  p.id                        AS parent_exists,
  p.retired_at IS NOT NULL    AS parent_retired
FROM expense_form_field_option_branches c
LEFT JOIN expense_form_field_option_branches p
  ON p.id = c.parent_branch_id
WHERE c.parent_template_id = :'project_template_id'
  AND c.parent_branch_id   IS NOT NULL
  AND c.retired_at         IS NULL
  AND (p.id IS NULL OR p.retired_at IS NOT NULL)
ORDER BY c.parent_option_value;

-- Expected: 0 rows.  Any row means an active nested branch is orphaned from
-- its retired/deleted parent — the RPC would retire these in the next atomic
-- save that covers this parent_option_value.

-- 7b. Nesting depth summary
SELECT
  CASE
    WHEN parent_branch_id IS NULL THEN 'depth_1 (root)'
    ELSE                               'depth_2+ (nested)'
  END                 AS depth,
  COUNT(*)            AS active_count
FROM expense_form_field_option_branches
WHERE parent_template_id = :'project_template_id'
  AND retired_at         IS NULL
GROUP BY 1;

-- =============================================================================
-- SECTION 8 — MANUAL RECOVERY GUIDE (read-only context; no DML in this file)
-- =============================================================================
/*
  IF any of the above checks indicate a problem, use the following steps:

  STEP A — Identify which parent options are incomplete
    Run Section 2.  Note the parent_option_value values that have MISSING rows.

  STEP B — Re-populate via the atomic RPC (preferred)
    Open the CategoryManagement UI as an org admin.
    Edit the Project template.
    Click Save without making changes — the RPC will reconcile active branches
    against the current branchDrafts state and retire/insert as needed.
    This is the safest path because it goes through all 13 validation steps.

  STEP C — Emergency SQL recovery (use only if the UI is unavailable)
    Run the idempotent re-population CTE from:
      docs/sql/batch-review-production-verification.sql
    That CTE uses ON CONFLICT ... DO UPDATE so it is safe to run multiple times.
    It only inserts project_id and project_name root branches.
    It does NOT write audit rows to expense_form_field_branch_config_revisions.

    After running the CTE:
      - Verify with Section 1 and 2 of this file.
      - The next atomic save via the UI will write a proper audit row.

  STEP D — If retired rows need to be un-retired (rare)
    Only do this in the Supabase SQL editor as postgres (service role):

      UPDATE expense_form_field_option_branches
      SET retired_at = NULL, retired_by = NULL, retired_reason = NULL
      WHERE id IN ('<uuid1>', '<uuid2>')  -- IDs from the retired audit
        AND parent_template_id = '51181324-68cc-4174-bbe0-4834e5e22c48';

    Then verify with this script.  Do NOT un-retire without understanding why
    the row was retired — it may have been intentionally removed.

  STEP E — If the unique index blocks re-insertion
    After migration 290707_3000_branch_config_atomic_save.sql, the active index:
      idx_option_branches_root_field_key_active
    allows multiple rows for the same (template, option, field_key) as long as
    all but one are retired.  If a re-insertion is blocked, it means a
    non-retired duplicate already exists — resolve by retiring the duplicate:

      UPDATE expense_form_field_option_branches
      SET retired_at = now(), retired_by = auth.uid(), retired_reason = 'manual-dedup'
      WHERE id = '<duplicate_id>';

  CONTACT: Report persistent integrity failures to the engineering team with
  the output of all 7 sections above and the relevant revision_id from
  expense_form_field_branch_config_revisions.
*/

-- =============================================================================
-- END OF FILE
-- =============================================================================
