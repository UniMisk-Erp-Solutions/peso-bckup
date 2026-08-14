-- Clear all data for deployment while keeping users and schema intact
-- This migration removes all expense-related data, notifications, money transactions
-- but preserves: users, profiles, user_roles, settings, locations, expense_categories

-- Disable foreign key checks temporarily for faster deletion
-- Note: We'll delete in order to respect foreign key constraints

-- 1. Delete all notifications (no dependencies)
DELETE FROM public.notifications;

-- 2. Delete all money return requests (no dependencies on expenses)
DELETE FROM public.money_return_requests;

-- 3. Delete all money assignments (no dependencies on expenses)
DELETE FROM public.money_assignments;

-- 4. Delete all audit logs (depends on expenses, but we'll delete expenses next)
-- Actually, expenses cascade delete audit_logs, but let's be explicit
DELETE FROM public.audit_logs;

-- 5. Delete all attachments (depends on expenses, but we'll delete expenses next)
-- Actually, expenses cascade delete attachments, but let's be explicit
DELETE FROM public.attachments;

-- 6. Delete all expense line items (depends on expenses)
-- Actually, expenses cascade delete expense_line_items, but let's be explicit
DELETE FROM public.expense_line_items;

-- 7. Delete all expenses (this will cascade delete related records)
DELETE FROM public.expenses;

-- 8. Reset all user balances to 0 (keep users but reset their balances)
UPDATE public.profiles
SET balance = 0
WHERE balance IS NOT NULL AND balance != 0;

-- Note: The following are preserved:
-- - auth.users (all user accounts)
-- - public.profiles (user profiles, balances reset to 0)
-- - public.user_roles (all role assignments)
-- - public.settings (all system settings)
-- - public.locations (all location data)
-- - public.expense_categories (all category definitions)
-- - public.engineer_locations (engineer location assignments)

-- Verify deletion (optional - can be commented out)
-- SELECT 
--   (SELECT COUNT(*) FROM public.expenses) as expenses_count,
--   (SELECT COUNT(*) FROM public.attachments) as attachments_count,
--   (SELECT COUNT(*) FROM public.audit_logs) as audit_logs_count,
--   (SELECT COUNT(*) FROM public.notifications) as notifications_count,
--   (SELECT COUNT(*) FROM public.money_assignments) as money_assignments_count,
--   (SELECT COUNT(*) FROM public.money_return_requests) as money_return_requests_count,
--   (SELECT COUNT(*) FROM public.profiles) as profiles_count,
--   (SELECT COUNT(*) FROM public.user_roles) as user_roles_count;

