-- ============================================================================
-- MASTER MIGRATION SQL FILE
-- This file combines all migration files into a single comprehensive script
-- for setting up a new Supabase project from scratch
-- ============================================================================

-- ============================================================================
-- PART 0: CLEANUP - DROP EXISTING OBJECTS
-- ============================================================================
-- This section removes all existing database objects to ensure a clean start
-- WARNING: This will delete all data and schema objects!

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

-- ============================================================================
-- PART 1: ENUMS AND TYPES
-- ============================================================================

-- Create app role enum
CREATE TYPE public.app_role AS ENUM ('admin', 'engineer', 'employee', 'cashier');

-- Create expense status enum
CREATE TYPE public.expense_status AS ENUM ('draft', 'submitted', 'under_review', 'verified', 'approved', 'rejected', 'paid');

-- Create expense category enum (expanded version)
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

-- ============================================================================
-- PART 2: CORE TABLES
-- ============================================================================

-- Create profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  balance DECIMAL(10,2) DEFAULT 0,
  reporting_engineer_id UUID REFERENCES auth.users(id),
  cashier_assigned_engineer_id UUID REFERENCES auth.users(id),
  assigned_cashier_id UUID REFERENCES auth.users(id),
  cashier_assigned_location_id UUID REFERENCES public.locations(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true
);

-- Create user_roles table
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, role)
);

-- Create expenses table
CREATE TABLE IF NOT EXISTS public.expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  trip_start DATE NOT NULL,
  trip_end DATE NOT NULL,
  destination TEXT NOT NULL,
  purpose TEXT,
  category TEXT,
  status expense_status DEFAULT 'draft' NOT NULL,
  total_amount DECIMAL(10,2) DEFAULT 0,
  assigned_engineer_id UUID REFERENCES auth.users(id),
  admin_comment TEXT,
  transaction_number TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create expense_line_items table
CREATE TABLE IF NOT EXISTS public.expense_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID REFERENCES public.expenses(id) ON DELETE CASCADE NOT NULL,
  date DATE NOT NULL,
  category public.expense_category_v2 NOT NULL,
  amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create attachments table
