# User Creation Fix - Multi-Tenancy

## Problem
When creating a user, you get error: **"duplicate key value violates unique constraint 'profiles_user_id_key'"**

This happens because:
1. The trigger `handle_new_user()` automatically creates a profile when a user is created in Supabase Auth
2. Then UserManagement.tsx tries to INSERT a profile again, causing a duplicate key error

## Solution

### 1. Run Migration `07_fix_trigger_organization_assignment.sql`
This updates the trigger to handle conflicts properly and assign to default organization.

### 2. Updated UserManagement.tsx
The frontend now uses:
- `assign_user_to_organization()` RPC function (handles conflicts)
- Falls back to `upsert` if RPC fails
- Automatically assigns users to the admin's organization

## How It Works Now

### When Admin Creates a User:

1. **User created in Supabase Auth** → Trigger fires
2. **Trigger creates profile** → Assigns to default organization (or org from metadata)
3. **UserManagement calls `assign_user_to_organization()`** → 
   - Updates profile with correct organization_id (admin's org)
   - Updates organization membership with correct role
   - Handles all conflicts gracefully

### Organization Isolation

✅ **YES - Admins can ONLY see users in their own organization**

All RLS policies check:
```sql
organization_id = get_user_organization_id()
```

This means:
- Admin from Org A can ONLY see users in Org A
- Admin from Org B can ONLY see users in Org B
- Queries are automatically filtered by organization_id
- Data is completely isolated at the database level

### Verification

To verify isolation works:
1. Create two organizations (Org A and Org B)
2. Create admin for each organization
3. Login as Org A admin → Create a user
4. Login as Org B admin → You should NOT see Org A's user
5. All users created by an admin are automatically assigned to that admin's organization

## Files Changed

1. `master_migration/07_fix_trigger_organization_assignment.sql` - Updated trigger
2. `src/pages/UserManagement.tsx` - Uses upsert and RPC function
3. `master_migration/06_fix_user_creation.sql` - Helper function `assign_user_to_organization()`

## Migration Order

Run migrations in this order:
1. `01_cleanup.sql`
2. `02_schema.sql`
3. `03_policies.sql`
4. `04_saas_multi_tenancy.sql`
5. `05_update_rls_for_organizations.sql`
6. `06_fix_user_creation.sql`
7. `07_fix_trigger_organization_assignment.sql` ← **NEW - Run this!**

## Testing

After running the migrations:
1. Login as admin
2. Go to User Management
3. Create a new user
4. Should work without errors
5. User should be assigned to admin's organization automatically
6. User should only be visible to admins in the same organization

