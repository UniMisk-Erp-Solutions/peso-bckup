-- Enable Realtime for notifications table
-- This allows real-time subscriptions to work without manual refresh

-- Enable replication for notifications table (required for Supabase Realtime)
ALTER TABLE public.notifications REPLICA IDENTITY FULL;

-- Also enable replication for expenses table (for EngineerReview real-time updates)
ALTER TABLE public.expenses REPLICA IDENTITY FULL;

-- Enable replication for profiles table (for real-time balance updates)
ALTER TABLE public.profiles REPLICA IDENTITY FULL;

-- Note: In Supabase Dashboard, you MUST also:
-- 1. Go to Database > Replication
-- 2. Enable replication for the 'notifications' table (toggle it ON)
-- 3. Optionally enable replication for the 'expenses' table
-- 
-- Without enabling replication in the dashboard, real-time subscriptions will NOT work!
-- The REPLICA IDENTITY FULL above prepares the table, but dashboard toggle is required.