CREATE TABLE IF NOT EXISTS public.attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID REFERENCES public.expenses(id) ON DELETE CASCADE NOT NULL,
  line_item_id UUID REFERENCES public.expense_line_items(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  uploaded_by UUID REFERENCES auth.users(id) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create audit_logs table
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID REFERENCES public.expenses(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create expense_categories table
CREATE TABLE IF NOT EXISTS public.expense_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create settings table
CREATE TABLE IF NOT EXISTS public.settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create notifications table
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  expense_id UUID REFERENCES public.expenses(id) ON DELETE CASCADE,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create money_assignments table
CREATE TABLE IF NOT EXISTS public.money_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cashier_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  assigned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  returned_at TIMESTAMP WITH TIME ZONE,
  is_returned BOOLEAN DEFAULT FALSE,
  return_transaction_id UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create locations table
CREATE TABLE IF NOT EXISTS public.locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create engineer_locations junction table
CREATE TABLE IF NOT EXISTS public.engineer_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engineer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE(engineer_id, location_id)
);

-- Create money_return_requests table
CREATE TABLE IF NOT EXISTS public.money_return_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cashier_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  approved_at TIMESTAMP WITH TIME ZONE,
  rejected_at TIMESTAMP WITH TIME ZONE,
  approved_by UUID REFERENCES auth.users(id),
  rejected_by UUID REFERENCES auth.users(id),
  rejection_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- PART 3: INDEXES
-- ============================================================================

-- Profiles indexes
CREATE INDEX IF NOT EXISTS idx_profiles_reporting_engineer ON public.profiles(reporting_engineer_id);
CREATE INDEX IF NOT EXISTS idx_profiles_cashier_assigned_engineer ON public.profiles(cashier_assigned_engineer_id);
CREATE INDEX IF NOT EXISTS idx_profiles_assigned_cashier ON public.profiles(assigned_cashier_id);
CREATE INDEX IF NOT EXISTS idx_profiles_cashier_assigned_location ON public.profiles(cashier_assigned_location_id);

-- Expenses indexes
CREATE INDEX IF NOT EXISTS idx_expenses_transaction_number ON public.expenses(transaction_number);

-- Notifications indexes
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON public.notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON public.notifications(created_at DESC);

-- Money assignments indexes
CREATE INDEX IF NOT EXISTS idx_money_assignments_recipient ON public.money_assignments(recipient_id, is_returned);
CREATE INDEX IF NOT EXISTS idx_money_assignments_cashier ON public.money_assignments(cashier_id);
CREATE INDEX IF NOT EXISTS idx_money_assignments_active ON public.money_assignments(recipient_id, is_returned) WHERE is_returned = false;

-- Locations indexes
CREATE INDEX IF NOT EXISTS idx_engineer_locations_engineer_id ON public.engineer_locations(engineer_id);
CREATE INDEX IF NOT EXISTS idx_engineer_locations_location_id ON public.engineer_locations(location_id);
CREATE INDEX IF NOT EXISTS idx_locations_name ON public.locations(name);

-- Money return requests indexes
CREATE INDEX IF NOT EXISTS idx_money_return_requests_requester ON public.money_return_requests(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_money_return_requests_cashier ON public.money_return_requests(cashier_id, status);
CREATE INDEX IF NOT EXISTS idx_money_return_requests_pending ON public.money_return_requests(cashier_id, status) WHERE status = 'pending';

-- ============================================================================
-- PART 4: FUNCTIONS
-- ============================================================================

-- Security definer function for role checking
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- Function to handle new user profile creation
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, name, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', 'New User'),
    NEW.email
  );
  RETURN NEW;
END;
$$;

-- Function to update total_amount on expense
CREATE OR REPLACE FUNCTION public.update_expense_total()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.expenses
  SET total_amount = (
    SELECT COALESCE(SUM(amount), 0)
    FROM public.expense_line_items
    WHERE expense_id = COALESCE(NEW.expense_id, OLD.expense_id)
  ),
  updated_at = now()
  WHERE id = COALESCE(NEW.expense_id, OLD.expense_id);
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Function to automatically update notifications updated_at
CREATE OR REPLACE FUNCTION public.update_notifications_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Function to get the original cashier for a recipient
CREATE OR REPLACE FUNCTION get_original_cashier(recipient_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  original_cashier_id UUID;
BEGIN
  SELECT cashier_id INTO original_cashier_id
  FROM public.money_assignments
  WHERE recipient_id = recipient_user_id
    AND is_returned = false
  ORDER BY assigned_at ASC
  LIMIT 1;
  
  RETURN original_cashier_id;
END;
$$;

-- Function to check if a cashier can manage a specific employee
CREATE OR REPLACE FUNCTION cashier_can_manage_employee(
  cashier_user_id UUID,
  employee_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cashier_engineer_id UUID;
  cashier_location_id UUID;
  employee_engineer_id UUID;
  employee_location_id UUID;
BEGIN
  SELECT cashier_assigned_engineer_id INTO cashier_engineer_id
  FROM public.profiles
  WHERE user_id = cashier_user_id;
  
  SELECT cashier_assigned_location_id INTO cashier_location_id
  FROM public.profiles
  WHERE user_id = cashier_user_id;
  
  SELECT reporting_engineer_id INTO employee_engineer_id
  FROM public.profiles
  WHERE user_id = employee_user_id;
  
  IF cashier_engineer_id IS NULL AND cashier_location_id IS NULL THEN
    RETURN TRUE;
  END IF;
  
  IF cashier_location_id IS NOT NULL AND employee_engineer_id IS NOT NULL THEN
    SELECT location_id INTO employee_location_id
    FROM public.engineer_locations
    WHERE engineer_id = employee_engineer_id
      AND location_id = cashier_location_id
    LIMIT 1;
    
    IF employee_location_id IS NOT NULL THEN
      RETURN TRUE;
    END IF;
  END IF;
  
  IF cashier_engineer_id IS NOT NULL THEN
    RETURN cashier_engineer_id = employee_engineer_id;
  END IF;
  
  RETURN FALSE;
END;
$$;

-- Function to sync engineers with location cashier
CREATE OR REPLACE FUNCTION sync_engineers_with_location_cashier(
  location_id_param UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cashier_user_id UUID;
BEGIN
  SELECT user_id INTO cashier_user_id
  FROM public.profiles
  WHERE cashier_assigned_location_id = location_id_param
    AND EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = profiles.user_id
        AND user_roles.role = 'cashier'
    )
  LIMIT 1;
  
  IF cashier_user_id IS NOT NULL THEN
    UPDATE public.profiles
    SET cashier_assigned_engineer_id = cashier_user_id
    WHERE user_id IN (
      SELECT engineer_id
      FROM public.engineer_locations
      WHERE location_id = location_id_param
    )
    AND EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = profiles.user_id
        AND user_roles.role = 'engineer'
    );
  END IF;
END;
$$;

-- Function to find cashier for an engineer based on location
CREATE OR REPLACE FUNCTION get_cashier_for_engineer(
  engineer_user_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  cashier_user_id UUID;
  engineer_location_id UUID;
BEGIN
  SELECT location_id INTO engineer_location_id
  FROM public.engineer_locations
  WHERE engineer_id = engineer_user_id
  LIMIT 1;
  
  IF engineer_location_id IS NOT NULL THEN
    SELECT user_id INTO cashier_user_id
    FROM public.profiles
    WHERE cashier_assigned_location_id = engineer_location_id
      AND EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = profiles.user_id
          AND user_roles.role = 'cashier'
      )
    LIMIT 1;
  END IF;
  
  IF cashier_user_id IS NULL THEN
    SELECT user_id INTO cashier_user_id
    FROM public.profiles
    WHERE cashier_assigned_engineer_id = engineer_user_id
      AND EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = profiles.user_id
          AND user_roles.role = 'cashier'
      )
    LIMIT 1;
  END IF;
  
  RETURN cashier_user_id;
END;
$$;

-- Function to generate transaction number
CREATE OR REPLACE FUNCTION generate_transaction_number()
RETURNS TEXT AS $$
DECLARE
  next_num INTEGER;
  formatted_num TEXT;
BEGIN
  next_num := nextval('expense_transaction_number_seq');
  formatted_num := LPAD(next_num::TEXT, 5, '0');
  RETURN formatted_num;
END;
$$ LANGUAGE plpgsql;

-- Function to assign transaction number when expense is submitted
CREATE OR REPLACE FUNCTION assign_transaction_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'submitted' AND (OLD.status IS NULL OR OLD.status != 'submitted') AND NEW.transaction_number IS NULL THEN
    NEW.transaction_number := generate_transaction_number();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Admin reset user password function
CREATE OR REPLACE FUNCTION admin_reset_user_password(
  target_user_id UUID,
  new_password TEXT,
  admin_password TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  admin_user_id UUID;
  admin_email TEXT;
  target_user_email TEXT;
  result JSON;
BEGIN
  admin_user_id := auth.uid();
  
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_id = admin_user_id AND role = 'admin'
  ) THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Only administrators can reset passwords'
    );
  END IF;
  
  SELECT email INTO admin_email
  FROM public.profiles
  WHERE user_id = admin_user_id;
  
  IF admin_email IS NULL THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Admin user not found'
    );
  END IF;
  
  SELECT email INTO target_user_email
  FROM public.profiles
  WHERE user_id = target_user_id;
  
  IF target_user_email IS NULL THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Target user not found'
    );
  END IF;
  
  RETURN json_build_object(
    'success', true,
    'message', 'Password reset initiated',
    'target_email', target_user_email
  );
