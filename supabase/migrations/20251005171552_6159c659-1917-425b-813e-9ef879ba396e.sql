-- Create app role enum
CREATE TYPE public.app_role AS ENUM ('admin', 'engineer', 'employee');

-- Create expense status enum
CREATE TYPE public.expense_status AS ENUM ('draft', 'submitted', 'under_review', 'verified', 'approved', 'rejected', 'paid');

-- Create expense category enum
CREATE TYPE public.expense_category AS ENUM ('travel', 'lodging', 'food', 'other');

-- Create profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true
);

-- Create user_roles table
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, role)
);

-- Create expenses table
CREATE TABLE public.expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  trip_start DATE NOT NULL,
  trip_end DATE NOT NULL,
  destination TEXT NOT NULL,
  purpose TEXT,
  status expense_status DEFAULT 'draft' NOT NULL,
  total_amount DECIMAL(10,2) DEFAULT 0,
  assigned_engineer_id UUID REFERENCES auth.users(id),
  admin_comment TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create expense_line_items table
CREATE TABLE public.expense_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID REFERENCES public.expenses(id) ON DELETE CASCADE NOT NULL,
  date DATE NOT NULL,
  category expense_category NOT NULL,
  amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create attachments table
CREATE TABLE public.attachments (
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
CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID REFERENCES public.expenses(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Create security definer function for role checking
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

-- Create function to handle new user profile creation
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

-- Trigger for automatic profile creation
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

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

-- Trigger to update total_amount when line items change
CREATE TRIGGER update_expense_total_on_line_item
  AFTER INSERT OR UPDATE OR DELETE ON public.expense_line_items
  FOR EACH ROW EXECUTE FUNCTION public.update_expense_total();

-- RLS Policies for profiles
CREATE POLICY "Users can view all profiles"
  ON public.profiles FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = user_id);

-- RLS Policies for user_roles
CREATE POLICY "Admins can view all roles"
  ON public.user_roles FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage roles"
  ON public.user_roles FOR ALL
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can view their own roles"
  ON public.user_roles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own roles"
  ON public.user_roles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own roles"
  ON public.user_roles FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- RLS Policies for expenses
CREATE POLICY "Users can view their own expenses"
  ON public.expenses FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Engineers can view assigned expenses"
  ON public.expenses FOR SELECT
  USING (
    auth.uid() = assigned_engineer_id AND
    public.has_role(auth.uid(), 'engineer')
  );

CREATE POLICY "Admins can view all expenses"
  ON public.expenses FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Employees can create expenses"
  ON public.expenses FOR INSERT
  WITH CHECK (
    auth.uid() = user_id AND
    (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'admin'))
  );

CREATE POLICY "Users can update their draft expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = user_id AND
    status = 'draft'
  );

CREATE POLICY "Admins can update any expense"
  ON public.expenses FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

-- RLS Policies for expense_line_items
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

-- RLS Policies for attachments
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

CREATE POLICY "Users can upload attachments for their expenses"
  ON public.attachments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = attachments.expense_id
      AND user_id = auth.uid()
    ) AND uploaded_by = auth.uid()
  );

-- RLS Policies for audit_logs
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

CREATE POLICY "Authenticated users can create audit logs"
  ON public.audit_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Create storage bucket for receipts
INSERT INTO storage.buckets (id, name, public)
VALUES ('receipts', 'receipts', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for receipts
CREATE POLICY "Users can view receipts for their viewable expenses"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL
  );

CREATE POLICY "Users can upload receipts"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL
  );

CREATE POLICY "Users can update their receipts"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'receipts' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Users can delete their receipts"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'receipts' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );