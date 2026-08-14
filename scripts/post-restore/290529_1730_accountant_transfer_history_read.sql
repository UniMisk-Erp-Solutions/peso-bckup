-- Accountant cashiers: read-only org-wide transfer history (accounts department visibility).

CREATE POLICY "Accountant cashiers can view org transfer history"
  ON public.cash_transfer_history FOR SELECT
  USING (
    public.is_accountant_cashier(auth.uid(), organization_id)
  );