END;
$$;

-- ============================================================================
-- PART 5: TRIGGERS
-- ============================================================================

-- Trigger for automatic profile creation
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Trigger to update total_amount when line items change
DROP TRIGGER IF EXISTS update_expense_total_on_line_item ON public.expense_line_items;
CREATE TRIGGER update_expense_total_on_line_item
  AFTER INSERT OR UPDATE OR DELETE ON public.expense_line_items
  FOR EACH ROW EXECUTE FUNCTION public.update_expense_total();

-- Trigger to update notifications updated_at
DROP TRIGGER IF EXISTS update_notifications_updated_at ON public.notifications;
CREATE TRIGGER update_notifications_updated_at
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.update_notifications_updated_at();

-- Trigger to auto-assign transaction numbers
DROP TRIGGER IF EXISTS trigger_assign_transaction_number ON public.expenses;
CREATE TRIGGER trigger_assign_transaction_number
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION assign_transaction_number();

-- Trigger function to sync engineers when a cashier is assigned to a location
CREATE OR REPLACE FUNCTION trigger_sync_engineers_on_cashier_location_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = NEW.user_id
      AND user_roles.role = 'cashier'
  ) THEN
    RETURN NEW;
  END IF;
  
  IF (NEW.cashier_assigned_location_id IS DISTINCT FROM OLD.cashier_assigned_location_id) THEN
    IF NEW.cashier_assigned_location_id IS NOT NULL THEN
      PERFORM sync_engineers_with_location_cashier(NEW.cashier_assigned_location_id);
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_engineers_on_cashier_location_change ON public.profiles;
CREATE TRIGGER sync_engineers_on_cashier_location_change
  AFTER UPDATE OF cashier_assigned_location_id ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION trigger_sync_engineers_on_cashier_location_change();

