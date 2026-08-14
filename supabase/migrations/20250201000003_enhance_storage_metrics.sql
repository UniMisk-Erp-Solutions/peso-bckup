-- ============================================================================
-- ENHANCED STORAGE METRICS FOR MASTER ADMIN
-- ============================================================================
-- This migration enhances the storage metrics function to provide more
-- detailed information similar to Supabase dashboard
-- ============================================================================

-- Enhanced function to get detailed storage metrics
CREATE OR REPLACE FUNCTION get_detailed_storage_metrics()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  db_size_bytes BIGINT;
  storage_size_bytes BIGINT;
  total_size_bytes BIGINT;
  table_sizes JSONB;
  bucket_sizes JSONB;
  attachment_size_bytes BIGINT;
  receipt_size_bytes BIGINT;
  total_users INTEGER;
  total_expenses INTEGER;
  total_organizations INTEGER;
BEGIN
  -- Only master admins can call this
  IF NOT is_master_admin() THEN
    RAISE EXCEPTION 'Only master admins can view storage metrics';
  END IF;

  -- Option A: Database size (total)
  SELECT pg_database_size('postgres') INTO db_size_bytes;
  
  -- Get table sizes breakdown
  SELECT jsonb_agg(
    jsonb_build_object(
      'table_name', schemaname||'.'||tablename,
      'size_bytes', pg_total_relation_size(schemaname||'.'||tablename),
      'size_gb', ROUND(pg_total_relation_size(schemaname||'.'||tablename) / 1024.0 / 1024.0 / 1024.0, 4)
    ) ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
  ) INTO table_sizes
  FROM pg_tables
  WHERE schemaname = 'public'
  LIMIT 20; -- Top 20 largest tables
  
  -- Option B: Storage buckets breakdown
  SELECT jsonb_agg(
    jsonb_build_object(
      'bucket_id', bucket_id,
      'size_bytes', SUM((metadata->>'size')::bigint),
      'size_gb', ROUND(SUM((metadata->>'size')::bigint) / 1024.0 / 1024.0 / 1024.0, 4),
      'file_count', COUNT(*)
    )
  ) INTO bucket_sizes
  FROM storage.objects
  GROUP BY bucket_id;
  
  -- Total storage from buckets
  SELECT COALESCE(SUM((metadata->>'size')::bigint), 0) INTO storage_size_bytes
  FROM storage.objects;
  
  -- Get specific bucket sizes
  SELECT COALESCE(SUM((metadata->>'size')::bigint), 0) INTO attachment_size_bytes
  FROM storage.objects
  WHERE bucket_id = 'attachments';
  
  SELECT COALESCE(SUM((metadata->>'size')::bigint), 0) INTO receipt_size_bytes
  FROM storage.objects
  WHERE bucket_id = 'receipts';
  
  total_size_bytes := db_size_bytes + storage_size_bytes;
  
  -- Get additional statistics
  SELECT COUNT(*) INTO total_users FROM public.organization_memberships WHERE is_active = true;
  SELECT COUNT(*) INTO total_expenses FROM public.expenses;
  SELECT COUNT(*) INTO total_organizations FROM public.organizations;
  
  -- Return comprehensive JSON with all metrics
  RETURN jsonb_build_object(
    'database_size_gb', ROUND(db_size_bytes / 1024.0 / 1024.0 / 1024.0, 4),
    'storage_size_gb', ROUND(storage_size_bytes / 1024.0 / 1024.0 / 1024.0, 4),
    'total_size_gb', ROUND(total_size_bytes / 1024.0 / 1024.0 / 1024.0, 4),
    'database_size_bytes', db_size_bytes,
    'storage_size_bytes', storage_size_bytes,
    'total_size_bytes', total_size_bytes,
    'table_sizes', COALESCE(table_sizes, '[]'::jsonb),
    'bucket_sizes', COALESCE(bucket_sizes, '[]'::jsonb),
    'attachment_size_gb', ROUND(attachment_size_bytes / 1024.0 / 1024.0 / 1024.0, 4),
    'receipt_size_gb', ROUND(receipt_size_bytes / 1024.0 / 1024.0 / 1024.0, 4),
    'statistics', jsonb_build_object(
      'total_users', total_users,
      'total_expenses', total_expenses,
      'total_organizations', total_organizations
    )
  );
END;
$$;

-- Function to get per-organization storage breakdown
CREATE OR REPLACE FUNCTION get_organization_storage_breakdown()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  org_storage JSONB;
BEGIN
  -- Only master admins can call this
  IF NOT is_master_admin() THEN
    RAISE EXCEPTION 'Only master admins can view organization storage';
  END IF;

  -- Get storage per organization (from attachments table if it has organization_id)
  SELECT jsonb_agg(
    jsonb_build_object(
      'organization_id', org.id,
      'organization_name', org.name,
      'user_count', (
        SELECT COUNT(*) FROM organization_memberships 
        WHERE organization_id = org.id AND is_active = true
      ),
      'expense_count', (
        SELECT COUNT(*) FROM expenses 
        WHERE organization_id = org.id
      ),
      'attachment_size_bytes', COALESCE((
        SELECT SUM(file_size) FROM attachments 
        WHERE organization_id = org.id
      ), 0),
      'attachment_size_gb', ROUND(
        COALESCE((
          SELECT SUM(file_size) FROM attachments 
          WHERE organization_id = org.id
        ), 0) / 1024.0 / 1024.0 / 1024.0, 4
      )
    ) ORDER BY org.name
  ) INTO org_storage
  FROM organizations org;
  
  RETURN COALESCE(org_storage, '[]'::jsonb);
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION get_detailed_storage_metrics TO authenticated;
GRANT EXECUTE ON FUNCTION get_organization_storage_breakdown TO authenticated;

COMMENT ON FUNCTION get_detailed_storage_metrics IS 'Returns comprehensive storage metrics including table sizes, bucket sizes, and statistics for master admin.';
COMMENT ON FUNCTION get_organization_storage_breakdown IS 'Returns storage breakdown per organization for master admin.';

