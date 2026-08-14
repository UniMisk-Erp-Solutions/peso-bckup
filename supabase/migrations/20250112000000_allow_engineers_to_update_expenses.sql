-- Allow engineers to update expenses assigned to them
-- This enables engineers to verify expenses (change status from 'submitted' to 'verified')
-- Engineers can only update expenses that are currently 'submitted' and can set them to 'verified'

CREATE POLICY "Engineers can update assigned expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = assigned_engineer_id AND
    public.has_role(auth.uid(), 'engineer') AND
    status = 'submitted'
  )
  WITH CHECK (
    auth.uid() = assigned_engineer_id AND
    public.has_role(auth.uid(), 'engineer') AND
    status = 'verified'
  );