-- Trigger function to sync engineers when an engineer is assigned to a location
CREATE OR REPLACE FUNCTION trigger_sync_engineer_on_location_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cashier_user_id UUID;
BEGIN
  SELECT user_id INTO cashier_user_id
  FROM public.profiles
  WHERE cashier_assigned_location_id = NEW.location_id
    AND EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = profiles.user_id
        AND user_roles.role = 'cashier'
    )
  LIMIT 1;
  
  IF cashier_user_id IS NOT NULL THEN
    UPDATE public.profiles
    SET cashier_assigned_engineer_id = cashier_user_id
    WHERE user_id = NEW.engineer_id
      AND EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = profiles.user_id
          AND user_roles.role = 'engineer'
      );
  END IF;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_engineer_on_location_assignment ON public.engineer_locations;
CREATE TRIGGER sync_engineer_on_location_assignment
  AFTER INSERT ON public.engineer_locations
  FOR EACH ROW
  EXECUTE FUNCTION trigger_sync_engineer_on_location_assignment();

-- ============================================================================
-- PART 6: SEQUENCES
-- ============================================================================

-- Create sequence for transaction numbers
CREATE SEQUENCE IF NOT EXISTS expense_transaction_number_seq START 1;

-- ============================================================================
-- PART 7: ENABLE ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.money_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engineer_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.money_return_requests ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- PART 8: REPLICA IDENTITY (for Realtime)
-- ============================================================================

ALTER TABLE public.notifications REPLICA IDENTITY FULL;
ALTER TABLE public.expenses REPLICA IDENTITY FULL;
ALTER TABLE public.profiles REPLICA IDENTITY FULL;

-- ============================================================================
-- PART 9: RLS POLICIES - PROFILES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view all profiles" ON public.profiles;
CREATE POLICY "Users can view all profiles"
  ON public.profiles FOR SELECT
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins can update any profile" ON public.profiles;
CREATE POLICY "Admins can update any profile"
  ON public.profiles FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can insert profiles" ON public.profiles;
CREATE POLICY "Admins can insert profiles"
  ON public.profiles FOR INSERT
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can delete profiles" ON public.profiles;
CREATE POLICY "Admins can delete profiles"
  ON public.profiles FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Engineers can view managed profiles" ON public.profiles;
CREATE POLICY "Engineers can view managed profiles"
  ON public.profiles FOR SELECT
  USING (
    reporting_engineer_id = auth.uid()
  );

-- ============================================================================
-- PART 10: RLS POLICIES - USER ROLES
-- ============================================================================

DROP POLICY IF EXISTS "Admins and cashiers can view all roles" ON public.user_roles;
CREATE POLICY "Admins and cashiers can view all roles"
  ON public.user_roles FOR SELECT
  USING (
    public.has_role(auth.uid(), 'admin') OR 
    public.has_role(auth.uid(), 'cashier')
  );

DROP POLICY IF EXISTS "Admins can manage roles" ON public.user_roles;
CREATE POLICY "Admins can manage roles"
  ON public.user_roles FOR ALL
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Users can view their own roles" ON public.user_roles;
CREATE POLICY "Users can view their own roles"
  ON public.user_roles FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own roles" ON public.user_roles;
CREATE POLICY "Users can insert their own roles"
  ON public.user_roles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own roles" ON public.user_roles;
