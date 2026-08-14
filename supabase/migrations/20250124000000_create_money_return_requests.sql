-- Create table to track money return requests that need cashier approval
CREATE TABLE IF NOT EXISTS public.money_return_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cashier_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
  requested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  approved_at TIMESTAMP WITH TIME ZONE,
  rejected_at TIMESTAMP WITH TIME ZONE,
  approved_by UUID REFERENCES auth.users(id),
  rejected_by UUID REFERENCES auth.users(id),
  rejection_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_money_return_requests_requester ON public.money_return_requests(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_money_return_requests_cashier ON public.money_return_requests(cashier_id, status);
CREATE INDEX IF NOT EXISTS idx_money_return_requests_pending ON public.money_return_requests(cashier_id, status) WHERE status = 'pending';

-- Enable RLS
ALTER TABLE public.money_return_requests ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own requests (as requester)
CREATE POLICY "Users can view their own return requests"
  ON public.money_return_requests FOR SELECT
  USING (auth.uid() = requester_id OR auth.uid() = cashier_id);

-- Policy: Employees and engineers can create return requests
CREATE POLICY "Employees and engineers can create return requests"
  ON public.money_return_requests FOR INSERT
  WITH CHECK (
    (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'engineer'))
    AND auth.uid() = requester_id
  );

-- Policy: Cashiers can update return requests (approve/reject)
CREATE POLICY "Cashiers can update return requests"
  ON public.money_return_requests FOR UPDATE
  USING (
    (public.has_role(auth.uid(), 'cashier') OR public.has_role(auth.uid(), 'admin'))
    AND auth.uid() = cashier_id
  );

-- Add comment
COMMENT ON TABLE public.money_return_requests IS 'Tracks money return requests from employees/engineers to cashiers. Requires cashier approval before money is transferred.';

