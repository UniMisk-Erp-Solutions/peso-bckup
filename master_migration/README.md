# Master Migration Guide

This folder contains the complete database migration scripts for the PesoWise application, split into logical parts for easier management and troubleshooting.

## Migration Order

Run these migrations **in order**:

1. **`01_cleanup.sql`** - Drops all existing tables, functions, policies, types, and storage buckets
2. **`02_schema.sql`** - Creates all database schema objects (types, tables, functions, triggers, sequences)
3. **`03_policies.sql`** - Creates all RLS policies, storage buckets, storage policies, grants, and default data
4. **`04_saas_multi_tenancy.sql`** - Adds multi-tenancy support (organizations, organization_memberships, organization_settings)
5. **`05_update_rls_for_organizations.sql`** - Updates all RLS policies to include organization_id checks
6. **`06_fix_user_creation.sql`** - Fixes user creation trigger to work with multi-tenancy (REQUIRED)

## Quick Start

### For Fresh Installation

Run all migrations in order:

```sql
-- 1. Cleanup (if needed)
\i master_migration/01_cleanup.sql

-- 2. Create schema
\i master_migration/02_schema.sql

-- 3. Create policies
\i master_migration/03_policies.sql

-- 4. Add multi-tenancy
\i master_migration/04_saas_multi_tenancy.sql

-- 5. Update RLS policies for organizations
\i master_migration/05_update_rls_for_organizations.sql

-- 6. Fix user creation (IMPORTANT!)
\i master_migration/06_fix_user_creation.sql
```

### For Existing Database

If you have an existing database:

1. **Backup your data first!**
2. Run `04_saas_multi_tenancy.sql` - This will:
   - Create new organization tables
   - Add `organization_id` columns to existing tables
   - Migrate existing data to a default organization
   - Create organization memberships for all users
3. Run `05_update_rls_for_organizations.sql` - This updates all RLS policies
4. Run `06_fix_user_creation.sql` - **CRITICAL**: Fixes user creation to work with organizations

## Creating New Organizations

After running the migrations, use `create_org_and_admin_complete.sql` to create a new organization with an admin account:

1. Edit `create_org_and_admin_complete.sql` and set the variables at the top:
   ```sql
   org_name TEXT := 'Your Organization Name';
   org_slug TEXT := 'your-org-slug';
   admin_email TEXT := 'admin@yourorg.com';
   admin_password TEXT := 'SecurePassword123!';
   admin_name TEXT := 'Admin User';
   ```

2. Run the script - it will:
   - Create the organization
   - Create organization settings
   - If auth user exists, complete setup automatically
   - If auth user doesn't exist, provide instructions and a completion query

3. If user doesn't exist:
   - Create the user in Supabase Auth Dashboard
   - Run the completion query provided in the output

## Setup Admin Account

Use `setup_admin.sql` to make an existing user an admin:

```sql
-- This will set up admin@peso.com as admin
\i master_migration/setup_admin.sql
```

Or modify it to use a different email.

## Important Notes

- **User Creation**: After running `06_fix_user_creation.sql`, when you create a user in Supabase Auth:
  - If a "default" organization exists, the user will be automatically assigned to it
  - Otherwise, you must manually assign the user to an organization using `assign_user_to_organization()` function
  - Or use the completion query from `create_org_and_admin_complete.sql`

- **Organization Isolation**: Each user belongs to exactly one organization (enforced by unique constraint)

- **RLS Policies**: All data is isolated by organization_id at the database level

## Troubleshooting

### Error: "Failed to create user: Database error creating new user"
- **Solution**: Make sure you've run `06_fix_user_creation.sql` - this fixes the user creation trigger
- The trigger now handles organization_id properly

### Error: "organization_id is null"
- Make sure `04_saas_multi_tenancy.sql` ran successfully
- Check that users have organization memberships
- Use `assign_user_to_organization()` function to assign users to organizations

### Error: "permission denied"
- Verify RLS policies are enabled
- Check that `05_update_rls_for_organizations.sql` ran successfully
- Ensure user has an active organization membership

### User created but can't log in
- Check that user has an organization membership
- Verify profile was created with organization_id
- Use `assign_user_to_organization()` to fix missing assignments

## Helper Functions

### assign_user_to_organization()
Assigns an existing user to an organization:

```sql
SELECT public.assign_user_to_organization(
  'user-uuid-here',
  'organization-uuid-here',
  'admin'  -- or 'engineer', 'employee', 'cashier'
);
```

This function:
- Creates/updates the user's profile with organization_id
- Creates organization membership with the specified role