CREATE POLICY "Users can update their own roles"
  ON public.user_roles FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Engineers and employees can view cashier and admin roles" ON public.user_roles;
CREATE POLICY "Engineers and employees can view cashier and admin roles"
  ON public.user_roles FOR SELECT
  USING (
    (public.has_role(auth.uid(), 'engineer') OR public.has_role(auth.uid(), 'employee'))
    AND role IN ('cashier', 'admin')
  );

DROP POLICY IF EXISTS "Cashiers can view admin roles" ON public.user_roles;
CREATE POLICY "Cashiers can view admin roles"
  ON public.user_roles FOR SELECT
  USING (
    public.has_role(auth.uid(), 'cashier')
    AND role = 'admin'
  );

-- ============================================================================
-- PART 11: RLS POLICIES - EXPENSES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own expenses" ON public.expenses;
CREATE POLICY "Users can view their own expenses"
  ON public.expenses FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Engineers can view assigned expenses" ON public.expenses;
CREATE POLICY "Engineers can view assigned expenses"
  ON public.expenses FOR SELECT
  USING (
    auth.uid() = assigned_engineer_id AND
    public.has_role(auth.uid(), 'engineer')
  );

DROP POLICY IF EXISTS "Admins can view all expenses" ON public.expenses;
CREATE POLICY "Admins can view all expenses"
  ON public.expenses FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Employees can create expenses" ON public.expenses;
CREATE POLICY "Employees can create expenses"
  ON public.expenses FOR INSERT
  WITH CHECK (
    auth.uid() = user_id AND
    (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'admin'))
  );

DROP POLICY IF EXISTS "Users can update their submitted expenses" ON public.expenses;
CREATE POLICY "Users can update their submitted expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = user_id AND
    status = 'submitted'
  )
  WITH CHECK (
    auth.uid() = user_id AND
    status = 'submitted'
  );

DROP POLICY IF EXISTS "Admins can update any expense" ON public.expenses;
CREATE POLICY "Admins can update any expense"
  ON public.expenses FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Engineers can update assigned expenses" ON public.expenses;
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

DROP POLICY IF EXISTS "Users can delete their submitted expenses" ON public.expenses;
CREATE POLICY "Users can delete their submitted expenses"
  ON public.expenses FOR DELETE
  USING (
    auth.uid() = user_id AND
    status = 'submitted'
  );

DROP POLICY IF EXISTS "Admins can delete any expense" ON public.expenses;
CREATE POLICY "Admins can delete any expense"
  ON public.expenses FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================================
-- PART 12: RLS POLICIES - EXPENSE LINE ITEMS
-- ============================================================================

DROP POLICY IF EXISTS "Users can view line items of viewable expenses" ON public.expense_line_items;
CREATE POLICY "Users can view line items of viewable expenses"
  ON public.expense_line_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = expense_line_items.expense_id
      AND (
        user_id = auth.uid() OR
        assigned_engineer_id = auth.uid() OR
        public.has_role(auth.uid(), 'admin')
      )
    )
  );

DROP POLICY IF EXISTS "Users can insert line items for their expenses" ON public.expense_line_items;
CREATE POLICY "Users can insert line items for their expenses"
  ON public.expense_line_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = expense_line_items.expense_id
      AND user_id = auth.uid()
      AND status = 'draft'
    )
  );

DROP POLICY IF EXISTS "Users can update line items for their draft expenses" ON public.expense_line_items;
CREATE POLICY "Users can update line items for their draft expenses"
  ON public.expense_line_items FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = expense_line_items.expense_id
      AND user_id = auth.uid()
      AND status = 'draft'
    )
  );

DROP POLICY IF EXISTS "Users can delete line items from their draft expenses" ON public.expense_line_items;
CREATE POLICY "Users can delete line items from their draft expenses"
  ON public.expense_line_items FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = expense_line_items.expense_id
      AND user_id = auth.uid()
      AND status = 'draft'
    )
  );

-- ============================================================================
-- PART 13: RLS POLICIES - ATTACHMENTS
-- ============================================================================

