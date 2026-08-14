-- ============================================================================
-- CREATE ORGANIZATION AND ADMIN ACCOUNT - MICROLINK
-- ============================================================================
-- Run this script in Supabase SQL editor.
-- If auth user already exists, setup completes automatically.
-- If auth user does not exist, the script prints follow-up instructions.

DO $$
DECLARE
  org_name TEXT := 'MicroLink';
  org_slug TEXT := 'microlink';
  admin_email TEXT := 'admin@microlink.com';
  admin_password TEXT := 'qwertyui'; -- Replace before use if creating auth user manually
  admin_name TEXT := 'MicroLink Admin';

  new_org_id UUID;
  auth_user_id UUID;
  setup_complete BOOLEAN := false;
  completion_query TEXT;
BEGIN
  INSERT INTO public.organizations (
    name,
    slug,
    plan,
    subscription_status
  )
  VALUES (
    org_name,
    org_slug,
    'starter',
    'active'
  )
  ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    updated_at = now()
  RETURNING id INTO new_org_id;

  RAISE NOTICE 'Organization created/updated: % (ID: %)', org_name, new_org_id;

  INSERT INTO public.organization_settings (
    organization_id,
    engineer_approval_limit,
    attachment_required_above_amount,
    currency,
    timezone
  )
  VALUES (
    new_org_id,
    500,
    50,
    'INR',
    'Asia/Kolkata'
  )
  ON CONFLICT (organization_id) DO UPDATE SET
    updated_at = now();

  RAISE NOTICE 'Organization settings created/updated';

  SELECT id INTO auth_user_id
  FROM auth.users
  WHERE email = admin_email
  LIMIT 1;

  IF auth_user_id IS NOT NULL THEN
    INSERT INTO public.profiles (
      user_id,
      name,
      email,
      organization_id,
      is_active
    )
    VALUES (
      auth_user_id,
      admin_name,
      admin_email,
      new_org_id,
      true
    )
    ON CONFLICT (user_id) DO UPDATE SET
      name = EXCLUDED.name,
      email = EXCLUDED.email,
      organization_id = EXCLUDED.organization_id,
      is_active = true;

    DELETE FROM public.organization_memberships
    WHERE user_id = auth_user_id;

    INSERT INTO public.organization_memberships (
      organization_id,
      user_id,
      role,
      is_active
    )
    VALUES (
      new_org_id,
      auth_user_id,
      'admin',
      true
    );

    setup_complete := true;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

  IF setup_complete THEN
    RAISE NOTICE 'SETUP COMPLETE';
    RAISE NOTICE 'Organization: %', org_name;
    RAISE NOTICE 'Organization ID: %', new_org_id;
    RAISE NOTICE 'Admin Email: %', admin_email;
    RAISE NOTICE 'Admin User ID: %', auth_user_id;
  ELSE
    RAISE NOTICE 'PARTIAL SETUP COMPLETE';
    RAISE NOTICE 'Organization created: %', org_name;
    RAISE NOTICE 'Organization ID: %', new_org_id;
    RAISE NOTICE '';
    RAISE NOTICE 'Create auth user in Supabase Auth with:';
    RAISE NOTICE 'Email: %', admin_email;
    RAISE NOTICE 'Password: %', admin_password;
    RAISE NOTICE 'Auto Confirm User: Yes';
    RAISE NOTICE '';
    completion_query := format(
      'DO $complete$ DECLARE auth_user_id UUID; org_id UUID := %L; BEGIN SELECT id INTO auth_user_id FROM auth.users WHERE email = %L LIMIT 1; IF auth_user_id IS NULL THEN RAISE EXCEPTION ''User not found''; END IF; PERFORM public.assign_user_to_organization(auth_user_id, org_id, ''admin''); RAISE NOTICE ''Setup complete! Admin can now log in.''; END $complete$;',
      new_org_id,
      admin_email
    );
    RAISE NOTICE 'Then run: %', completion_query;
  END IF;

  RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
END $$;
