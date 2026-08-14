-- Create locations table
CREATE TABLE IF NOT EXISTS public.locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create engineer_locations junction table (many-to-many relationship)
CREATE TABLE IF NOT EXISTS public.engineer_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engineer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE(engineer_id, location_id)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_engineer_locations_engineer_id ON public.engineer_locations(engineer_id);
CREATE INDEX IF NOT EXISTS idx_engineer_locations_location_id ON public.engineer_locations(location_id);
CREATE INDEX IF NOT EXISTS idx_locations_name ON public.locations(name);

-- Enable RLS
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engineer_locations ENABLE ROW LEVEL SECURITY;

-- RLS Policies for locations table
-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Allow authenticated users to read locations" ON public.locations;
DROP POLICY IF EXISTS "Only admins can insert locations" ON public.locations;
DROP POLICY IF EXISTS "Only admins can update locations" ON public.locations;
DROP POLICY IF EXISTS "Only admins can delete locations" ON public.locations;

-- Allow all authenticated users to read locations
CREATE POLICY "Allow authenticated users to read locations"
  ON public.locations
  FOR SELECT
  TO authenticated
  USING (true);

-- Only admins can insert locations
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

-- Only admins can update locations
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

-- Only admins can delete locations
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

-- RLS Policies for engineer_locations table
-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Allow authenticated users to read engineer_locations" ON public.engineer_locations;
DROP POLICY IF EXISTS "Only admins can insert engineer_locations" ON public.engineer_locations;
DROP POLICY IF EXISTS "Only admins can update engineer_locations" ON public.engineer_locations;
DROP POLICY IF EXISTS "Only admins can delete engineer_locations" ON public.engineer_locations;

-- Allow all authenticated users to read engineer_locations
CREATE POLICY "Allow authenticated users to read engineer_locations"
  ON public.engineer_locations
  FOR SELECT
  TO authenticated
  USING (true);

-- Only admins can insert engineer_locations
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

-- Only admins can update engineer_locations
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

-- Only admins can delete engineer_locations
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

-- Add comment
COMMENT ON TABLE public.locations IS 'Stores location information for organizing engineers and teams';
COMMENT ON TABLE public.engineer_locations IS 'Junction table for many-to-many relationship between engineers and locations';

