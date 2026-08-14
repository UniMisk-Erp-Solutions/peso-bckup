# Reset Organization Data

This guide explains how to reset all financial data for a specific organization while keeping users and structure intact.

## What Gets Deleted/Reset

✅ **DELETED:**
- All expenses (and related line items, attachments, audit logs)
- All money assignments
- All money return requests
- All notifications
- Transaction number sequences

✅ **RESET:**
- All user balances → Set to ₹0.00

## What Stays Intact

✅ **KEPT:**
- Users (auth.users)
- Organization structure (organizations table)
- Organization memberships (organization_memberships)
- Locations
- Expense categories
- Organization settings

## How to Use

### Step 1: Run the SQL Script

1. Open Supabase SQL Editor
2. Open the file: `master_migration/19_reset_organization_data.sql`
3. **Verify the organization ID** is correct (currently set to: `80ab039f-f9e2-4c76-8b5b-e65b15d66af9`)
4. Run the script

The script will:
- Verify the organization exists
- Delete all financial data
- Reset all balances
- Show progress messages for each step

### Step 2: Clean Up Storage Files (Optional but Recommended)

Storage files (receipts/bills) are not automatically deleted. To clean them up:

#### Option A: Via Supabase Dashboard
1. Go to Storage → `receipts` bucket
2. Manually delete folders/files for deleted expenses
3. Or delete the entire organization's folder if organized by organization_id

#### Option B: Via SQL Function (if you have storage admin access)
Run this in SQL Editor:

```sql
-- This requires storage admin permissions
-- Note: This is a placeholder - actual implementation depends on your storage setup
SELECT storage.objects.* 
FROM storage.objects 
WHERE bucket_id = 'receipts';
-- Then delete files manually or via API
```

### Step 3: Verify the Reset

Run these verification queries in SQL Editor:

```sql
-- Check remaining expenses (should be 0)
SELECT COUNT(*) as remaining_expenses 
FROM public.expenses 
WHERE organization_id = '80ab039f-f9e2-4c76-8b5b-e65b15d66af9';

-- Check balances (should all be 0)
SELECT user_id, name, balance 
FROM public.profiles 
WHERE organization_id = '80ab039f-f9e2-4c76-8b5b-e65b15d66af9';

-- Check remaining money assignments (should be 0)
SELECT COUNT(*) as remaining_assignments 
FROM public.money_assignments 
WHERE organization_id = '80ab039f-f9e2-4c76-8b5b-e65b15d66af9';

-- Check remaining notifications (should be 0)
SELECT COUNT(*) as remaining_notifications 
FROM public.notifications 
WHERE organization_id = '80ab039f-f9e2-4c76-8b5b-e65b15d66af9';
```

## For Different Organizations

To reset a different organization, edit line 23 in `19_reset_organization_data.sql`:

```sql
target_org_id UUID := 'YOUR-ORGANIZATION-ID-HERE';
```

## Important Notes

⚠️ **This operation is IRREVERSIBLE!** Make sure you have backups if needed.

⚠️ **Storage files** are not automatically deleted. You'll need to clean them up manually.

⚠️ **Users remain active** - they can immediately start creating new expenses.

## After Reset

After running the script:
- All users will have ₹0.00 balance
- Transaction numbers will start fresh from 00001
- Users can immediately start creating expenses
- All previous financial history is gone













