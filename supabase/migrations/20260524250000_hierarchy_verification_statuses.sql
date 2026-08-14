-- Part 1/2: Add enum values only. Must run in its own migration (committed) before part 2.
-- PostgreSQL error 55P04 if new enum values are used in the same transaction.

ALTER TYPE public.expense_status ADD VALUE IF NOT EXISTS 'level_1_verified';
ALTER TYPE public.expense_status ADD VALUE IF NOT EXISTS 'level_2_verified';
