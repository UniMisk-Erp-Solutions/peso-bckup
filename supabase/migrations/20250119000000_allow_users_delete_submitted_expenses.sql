-- Allow users to delete their own submitted expenses
-- This policy enables employees to delete expenses that are in "submitted" status
-- Verified or approved expenses cannot be deleted

CREATE POLICY "Users can delete their submitted expenses"
  ON public.expenses FOR DELETE
  USING (
    auth.uid() = user_id AND
    status = 'submitted'
  );

-- Also allow admins to delete any expense (for administrative purposes)
CREATE POLICY "Admins can delete any expense"
  ON public.expenses FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

-- Allow users to delete attachments for their own expenses
CREATE POLICY "Users can delete attachments for their expenses"
  ON public.attachments FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = attachments.expense_id
      AND user_id = auth.uid()
      AND status = 'submitted'
    )
  );

-- Allow admins to delete any attachment
CREATE POLICY "Admins can delete any attachment"
  ON public.attachments FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

-- Allow users to delete audit logs for their own expenses
CREATE POLICY "Users can delete audit logs for their expenses"
  ON public.audit_logs FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = audit_logs.expense_id
      AND user_id = auth.uid()
      AND status = 'submitted'
    )
  );

-- Allow admins to delete any audit logs
CREATE POLICY "Admins can delete any audit logs"
  ON public.audit_logs FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

COMMENT ON POLICY "Users can delete their submitted expenses" ON public.expenses IS 
  'Allows users to delete their own expenses that are in submitted status. Verified or approved expenses cannot be deleted.';

COMMENT ON POLICY "Admins can delete any expense" ON public.expenses IS 
  'Allows administrators to delete any expense for administrative purposes.';

