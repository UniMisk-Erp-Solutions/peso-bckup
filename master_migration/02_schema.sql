-- ============================================================================
-- PART 2: SCHEMA CREATION
-- ============================================================================
-- This file creates all database schema objects: types, tables, functions, triggers, sequences
-- Run this file after 01_cleanup.sql and before 03_policies.sql

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
-- PART 2: CORE TABLES (in dependency order)
-- ============================================================================

-- Create locations table FIRST (profiles references it)
CREATE TABLE IF NOT EXISTS public.locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create profiles table (references locations)
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

-- Create engineer_locations junction table (references locations)
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

