-- Allow users to move their own expense from `draft` -> `submitted`
-- Some environments/orgs may have missing/incorrect RLS policies due to migration order.
-- This policy is minimal: ownership + current status.
DO $$
BEGIN
  IF to_regclass('public.expenses') IS NULL THEN
    RETURN;
  END IF;

  DROP POLICY IF EXISTS "Users can submit their draft expenses" ON public.expenses;

  CREATE POLICY "Users can submit their draft expenses"
    ON public.expenses
    FOR UPDATE
    USING (
      auth.uid() = user_id AND
      status = 'draft'
    )
    WITH CHECK (
      auth.uid() = user_id AND
      status = 'submitted'
    );
END $$;

