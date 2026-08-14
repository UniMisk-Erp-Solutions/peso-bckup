-- Create storage bucket for expense attachments
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expense-attachments',
  'expense-attachments',
  false,
  10485760, -- 10MB limit
  ARRAY['image/jpeg', 'image/jpg', 'image/png']
);

-- Create storage policies for expense attachments
CREATE POLICY "Users can upload expense attachments"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL AND
    (
      -- Allow uploads to temp folder for new expenses
      (storage.foldername(name))[1] = 'temp' AND
      (storage.foldername(name))[2] = auth.uid()::text
    ) OR
    -- Check if user has access to the expense
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id::text = (storage.foldername(name))[1]
      AND user_id = auth.uid()
    )
  );

CREATE POLICY "Users can view expense attachments"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL AND
    (
      -- Allow viewing temp files for the user
      (storage.foldername(name))[1] = 'temp' AND
      (storage.foldername(name))[2] = auth.uid()::text
    ) OR
    -- Check if user has access to the expense
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id::text = (storage.foldername(name))[1]
      AND (
        user_id = auth.uid() OR
        assigned_engineer_id = auth.uid() OR
        public.has_role(auth.uid(), 'admin')
      )
    )
  );

CREATE POLICY "Users can update their own expense attachments"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL AND
    -- Check if user owns the expense
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id::text = (storage.foldername(name))[1]
      AND user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete their own expense attachments"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL AND
    -- Check if user owns the expense
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id::text = (storage.foldername(name))[1]
      AND user_id = auth.uid()
    )
  );

-- Add a function to get signed URLs for attachments
CREATE OR REPLACE FUNCTION public.get_attachment_url(attachment_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  attachment_record RECORD;
  signed_url TEXT;
BEGIN
  -- Get attachment details
  SELECT a.*, e.user_id, e.assigned_engineer_id
  INTO attachment_record
  FROM public.attachments a
  JOIN public.expenses e ON a.expense_id = e.id
  WHERE a.id = attachment_id;
  
  -- Check if user has access
  IF NOT (
    attachment_record.uploaded_by = auth.uid() OR
    attachment_record.user_id = auth.uid() OR
    attachment_record.assigned_engineer_id = auth.uid() OR
    public.has_role(auth.uid(), 'admin')
  ) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  -- Generate signed URL (this would need to be implemented in the application layer)
  -- For now, return the file_url
  RETURN attachment_record.file_url;
END;
$$;

-- Add a function to validate file uploads
CREATE OR REPLACE FUNCTION public.validate_file_upload(
  file_name TEXT,
  file_size BIGINT,
  file_type TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  -- Check file size (10MB limit)
  IF file_size > 10485760 THEN
    RAISE EXCEPTION 'File size exceeds 10MB limit';
  END IF;
  
  -- Check file type (only images)
  IF file_type NOT IN ('image/jpeg', 'image/jpg', 'image/png') THEN
    RAISE EXCEPTION 'Only PNG and JPG image files are allowed';
  END IF;
  
  -- Check file extension
  IF LOWER(SUBSTRING(file_name FROM '\.([^.]*)$')) NOT IN ('jpg', 'jpeg', 'png') THEN
    RAISE EXCEPTION 'File extension not allowed. Only PNG and JPG files are supported';
  END IF;
  
  RETURN TRUE;
END;
$$;