DROP POLICY IF EXISTS "Users can view attachments of viewable expenses" ON public.attachments;
CREATE POLICY "Users can view attachments of viewable expenses"
  ON public.attachments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = attachments.expense_id
      AND (
        user_id = auth.uid() OR
        assigned_engineer_id = auth.uid() OR
        public.has_role(auth.uid(), 'admin')
      )
    )
  );

DROP POLICY IF EXISTS "Users can upload attachments for their expenses" ON public.attachments;
CREATE POLICY "Users can upload attachments for their expenses"
  ON public.attachments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = attachments.expense_id
      AND user_id = auth.uid()
    ) AND uploaded_by = auth.uid()
  );

DROP POLICY IF EXISTS "Users can delete attachments for their expenses" ON public.attachments;
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

DROP POLICY IF EXISTS "Admins can delete any attachment" ON public.attachments;
CREATE POLICY "Admins can delete any attachment"
  ON public.attachments FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================================
-- PART 14: RLS POLICIES - AUDIT LOGS
-- ============================================================================

DROP POLICY IF EXISTS "Users can view audit logs of viewable expenses" ON public.audit_logs;
CREATE POLICY "Users can view audit logs of viewable expenses"
  ON public.audit_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = audit_logs.expense_id
      AND (
        user_id = auth.uid() OR
        assigned_engineer_id = auth.uid() OR
        public.has_role(auth.uid(), 'admin')
      )
    )
  );

DROP POLICY IF EXISTS "Authenticated users can create audit logs" ON public.audit_logs;
CREATE POLICY "Authenticated users can create audit logs"
  ON public.audit_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete audit logs for their expenses" ON public.audit_logs;
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

DROP POLICY IF EXISTS "Admins can delete any audit logs" ON public.audit_logs;
CREATE POLICY "Admins can delete any audit logs"
  ON public.audit_logs FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================================
-- PART 15: RLS POLICIES - EXPENSE CATEGORIES
-- ============================================================================

DROP POLICY IF EXISTS exp_cat_read ON public.expense_categories;
CREATE POLICY exp_cat_read ON public.expense_categories
FOR SELECT
USING (active = true);

DROP POLICY IF EXISTS exp_cat_admin_insert ON public.expense_categories;
CREATE POLICY exp_cat_admin_insert ON public.expense_categories
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS exp_cat_admin_update ON public.expense_categories;
CREATE POLICY exp_cat_admin_update ON public.expense_categories
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS exp_cat_admin_delete ON public.expense_categories;
CREATE POLICY exp_cat_admin_delete ON public.expense_categories
FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================================
-- PART 16: RLS POLICIES - SETTINGS
-- ============================================================================

DROP POLICY IF EXISTS "Admins can view settings" ON public.settings;
CREATE POLICY "Admins can view settings"
  ON public.settings FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Engineers can view settings" ON public.settings;
CREATE POLICY "Engineers can view settings"
  ON public.settings FOR SELECT
  USING (public.has_role(auth.uid(), 'engineer'));

DROP POLICY IF EXISTS "Authenticated users can view settings" ON public.settings;
CREATE POLICY "Authenticated users can view settings"
  ON public.settings FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Admins can update settings" ON public.settings;
CREATE POLICY "Admins can update settings"
  ON public.settings FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can insert settings" ON public.settings;
CREATE POLICY "Admins can insert settings"
  ON public.settings FOR INSERT
  USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================================
-- PART 17: RLS POLICIES - NOTIFICATIONS
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own notifications" ON public.notifications;
CREATE POLICY "Users can view their own notifications"
  ON public.notifications FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own notifications" ON public.notifications;
CREATE POLICY "Users can update their own notifications"
  ON public.notifications FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Authenticated users can create notifications" ON public.notifications;
CREATE POLICY "Authenticated users can create notifications"
  ON public.notifications FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

-- ============================================================================
-- PART 18: RLS POLICIES - MONEY ASSIGNMENTS
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own assignments" ON public.money_assignments;
CREATE POLICY "Users can view their own assignments"
  ON public.money_assignments FOR SELECT
  USING (auth.uid() = recipient_id OR auth.uid() = cashier_id);

DROP POLICY IF EXISTS "Cashiers and admins can create assignments" ON public.money_assignments;
CREATE POLICY "Cashiers and admins can create assignments"
  ON public.money_assignments FOR INSERT
  WITH CHECK (
    (public.has_role(auth.uid(), 'cashier') OR public.has_role(auth.uid(), 'admin'))
    AND auth.uid() = cashier_id
  );

