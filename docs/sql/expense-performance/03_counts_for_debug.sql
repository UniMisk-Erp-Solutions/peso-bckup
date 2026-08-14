-- ============================================================
-- FILE: 03_counts_for_debug.sql
-- PURPOSE: Quick counts to understand expense volume per org,
--          per user, and per status. No manual substitution needed —
--          org_id is auto-selected from the expenses table.
-- ============================================================

-- 1. Total expenses per status (org-wide)
SELECT
  status,
  COUNT(*) AS cnt
FROM public.expenses
WHERE organization_id = (
  SELECT organization_id FROM public.expenses
  GROUP BY organization_id ORDER BY COUNT(*) DESC LIMIT 1
)
GROUP BY status
ORDER BY cnt DESC;


-- 2. Top 20 users by expense count
SELECT
  e.user_id,
  p.name,
  p.employee_id,
  COUNT(*) AS expense_count
FROM public.expenses e
LEFT JOIN public.profiles p ON p.user_id = e.user_id
WHERE e.organization_id = (
  SELECT organization_id FROM public.expenses
  GROUP BY organization_id ORDER BY COUNT(*) DESC LIMIT 1
)
GROUP BY e.user_id, p.name, p.employee_id
ORDER BY expense_count DESC
LIMIT 20;


-- 3. Expenses created in the last 30 days
SELECT
  DATE(created_at) AS day,
  COUNT(*) AS cnt
FROM public.expenses
WHERE organization_id = (
  SELECT organization_id FROM public.expenses
  GROUP BY organization_id ORDER BY COUNT(*) DESC LIMIT 1
)
  AND created_at >= NOW() - INTERVAL '30 days'
GROUP BY day
ORDER BY day DESC;


-- 4. Batch counts (total batches, avg size)
SELECT
  COUNT(DISTINCT batch_id)                         AS total_batches,
  COUNT(*) FILTER (WHERE batch_id IS NOT NULL)     AS expenses_in_batches,
  ROUND(AVG(batch_size), 1)                        AS avg_batch_size
FROM (
  SELECT batch_id, COUNT(*) AS batch_size
  FROM public.expenses
  WHERE organization_id = (
    SELECT organization_id FROM public.expenses
    GROUP BY organization_id ORDER BY COUNT(*) DESC LIMIT 1
  )
    AND batch_id IS NOT NULL
  GROUP BY batch_id
) sub;
