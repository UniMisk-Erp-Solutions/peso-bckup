-- DOC-148 post-deploy monitor. READ-ONLY: SELECT only, no repair. Run daily for 7 days:
--   psql ... -f monitor_stranded_drafts.sql      (inside BEGIN READ ONLY if you like)
-- "Rollout" is the timestamp the stranded-draft fix reached Production; set it below.
\set rollout '''2026-10-26 00:00:00+00'''

\echo '## 1. new live drafts since rollout, by origin (save_draft receipt = intentional)'
SELECT o.name AS org,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM expense_submission_receipts r WHERE r.expense_id = e.id AND r.action = 'save_draft')) AS intentional_save_draft,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM audit_logs a WHERE a.expense_id = e.id AND a.action = 'expense_withdrawn')) AS withdrawn,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM expense_submission_receipts r WHERE r.expense_id = e.id AND r.action = 'save_draft')
                          AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.expense_id = e.id AND a.action = 'expense_withdrawn')) AS legacy_never_submitted
FROM expenses e JOIN organizations o ON o.id = e.organization_id
WHERE e.status = 'draft' AND e.deleted_at IS NULL AND e.created_at >= :rollout
GROUP BY 1 ORDER BY 1;

\echo '## 2. live drafts older than 15 minutes that were NOT an intentional save_draft/withdraw (the stranded signature)'
SELECT left(e.id::text, 8) AS draft, o.name AS org, to_char(e.created_at, 'MM-DD HH24:MI:SS') AS created,
       round(extract(epoch FROM now() - e.created_at) / 60) AS age_min, e.total_amount, left(e.category, 14) AS category,
       (SELECT count(*) FROM attachments a WHERE a.expense_id = e.id AND a.deleted_at IS NULL) AS att,
       (SELECT count(*) FROM expense_form_field_values v WHERE v.expense_id = e.id) AS cfv
FROM expenses e JOIN organizations o ON o.id = e.organization_id
WHERE e.status = 'draft' AND e.deleted_at IS NULL AND e.created_at >= :rollout
  AND e.created_at < now() - interval '15 minutes'
  AND NOT EXISTS (SELECT 1 FROM expense_submission_receipts r WHERE r.expense_id = e.id AND r.action = 'save_draft')
  AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.expense_id = e.id AND a.action = 'expense_withdrawn')
ORDER BY e.created_at;

\echo '## 3. draft + later submitted sibling (same user, score>=9) created since rollout = a re-submit pair'
WITH d AS (SELECT * FROM expenses WHERE status = 'draft' AND deleted_at IS NULL AND created_at >= :rollout)
SELECT left(d.id::text, 8) AS draft, left(s.id::text, 8) AS sibling, s.status AS sibling_status,
       round(extract(epoch FROM s.created_at - d.created_at)) AS secs_later
FROM d JOIN expenses s ON s.user_id = d.user_id AND s.id <> d.id AND s.status <> 'draft' AND s.deleted_at IS NULL
 AND s.created_at BETWEEN d.created_at AND d.created_at + interval '24 hours'
 AND s.total_amount = d.total_amount AND s.category IS NOT DISTINCT FROM d.category AND s.trip_start = d.trip_start
 AND coalesce(s.destination, '') = coalesce(d.destination, '') AND coalesce(s.title, '') = coalesce(d.title, '')
ORDER BY d.created_at;

\echo '## 4. duplicate amount/date/title groups among rows created since rollout (any status except trashed)'
SELECT left(user_id::text, 6) AS usr, total_amount, trip_start, left(title, 30) AS title, count(*) AS rows_in_group,
       string_agg(status::text, ',' ORDER BY created_at) AS statuses
FROM expenses WHERE created_at >= :rollout AND deleted_at IS NULL
GROUP BY user_id, total_amount, trip_start, title HAVING count(*) > 1 AND bool_or(status = 'draft')
ORDER BY 1;

\echo '## 5. mixed batch status (draft child + non-draft live sibling)'
SELECT left(e.batch_id::text, 8) AS batch, count(*) FILTER (WHERE e.status = 'draft') AS drafts,
       count(*) FILTER (WHERE e.status <> 'draft') AS others
FROM expenses e WHERE e.batch_id IS NOT NULL AND e.deleted_at IS NULL
GROUP BY e.batch_id HAVING count(*) FILTER (WHERE e.status = 'draft') > 0 AND count(*) FILTER (WHERE e.status <> 'draft') > 0;

\echo '## 6. batches created since rollout whose children are NOT attached (should be 0 children missing once linking works)'
SELECT date_trunc('day', b.created_at)::date AS day, count(DISTINCT b.id) AS batches,
       count(DISTINCT b.id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM expenses e WHERE e.batch_id = b.id)) AS batches_without_children
FROM expense_batches b WHERE b.created_at >= :rollout AND b.line_count > 0 GROUP BY 1 ORDER BY 1;

\echo '## 7. receipt vs actual status mismatch (submit receipt but row still draft, not withdrawn)'
SELECT count(*) AS mismatches
FROM expense_submission_receipts r JOIN expenses e ON e.id = r.expense_id
WHERE e.status = 'draft' AND r.action IN ('submit', 'update_submitted') AND r.committed_at >= :rollout
  AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.expense_id = e.id AND a.action = 'expense_withdrawn');