DROP POLICY IF EXISTS "Cashiers and admins can update assignments" ON public.money_assignments;
CREATE POLICY "Cashiers and admins can update assignments"
  ON public.money_assignments FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'cashier') OR 
    public.has_role(auth.uid(), 'admin')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'cashier') OR 
    public.has_role(auth.uid(), 'admin')
  );

-- ============================================================================
-- PART 19: RLS POLICIES - LOCATIONS
-- ============================================================================

DROP POLICY IF EXISTS "Allow authenticated users to read locations" ON public.locations;
CREATE POLICY "Allow authenticated users to read locations"
  ON public.locations
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Only admins can insert locations" ON public.locations;
CREATE POLICY "Only admins can insert locations"
  ON public.locations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Only admins can update locations" ON public.locations;
CREATE POLICY "Only admins can update locations"
  ON public.locations
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Only admins can delete locations" ON public.locations;
CREATE POLICY "Only admins can delete locations"
  ON public.locations
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- ============================================================================
-- PART 20: RLS POLICIES - ENGINEER LOCATIONS
-- ============================================================================

DROP POLICY IF EXISTS "Allow authenticated users to read engineer_locations" ON public.engineer_locations;
CREATE POLICY "Allow authenticated users to read engineer_locations"
  ON public.engineer_locations
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Only admins can insert engineer_locations" ON public.engineer_locations;
CREATE POLICY "Only admins can insert engineer_locations"
  ON public.engineer_locations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Only admins can update engineer_locations" ON public.engineer_locations;
CREATE POLICY "Only admins can update engineer_locations"
  ON public.engineer_locations
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Only admins can delete engineer_locations" ON public.engineer_locations;
CREATE POLICY "Only admins can delete engineer_locations"
  ON public.engineer_locations
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- ============================================================================
-- PART 21: RLS POLICIES - MONEY RETURN REQUESTS
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own return requests" ON public.money_return_requests;
CREATE POLICY "Users can view their own return requests"
  ON public.money_return_requests FOR SELECT
  USING (auth.uid() = requester_id OR auth.uid() = cashier_id);

DROP POLICY IF EXISTS "Employees and engineers can create return requests" ON public.money_return_requests;
CREATE POLICY "Employees and engineers can create return requests"
  ON public.money_return_requests FOR INSERT
  WITH CHECK (
    (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'engineer'))
    AND auth.uid() = requester_id
  );

DROP POLICY IF EXISTS "Cashiers can update return requests" ON public.money_return_requests;
CREATE POLICY "Cashiers can update return requests"
  ON public.money_return_requests FOR UPDATE
  USING (
    (public.has_role(auth.uid(), 'cashier') OR public.has_role(auth.uid(), 'admin'))
    AND auth.uid() = cashier_id
  );

-- ============================================================================
-- PART 22: STORAGE BUCKETS
-- ============================================================================

-- Receipts bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'receipts',
  'receipts',
  true,
  10485760,
  ARRAY['image/jpeg', 'image/jpg', 'image/png']
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/jpeg', 'image/jpg', 'image/png'];

-- Expense attachments bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expense-attachments',
  'expense-attachments',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/jpg', 'image/png']
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- PART 23: STORAGE POLICIES - RECEIPTS BUCKET
-- ============================================================================

DROP POLICY IF EXISTS "receipts_select_policy" ON storage.objects;
CREATE POLICY "receipts_select_policy"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'receipts');

DROP POLICY IF EXISTS "receipts_insert_policy" ON storage.objects;
CREATE POLICY "receipts_insert_policy"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL
  );

DROP POLICY IF EXISTS "receipts_update_policy" ON storage.objects;
CREATE POLICY "receipts_update_policy"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL
  );

DROP POLICY IF EXISTS "receipts_delete_policy" ON storage.objects;
CREATE POLICY "receipts_delete_policy"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL
  );

-- ============================================================================
-- PART 24: STORAGE POLICIES - EXPENSE ATTACHMENTS BUCKET
-- ============================================================================

