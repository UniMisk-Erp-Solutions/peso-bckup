-- Expand expense_category enum to support general expenses
-- Safe pattern: create new enum, alter columns, drop old enum

DO $$
BEGIN
  -- 1) Create new enum if not exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'expense_category_v2' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.expense_category_v2 AS ENUM (
      'travel',
      'lodging',
      'food',
      'transport',
      'office_supplies',
      'software',
      'utilities',
      'marketing',
      'training',
      'health_wellness',
      'equipment',
      'mileage',
      'internet_phone',
      'entertainment',
      'professional_services',
      'rent',
      'other'
    );
  END IF;

  -- 2) Alter dependent columns to new enum
  ALTER TABLE public.expense_line_items
    ALTER COLUMN category TYPE public.expense_category_v2 USING category::text::public.expense_category_v2;

  -- 3) Replace constants table if needed is handled on client (regen types)

  -- 4) Drop old enum if no longer used
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'expense_category' AND n.nspname = 'public'
  ) THEN
    -- Only drop if no columns depend on it
    PERFORM 1 FROM information_schema.columns
      WHERE udt_schema = 'public' AND udt_name = 'expense_category' LIMIT 1;
    IF NOT FOUND THEN
      DROP TYPE public.expense_category;
    END IF;
  END IF;
END $$;


