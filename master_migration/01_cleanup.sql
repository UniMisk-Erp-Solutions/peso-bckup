-- ============================================================================
-- PART 1: CLEANUP - DROP EXISTING OBJECTS
-- ============================================================================
-- This section removes all existing database objects to ensure a clean start
-- WARNING: This will delete all data and schema objects!
-- Run this file first before running 02_schema.sql and 03_policies.sql

-- Drop triggers (with error handling - tables CASCADE will also drop these, but we do it explicitly for auth.users)
DO $$ 
BEGIN
    -- Drop trigger on auth.users (always exists)
    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
    
    -- Try to drop triggers on public tables (ignore errors if tables don't exist)
    BEGIN
        DROP TRIGGER IF EXISTS update_expense_total_on_line_item ON public.expense_line_items;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    
    BEGIN
        DROP TRIGGER IF EXISTS update_notifications_updated_at ON public.notifications;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    
    BEGIN
        DROP TRIGGER IF EXISTS trigger_assign_transaction_number ON public.expenses;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    
    BEGIN
        DROP TRIGGER IF EXISTS sync_engineers_on_cashier_location_change ON public.profiles;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    
    BEGIN
        DROP TRIGGER IF EXISTS sync_engineer_on_location_assignment ON public.engineer_locations;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
END $$;

-- Drop all tables in reverse dependency order (CASCADE will drop policies automatically)
-- Wrap each drop in exception handling to avoid foreign key validation errors
DO $$ 
BEGIN
    BEGIN DROP TABLE IF EXISTS public.money_return_requests CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN DROP TABLE IF EXISTS public.engineer_locations CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN DROP TABLE IF EXISTS public.locations CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN DROP TABLE IF EXISTS public.money_assignments CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN DROP TABLE IF EXISTS public.notifications CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN DROP TABLE IF EXISTS public.settings CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN DROP TABLE IF EXISTS public.audit_logs CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN DROP TABLE IF EXISTS public.attachments CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN DROP TABLE IF EXISTS public.expense_line_items CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN DROP TABLE IF EXISTS public.expenses CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN DROP TABLE IF EXISTS public.expense_categories CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN DROP TABLE IF EXISTS public.user_roles CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN DROP TABLE IF EXISTS public.profiles CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

-- Drop storage policies (handle gracefully)
DO $$ 
DECLARE
    r RECORD;
BEGIN
    -- Drop all policies on storage.objects (only if storage.objects table exists)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'objects') THEN
        FOR r IN (SELECT policyname 
                  FROM pg_policies 
                  WHERE schemaname = 'storage' AND tablename = 'objects') 
        LOOP
            BEGIN
                EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', r.policyname);
            EXCEPTION WHEN OTHERS THEN
                -- Ignore errors
                NULL;
            END;
        END LOOP;
    END IF;
END $$;

-- Drop all functions in public schema (by querying system catalog to avoid type dependency issues)
DO $$ 
DECLARE
    r RECORD;
    func_signature TEXT;
BEGIN
    -- Drop all functions in public schema
    FOR r IN (
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args, p.oid
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
    ) 
    LOOP
        BEGIN
            func_signature := format('%I(%s)', r.proname, r.args);
            EXECUTE format('DROP FUNCTION IF EXISTS public.%s CASCADE', func_signature);
        EXCEPTION WHEN OTHERS THEN
            -- Ignore errors (e.g., if function signature references non-existent types)
            NULL;
        END;
    END LOOP;
END $$;

-- Drop all sequences
DROP SEQUENCE IF EXISTS expense_transaction_number_seq CASCADE;

-- Drop all types/enums (must be done after dropping dependent objects)
DROP TYPE IF EXISTS public.expense_category_v2 CASCADE;
DROP TYPE IF EXISTS public.expense_category CASCADE;
DROP TYPE IF EXISTS public.expense_status CASCADE;
DROP TYPE IF EXISTS public.app_role CASCADE;

-- Drop storage buckets (if they exist)
DELETE FROM storage.buckets WHERE id IN ('receipts', 'expense-attachments');