DROP POLICY IF EXISTS "Users can upload expense attachments" ON storage.objects;
CREATE POLICY "Users can upload expense attachments"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL
  );

DROP POLICY IF EXISTS "Users can view expense attachments" ON storage.objects;
CREATE POLICY "Users can view expense attachments"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL
  );

DROP POLICY IF EXISTS "Users can update their own expense attachments" ON storage.objects;
CREATE POLICY "Users can update their own expense attachments"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL
  );

DROP POLICY IF EXISTS "Users can delete their own expense attachments" ON storage.objects;
CREATE POLICY "Users can delete their own expense attachments"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL
  );

-- ============================================================================
-- PART 25: GRANT PERMISSIONS
-- ============================================================================

GRANT EXECUTE ON FUNCTION get_original_cashier TO authenticated;
GRANT EXECUTE ON FUNCTION cashier_can_manage_employee TO authenticated;
GRANT EXECUTE ON FUNCTION sync_engineers_with_location_cashier TO authenticated;
GRANT EXECUTE ON FUNCTION get_cashier_for_engineer TO authenticated;
GRANT EXECUTE ON FUNCTION admin_reset_user_password TO authenticated;

-- ============================================================================
-- PART 26: DEFAULT DATA
-- ============================================================================

-- Insert default engineer approval limit setting
INSERT INTO public.settings (key, value, description)
VALUES ('engineer_approval_limit', '50000', 'Maximum amount (in rupees) that engineers can approve directly. Expenses below this limit can be approved by engineers, above this limit must go to admin.')
ON CONFLICT (key) DO NOTHING;

-- Insert attachment required above amount setting
INSERT INTO public.settings (key, value, description)
VALUES ('attachment_required_above_amount', '50', 'Amount threshold (in rupees) above which bill attachments become mandatory. Expenses at or below this amount do not require attachments.')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- PART 27: COMMENTS
-- ============================================================================

COMMENT ON COLUMN public.expenses.category IS 'Expense category name from expense_categories table';
COMMENT ON COLUMN public.expenses.transaction_number IS 'Unique 5-digit transaction number for tracking expenses in Tally (e.g., 00001, 00002)';
COMMENT ON COLUMN public.profiles.balance IS 'Current balance of the user';
COMMENT ON COLUMN public.profiles.reporting_engineer_id IS 'Engineer assigned to manage this user';
COMMENT ON COLUMN public.profiles.cashier_assigned_engineer_id IS 'Tracks which engineer a cashier is assigned to, creating zones/departments. Cashiers can only manage employees under their assigned engineer.';
COMMENT ON COLUMN public.profiles.assigned_cashier_id IS 'Tracks which cashier an employee or engineer is assigned to. Employees and engineers return money to their assigned cashier.';
COMMENT ON COLUMN public.profiles.cashier_assigned_location_id IS 'Tracks which location a cashier is assigned to. All engineers in this location will be associated with this cashier.';
COMMENT ON TABLE public.money_assignments IS 'Tracks money flow from cashiers to employees and back, maintaining assignment history';
COMMENT ON FUNCTION get_original_cashier IS 'Returns the cashier_id who originally assigned money to a recipient, using FIFO for multiple assignments';
COMMENT ON FUNCTION cashier_can_manage_employee IS 'Checks if a cashier can manage a specific employee based on engineer assignments';
COMMENT ON TABLE public.locations IS 'Stores location information for organizing engineers and teams';
COMMENT ON TABLE public.engineer_locations IS 'Junction table for many-to-many relationship between engineers and locations';
COMMENT ON TABLE public.money_return_requests IS 'Tracks money return requests from employees/engineers to cashiers. Requires cashier approval before money is transferred.';

-- ============================================================================
-- END OF MASTER MIGRATION
-- ============================================================================
-- 
-- NOTES:
-- 1. This migration creates a complete database schema from scratch
-- 2. All RLS policies are included and properly ordered
-- 3. Storage buckets and policies are configured
-- 4. Default settings are inserted
-- 5. For Realtime to work, enable replication in Supabase Dashboard:
--    - Go to Database > Replication
--    - Enable replication for: notifications, expenses, profiles
-- 6. The 'cashier' role is included in the app_role enum
-- 7. All functions, triggers, and sequences are created
-- ============================================================================

