# PesoWise Database Schema Reference

**Project:** PesoWise — Expense Management SaaS (Supabase + PostgreSQL)
**Last updated from migrations through:** `20260703120000` + unnumbered end-of-stream files (`290529_*`, `290601_*`, `010626_*`, `080608_*`)
**Generated from:** `master_migration/02_schema.sql` + 120+ supabase migration files

---

## Table of Contents

1. [Enums & Custom Types](#1-enums--custom-types)
2. [Tables](#2-tables)
3. [Relationships / ERD](#3-relationships--erd)
4. [Functions & RPCs](#4-functions--rpcs)
5. [Triggers](#5-triggers)
6. [RLS Policies](#6-rls-policies)
7. [Storage Buckets](#7-storage-buckets)
8. [Indexes](#8-indexes)
9. [Known RLS Gap History](#9-known-rls-gap-history)
10. [Migration Changelog](#10-migration-changelog)

---

## 1. Enums & Custom Types

### `public.app_role`

Values (in enum order):

| Value | Notes |
|---|---|
| `admin` | Organization administrator |
| `engineer` | Manager/reviewer role |
| `employee` | Standard expense submitter |
| `cashier` | Cash distribution role |
| `team_leader` | Hierarchy tier 1 reviewer — added in `20260522139900` |
| `executive` | Hierarchy tier 2 reviewer — added in `20260522139900` |

### `public.expense_status`

| Value | Notes |
|---|---|
| `draft` | Not yet submitted |
| `submitted` | Submitted, awaiting review |
| `under_review` | Legacy in-review status |
| `verified` | Engineer/manager verified |
| `approved` | Admin approved |
| `rejected` | Rejected at any stage |
| `paid` | Payment settled |
| `edited` | Corrected by manager/admin after submission — added in `20260513139900` |
| `level_1_verified` | Team leader verified (hierarchy flow) — added in `20260524250000` |
| `level_2_verified` | Executive verified (hierarchy flow) — added in `20260524250000` |

### `public.expense_category_v2`

Enum for line-item categories. Values: `travel`, `lodging`, `food`, `transport`, `office_supplies`, `software`, `utilities`, `marketing`, `training`, `health_wellness`, `equipment`, `mileage`, `internet_phone`, `entertainment`, `professional_services`, `rent`, `other`.

> Note: `expense_categories` table (text-based custom categories) supersedes use of this enum in practice. The `expenses.category` and `expense_line_items.category` columns use `TEXT`, not this enum.

### `public.strategies`

Not an enum — a reference table. Values seeded: `standard`, `microlink_v1`.

---

## 2. Tables

### `public.profiles`

One row per user. Created by `handle_new_user()` trigger on `auth.users` INSERT.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `user_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE; UNIQUE |
| `name` | text | NO | — | |
| `email` | text | NO | — | |
| `balance` | decimal(10,2) | YES | 0 | Cash balance held by user |
| `reporting_engineer_id` | uuid | YES | — | FK → auth.users(id); supervisor chain |
| `cashier_assigned_engineer_id` | uuid | YES | — | FK → auth.users(id); cashier's assigned engineer |
| `assigned_cashier_id` | uuid | YES | — | FK → auth.users(id); employee's assigned cashier |
| `cashier_assigned_location_id` | uuid | YES | — | FK → public.locations(id); location-based cashier zone |
| `organization_id` | uuid | YES | — | FK → public.organizations(id); nullable for master admin |
| `is_active` | boolean | YES | true | Soft-delete flag |
| `is_master_admin` | boolean | YES | false | Super-admin across all orgs — added `20250201000000` |
| `employee_id` | text | YES | — | Optional employee login ID — added `20260513120300`; UNIQUE per org (partial index) |
| `preferred_language` | text | NO | 'en' | CHECK IN ('en','hi','gu') — added `20260517120000` |
| `deactivated_at` | timestamptz | YES | — | Set when org member is deactivated — added `20260531140000` |
| `created_at` | timestamptz | YES | now() | |
| `updated_at` | timestamptz | YES | now() | |

---

### `public.user_roles`

Mirrors `organization_memberships.role`. Kept in sync by `trg_sync_user_role_from_membership` trigger (added `20260522140000`).

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `user_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE |
| `role` | app_role | NO | — | UNIQUE per (user_id, role) |
| `created_at` | timestamptz | YES | now() | |

---

### `public.expenses`

Core expense record.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `user_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE; submitter |
| `organization_id` | uuid | YES | — | FK → public.organizations(id) |
| `title` | text | NO | — | |
| `trip_start` | date | NO | — | |
| `trip_end` | date | NO | — | |
| `destination` | text | NO | — | |
| `purpose` | text | YES | — | |
| `category` | text | YES | — | Text category name from expense_categories |
| `status` | expense_status | NO | 'draft' | |
| `total_amount` | decimal(10,2) | YES | 0 | Auto-summed from line items by trigger. **Use this column — NOT `amount`**. |
| `assigned_engineer_id` | uuid | YES | — | FK → auth.users(id); assigned reviewer/manager |
| `assigned_reviewer_id` | uuid | YES | — | FK → auth.users(id); hierarchy tier reviewer — added `20260522140000` |
| `approval_tier` | text | YES | — | CHECK IN ('team_leader','executive','engineer','admin') — added `20260522140000` |
| `batch_id` | uuid | YES | — | FK → public.expense_batches(id) ON DELETE SET NULL — added `20260513160000` |
| `admin_comment` | text | YES | — | Comment from reviewer/admin |
| `transaction_number` | text | YES | — | UNIQUE; 5-digit auto-assigned on submit — added `20250123000000` |
| `approved_by` | uuid | YES | — | FK → auth.users(id) — added `20260528183500` |
| `approved_at` | timestamptz | YES | — | Added `20260528183500` |
| `created_at` | timestamptz | YES | now() | |
| `updated_at` | timestamptz | YES | now() | |

---

### `public.expense_line_items`

Individual line items within an expense.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `expense_id` | uuid | NO | — | FK → public.expenses(id) ON DELETE CASCADE |
| `date` | date | NO | — | |
| `category` | expense_category_v2 | NO | — | Enum value for line type |
| `amount` | decimal(10,2) | NO | — | CHECK (amount > 0) |
| `description` | text | YES | — | |
| `created_at` | timestamptz | YES | now() | |

---

### `public.attachments`

Receipts and files attached to expenses.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `expense_id` | uuid | NO | — | FK → public.expenses(id) ON DELETE CASCADE |
| `line_item_id` | uuid | YES | — | FK → public.expense_line_items(id) ON DELETE CASCADE |
| `file_url` | text | NO | — | Full URL to the file |
| `storage_path` | text | YES | — | Bucket-relative path in receipts bucket — added `20260629120000` |
| `filename` | text | NO | — | |
| `content_type` | text | NO | — | MIME type |
| `file_size` | bigint | YES | — | In bytes — added `20250130000003` |
| `uploaded_by` | uuid | NO | — | FK → auth.users(id) |
| `created_at` | timestamptz | YES | now() | |

---

### `public.audit_logs`

Action history log for expenses.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `expense_id` | uuid | NO | — | FK → public.expenses(id) ON DELETE CASCADE |
| `user_id` | uuid | NO | — | FK → auth.users(id) |
| `action` | text | NO | — | e.g. 'expense_submitted', 'expense_verified', 'tier_advanced', 'expense_rejected' |
| `comment` | text | YES | — | |
| `created_at` | timestamptz | YES | now() | |

---

### `public.expense_categories`

Admin-managed expense category list.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `name` | text | NO | — | UNIQUE |
| `active` | boolean | NO | true | Renamed from `is_active` in `20260531140000` |
| `deactivated_at` | timestamptz | YES | — | Set on soft-delete — added `20260531140000` |
| `created_by` | uuid | YES | — | FK → auth.users(id) ON DELETE SET NULL |
| `created_at` | timestamptz | YES | now() | |

---

### `public.settings`

Global key-value configuration. Managed by admins.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `key` | text | NO | — | UNIQUE |
| `value` | text | NO | — | |
| `description` | text | YES | — | |
| `created_at` | timestamptz | YES | now() | |
| `updated_at` | timestamptz | YES | now() | |

Known keys: `engineer_approval_limit` (amount threshold for engineer vs admin approval), `attachment_required_above_amount`.

---

### `public.notifications`

In-app notifications per user.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `user_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE |
| `organization_id` | uuid | YES | — | FK → public.organizations(id) — added later |
| `type` | text | NO | — | e.g. 'expense_verified', 'expense_approved', 'balance_added' |
| `title` | text | NO | — | |
| `message` | text | NO | — | |
| `expense_id` | uuid | YES | — | FK → public.expenses(id) ON DELETE CASCADE |
| `read` | boolean | YES | false | |
| `created_at` | timestamptz | YES | now() | |
| `updated_at` | timestamptz | YES | now() | Auto-updated by trigger |

`REPLICA IDENTITY FULL` — enabled for Realtime subscriptions.

---

### `public.money_assignments`

Tracks cash assignments from cashiers to recipients.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `cashier_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE |
| `recipient_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE |
| `amount` | decimal(10,2) | NO | — | |
| `assigned_at` | timestamptz | YES | NOW() | |
| `returned_at` | timestamptz | YES | — | |
| `is_returned` | boolean | YES | false | |
| `return_transaction_id` | uuid | YES | — | |
| `created_at` | timestamptz | YES | NOW() | |
| `updated_at` | timestamptz | YES | NOW() | |

---

### `public.locations`

Physical locations for organizing engineers and cashiers.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `name` | text | NO | — | UNIQUE |
| `organization_id` | uuid | YES | — | FK → public.organizations(id) — added in later migration |
| `created_at` | timestamptz | NO | now() | |
| `updated_at` | timestamptz | NO | now() | |

---

### `public.engineer_locations`

Junction table: many-to-many between engineers and locations.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `engineer_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE |
| `location_id` | uuid | NO | — | FK → public.locations(id) ON DELETE CASCADE |
| `created_at` | timestamptz | NO | now() | |

UNIQUE (engineer_id, location_id)

---

### `public.money_return_requests`

Requests by employees/engineers to return cash to their cashier.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `requester_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE |
| `cashier_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE |
| `amount` | decimal(10,2) | NO | — | |
| `status` | text | NO | 'pending' | Values: pending / approved / rejected |
| `note` | text | YES | — | Optional note from requester — added `20260428125500` |
| `requested_at` | timestamptz | YES | NOW() | |
| `approved_at` | timestamptz | YES | — | |
| `rejected_at` | timestamptz | YES | — | |
| `approved_by` | uuid | YES | — | FK → auth.users(id) |
| `rejected_by` | uuid | YES | — | FK → auth.users(id) |
| `rejection_reason` | text | YES | — | |
| `created_at` | timestamptz | YES | NOW() | |
| `updated_at` | timestamptz | YES | NOW() | |

---

### `public.cash_transfer_history`

Immutable log of all balance transfers.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) — added `20250130000000` |
| `transferrer_id` | uuid | NO | — | FK → auth.users(id) |
| `transferrer_role` | text | NO | — | Role at time of transfer |
| `recipient_id` | uuid | NO | — | FK → auth.users(id) |
| `recipient_role` | text | NO | — | Role at time of transfer |
| `amount` | decimal(10,2) | NO | — | |
| `transfer_type` | text | NO | — | CHECK: admin_to_cashier, admin_to_employee, admin_to_engineer, admin_to_admin, cashier_to_employee, cashier_to_engineer, cashier_to_admin, employee_to_cashier, engineer_to_cashier |
| `payment_mode` | text | NO | 'cash' | CHECK IN ('cash','bank_transfer') — added `20260420130500` |
| `source_bank_account_id` | uuid | YES | — | FK → public.organization_bank_accounts(id) ON DELETE SET NULL |
| `source_bank_name_snapshot` | text | YES | — | Bank name at time of transfer |
| `source_account_holder_snapshot` | text | YES | — | Account holder at time of transfer |
| `source_account_number_masked_snapshot` | text | YES | — | Masked account number |
| `notes` | text | YES | — | |
| `transferred_at` | timestamptz | YES | NOW() | |
| `is_backdated` | boolean | YES | — | Added `20250302000000` |
| `original_transferred_at` | timestamptz | YES | — | Added `20250302000000` |
| `backdated_by` | uuid | YES | — | Added `20250302000000` |
| `backdate_reason` | text | YES | — | Added `20250302000000` |
| `created_at` | timestamptz | YES | now() | |

---

### `public.organizations`

Multi-tenant organization table. Schema established in initial migration (`20251005`).

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `name` | text | NO | — | |
| `slug` | text | NO | — | UNIQUE; URL-safe identifier |
| `subdomain` | text | YES | — | Tenant URL prefix — added `20260513120100`; UNIQUE case-insensitive |
| `strategy_slug` | text | NO | 'standard' | FK → public.strategies(slug) — added `20260513120100` |
| `logo_url` | text | YES | — | |
| `payment_status` | text | YES | — | Billing status |
| `plan_slug` | text | YES | — | Subscription plan |
| `trial_ends_at` | timestamptz | YES | — | |
| `is_blocked` | boolean | YES | false | |
| `blocked_reason` | text | YES | — | |
| `blocked_at` | timestamptz | YES | — | |
| `max_users` | integer | YES | — | Org user cap — added `20250305120000` |
| `last_activity_at` | timestamptz | YES | — | |
| `created_at` | timestamptz | YES | now() | |
| `updated_at` | timestamptz | YES | now() | |

---

### `public.organization_memberships`

User-to-organization role assignment. The authoritative role source (syncs to `user_roles`).

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `user_id` | uuid | NO | — | FK → auth.users(id) |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) |
| `role` | text | NO | — | app_role value |
| `is_active` | boolean | YES | true | |
| `is_accountant_cashier` | boolean | NO | false | Read-only cashier flag — added `290529_1700` |
| `created_at` | timestamptz | YES | now() | |
| `updated_at` | timestamptz | YES | now() | |

---

### `public.organization_settings`

Per-organization configuration.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) |
| `engineer_approval_limit` | decimal | YES | — | Max amount engineer can approve |
| `allow_cashier_expense_submission` | boolean | YES | false | Cashiers can submit expenses — added `20250305140000` |
| `batch_expense_attachment_mode` | text | NO | 'per_line' | CHECK IN ('per_line','shared') — added `20260513160000` |
| `approval_hierarchy_role_labels` | jsonb | YES | — | Custom role display labels — added `20260522140000` |
| `require_immediate_supervisor` | boolean | NO | false | Users must have reporting_engineer_id set — added `20260523120000` |
| `daily_expense_report_config` | jsonb | NO | '{}' | Report column mapping config — added `20260529140000` |
| `created_at` | timestamptz | YES | now() | |
| `updated_at` | timestamptz | YES | now() | |

---

### `public.organization_features`

Per-organization feature flag toggles. Managed by master admin.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `organization_id` | uuid | NO | — | FK → public.organizations(id) ON DELETE CASCADE; part of PK |
| `feature_key` | text | NO | — | Part of PK. Known keys: `approval_hierarchy`, `hierarchy_team_leader`, `hierarchy_executive`, `teams_enabled`, `employee_id_login`, `allow_manager_admin_expense_corrections`, `cashier_accountant_mode` |
| `enabled` | boolean | NO | false | |
| `updated_at` | timestamptz | NO | now() | |

---

### `public.teams`

Approval hierarchy teams. Added `20260522140000`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) ON DELETE CASCADE |
| `name` | text | NO | — | |
| `team_leader_user_id` | uuid | YES | — | FK → auth.users(id) ON DELETE SET NULL |
| `executive_user_id` | uuid | YES | — | FK → auth.users(id) ON DELETE SET NULL |
| `manager_user_id` | uuid | YES | — | FK → auth.users(id) ON DELETE SET NULL |
| `routing_mode` | text | NO | 'full' | CHECK IN ('full','skip_to_manager','skip_to_admin') |
| `created_at` | timestamptz | NO | now() | |
| `updated_at` | timestamptz | NO | now() | |

---

### `public.team_members`

Employee membership in teams. One team per user per org (unique index).

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `team_id` | uuid | NO | — | FK → public.teams(id) ON DELETE CASCADE; part of PK |
| `user_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE; part of PK |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) ON DELETE CASCADE |
| `created_at` | timestamptz | NO | now() | |

UNIQUE INDEX `idx_team_members_one_team_per_user_per_org` ON (organization_id, user_id).

---

### `public.expense_batches`

Groups multiple expenses submitted together. Added `20260513160000`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) ON DELETE CASCADE |
| `user_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE |
| `label` | text | YES | — | Optional name for the batch |
| `shared_category` | text | NO | — | |
| `shared_expense_date` | date | NO | — | |
| `line_count` | integer | NO | 0 | |
| `total_amount` | numeric | NO | 0 | |
| `assigned_reviewer_id` | uuid | YES | — | FK → auth.users(id) — added by `20260626120000` context |
| `created_at` | timestamptz | NO | now() | |

---

### `public.expense_form_field_templates`

Reusable custom form field definitions per organization.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `organization_id` | uuid | YES | — | FK → public.organizations(id); nullable for shared system templates |
| `name` | text | NO | — | Display label |
| `field_key` | text | NO | — | Programmatic key |
| `field_type` | text | NO | — | CHECK IN ('text','number','date','textarea','select','checkbox') |
| `required` | boolean | NO | false | |
| `placeholder` | text | YES | — | |
| `help_text` | text | YES | — | |
| `default_value` | text | YES | — | |
| `validation_rules` | jsonb | YES | — | |
| `options` | jsonb | YES | — | Array of strings for select fields |
| `display_order` | integer | NO | 0 | |
| `show_on_review` | boolean | YES | — | Whether to show in review UI |
| `show_on_detail` | boolean | YES | — | Whether to show in detail UI |
| `created_at` | timestamptz | NO | now() | |
| `updated_at` | timestamptz | NO | now() | |

---

### `public.expense_category_form_fields`

Links custom field templates to expense categories.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) |
| `category_id` | uuid | NO | — | FK → public.expense_categories(id) |
| `template_id` | uuid | NO | — | FK → public.expense_form_field_templates(id) |
| `display_order` | integer | NO | 0 | |
| `ask_once_per_batch` | boolean | NO | false | Ask once for all batch lines — added `20260516120000` |
| `created_at` | timestamptz | NO | now() | |

---

### `public.expense_form_field_values`

Stores user-entered values for custom form fields per expense.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `expense_id` | uuid | NO | — | FK → public.expenses(id) ON DELETE CASCADE |
| `organization_id` | uuid | YES | — | FK → public.organizations(id) |
| `template_id` | uuid | YES | — | FK → public.expense_form_field_templates(id); mutually exclusive with branch_field_id |
| `branch_field_id` | uuid | YES | — | FK → public.expense_form_field_option_branches(id); mutually exclusive with template_id |
| `field_value` | text | YES | — | |
| `created_at` | timestamptz | YES | now() | |
| `updated_at` | timestamptz | YES | now() | |

UNIQUE CONSTRAINTS: `uq_form_field_values_expense_template` ON (expense_id, template_id) WHERE template_id IS NOT NULL; `uq_form_field_values_expense_branch` ON (expense_id, branch_field_id) WHERE branch_field_id IS NOT NULL.

CHECK CONSTRAINT: `expense_form_field_values_template_or_branch` — exactly one of template_id or branch_field_id must be set.

---

### `public.expense_form_field_option_branches`

Child form fields shown when a parent select option is chosen (conditional dropdowns). Added `20260514120000`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) ON DELETE CASCADE |
| `parent_template_id` | uuid | NO | — | FK → public.expense_form_field_templates(id) ON DELETE CASCADE |
| `parent_option_value` | text | NO | — | Option value that triggers this branch |
| `parent_branch_id` | uuid | YES | — | FK → self (nested branches) ON DELETE CASCADE |
| `field_key` | text | NO | — | |
| `name` | text | NO | — | Display label |
| `field_type` | text | NO | — | CHECK IN ('text','number','date','textarea','select','checkbox') |
| `required` | boolean | NO | false | |
| `placeholder` | text | YES | — | |
| `help_text` | text | YES | — | |
| `default_value` | text | YES | — | |
| `validation_rules` | jsonb | YES | — | |
| `options` | jsonb | YES | — | |
| `display_order` | integer | NO | 0 | |
| `created_at` | timestamptz | NO | now() | |
| `updated_at` | timestamptz | NO | now() | |

---

### `public.organization_expense_form_fields`

Org-level custom fields appended to ALL expenses (not category-specific). Added `20260408090000`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) |
| `field_key` | text | NO | — | |
| `name` | text | NO | — | |
| `field_type` | text | NO | — | |
| `required` | boolean | NO | false | |
| `display_order` | integer | NO | 0 | |
| `input_type` | text | NO | 'default' | CHECK IN ('default','text','number','dropdown') — added `20260703120000` |
| `options` | jsonb | NO | '[]' | Dropdown options — added `20260703120000` |
| `created_at` | timestamptz | NO | now() | |
| `updated_at` | timestamptz | NO | now() | |

---

### `public.organization_bank_accounts`

Organization's source bank accounts for bank transfer allocations. Added `20260420130000`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) ON DELETE CASCADE |
| `bank_name` | text | NO | — | |
| `account_holder_name` | text | NO | — | |
| `account_number` | text | NO | — | Stored plaintext; masked in snapshots |
| `ifsc_code` | text | NO | — | |
| `branch_name` | text | YES | — | |
| `is_active` | boolean | NO | true | |
| `created_at` | timestamptz | NO | now() | |
| `updated_at` | timestamptz | NO | now() | |

---

### `public.balance_transfer_offers`

Pending balance allocation offers. Balance only moves on acceptance. Added `080608_1430`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) ON DELETE CASCADE |
| `transferrer_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE |
| `transferrer_role` | text | NO | — | CHECK IN ('admin','cashier') |
| `recipient_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE |
| `recipient_role` | text | NO | — | CHECK IN ('admin','cashier','engineer','employee','team_leader','executive') |
| `amount` | decimal(10,2) | NO | — | CHECK (amount > 0) |
| `status` | text | NO | 'pending' | CHECK IN ('pending','accepted','rejected','cancelled') |
| `payment_mode` | text | NO | 'cash' | CHECK IN ('cash','bank_transfer') |
| `source_bank_account_id` | uuid | YES | — | FK → public.organization_bank_accounts(id) ON DELETE SET NULL |
| `source_bank_name_snapshot` | text | YES | — | |
| `source_account_holder_snapshot` | text | YES | — | |
| `source_account_number_masked_snapshot` | text | YES | — | |
| `transfer_type` | text | NO | — | Resolved from role pair |
| `note` | text | YES | — | |
| `rejection_reason` | text | YES | — | |
| `proposed_at` | timestamptz | NO | NOW() | |
| `responded_at` | timestamptz | YES | — | |
| `responded_by` | uuid | YES | — | FK → auth.users(id) |
| `created_at` | timestamptz | NO | NOW() | |
| `updated_at` | timestamptz | NO | NOW() | |

---

### `public.master_admin_memberships`

Master admin user registry. Added `20250201000000`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `user_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE; UNIQUE |
| `is_active` | boolean | YES | true | |
| `created_at` | timestamptz | YES | now() | |
| `updated_at` | timestamptz | YES | now() | |

---

### `public.strategies`

Reference table for per-org product branching strategies. Added `20260513120000`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `slug` | text | NO | — | PK |
| `label` | text | NO | — | |
| `description` | text | YES | — | |
| `created_at` | timestamptz | NO | now() | |

Seeded with: `standard`, `microlink_v1`.

---

### `public.expense_correction_logs`

Before/after snapshots when a manager or admin corrects an employee expense. Added `20260513140000`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `expense_id` | uuid | NO | — | FK → public.expenses(id) ON DELETE CASCADE |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) ON DELETE CASCADE |
| `edited_by` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE |
| `reason` | text | YES | — | |
| `before_json` | jsonb | NO | — | Snapshot of expense fields before correction |
| `after_json` | jsonb | NO | — | Snapshot after correction |
| `created_at` | timestamptz | NO | now() | |

---

### `public.expense_submission_drafts`

7-day safety copies of submitted expenses. Added `20260529170000`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `user_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) ON DELETE CASCADE |
| `source_expense_id` | uuid | YES | — | FK → public.expenses(id) ON DELETE SET NULL |
| `submission_status` | text | NO | 'submitted' | CHECK IN ('submitted','draft') |
| `title` | text | YES | — | |
| `destination` | text | YES | — | |
| `trip_start` | date | YES | — | |
| `total_amount` | numeric(12,2) | YES | — | |
| `category` | text | YES | — | |
| `payload` | jsonb | NO | '{}' | Full expense payload |
| `expires_at` | timestamptz | NO | — | 7-day TTL |
| `dismissed_at` | timestamptz | YES | — | |
| `created_at` | timestamptz | NO | now() | |
| `updated_at` | timestamptz | NO | now() | |

---

### `public.form_field_option_usage_tracking`

Per-user usage counts for custom form select options. Added `20260522130000`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) ON DELETE CASCADE |
| `user_id` | uuid | NO | — | FK → auth.users(id) ON DELETE CASCADE |
| `field_key` | text | NO | — | |
| `field_kind` | text | NO | — | CHECK IN ('template','branch','base') — 'base' added `20260703120000` |
| `option_value` | text | NO | — | |
| `usage_count` | integer | NO | 1 | |
| `last_used_at` | timestamptz | NO | now() | |
| `created_at` | timestamptz | NO | now() | |
| `updated_at` | timestamptz | NO | now() | |

UNIQUE (organization_id, user_id, field_key, field_kind, option_value)

---

### `public.category_usage_tracking`

Per-user category usage frequency for smart recommendations. Added `20250130000005`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `user_id` | uuid | NO | — | FK → auth.users(id) |
| `category_name` | text | NO | — | |
| `usage_count` | integer | NO | 1 | |
| `last_used_at` | timestamptz | YES | now() | |
| `created_at` | timestamptz | YES | now() | |
| `updated_at` | timestamptz | YES | now() | |

---

### `public.contact_leads`

Landing page contact form submissions. Added `20250220000000`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `work_email` | text | NO | — | |
| `name` | text | YES | — | |
| `company` | text | YES | — | |
| `message` | text | YES | — | |
| `created_at` | timestamptz | YES | now() | |

---

### `public.employee_auth_lookup_attempts`

Rate-limit log for employee_id auth email lookups. Added `20260522150000`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `organization_id` | uuid | NO | — | FK → public.organizations(id) ON DELETE CASCADE |
| `lookup_key` | text | NO | — | Normalized employee_id or email |
| `attempted_at` | timestamptz | NO | now() | |

RLS enabled; no client-accessible policies — SECURITY DEFINER only.

---

### `public.expense_form_field_values_dedupe_backup`

Audit backup for duplicate/invalid form field value rows removed during deduplication migration. Added `20260701120000`.

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `backup_id` | uuid | NO | PK |
| `removed_at` | timestamptz | NO | When removed |
| `removed_reason` | text | NO | |
| `migration_tag` | text | NO | DEFAULT '20260701120000' |
| `id` | uuid | YES | Original row id |
| `organization_id` | uuid | YES | |
| `expense_id` | uuid | YES | |
| `template_id` | uuid | YES | |
| `branch_field_id` | uuid | YES | |
| `field_value` | text | YES | |
| `created_at` | timestamptz | YES | |
| `updated_at` | timestamptz | YES | |

---

## 3. Relationships / ERD

```
auth.users
  └─< profiles (user_id)
  └─< user_roles (user_id)
  └─< organization_memberships (user_id)
  └─< expenses (user_id, assigned_engineer_id, assigned_reviewer_id, approved_by)
  └─< notifications (user_id)
  └─< money_assignments (cashier_id, recipient_id)
  └─< money_return_requests (requester_id, cashier_id, approved_by, rejected_by)
  └─< audit_logs (user_id)
  └─< attachments (uploaded_by)
  └─< cash_transfer_history (transferrer_id, recipient_id)
  └─< balance_transfer_offers (transferrer_id, recipient_id, responded_by)
  └─< expense_correction_logs (edited_by)
  └─< master_admin_memberships (user_id)
  └─< team_members (user_id)
  └─< teams (team_leader_user_id, executive_user_id, manager_user_id)

public.organizations
  └─< organization_memberships (organization_id)
  └─< organization_settings (organization_id)
  └─< organization_features (organization_id)
  └─< organization_expense_form_fields (organization_id)
  └─< organization_bank_accounts (organization_id)
  └─< expenses (organization_id)
  └─< expense_batches (organization_id)
  └─< teams (organization_id)
  └─< team_members (organization_id)
  └─< cash_transfer_history (organization_id)
  └─< balance_transfer_offers (organization_id)
  └─< locations (organization_id)
  └─< expense_form_field_templates (organization_id)
  └─< expense_form_field_option_branches (organization_id)
  └─< expense_correction_logs (organization_id)
  └─< expense_submission_drafts (organization_id)
  └─< form_field_option_usage_tracking (organization_id)
  └─< contact_leads (implied)
  └─ FK → public.strategies (strategy_slug)

public.expenses
  └─< expense_line_items (expense_id)
  └─< attachments (expense_id)
  └─< audit_logs (expense_id)
  └─< notifications (expense_id)
  └─< expense_form_field_values (expense_id)
  └─< expense_correction_logs (expense_id)
  └─< expense_submission_drafts (source_expense_id)
  └─ FK → public.expense_batches (batch_id)

public.expense_batches
  └─< expenses (batch_id)

public.expense_categories
  └─< expense_category_form_fields (category_id)

public.expense_form_field_templates
  └─< expense_category_form_fields (template_id)
  └─< expense_form_field_values (template_id)
  └─< expense_form_field_option_branches (parent_template_id)

public.expense_form_field_option_branches
  └─< expense_form_field_option_branches (parent_branch_id — self-referential)
  └─< expense_form_field_values (branch_field_id)

public.locations
  └─< engineer_locations (location_id)
  └─ FK ← profiles (cashier_assigned_location_id)

public.teams
  └─< team_members (team_id)

public.organization_bank_accounts
  └─ FK ← cash_transfer_history (source_bank_account_id)
  └─ FK ← balance_transfer_offers (source_bank_account_id)

public.strategies
  └─ FK ← organizations (strategy_slug)

Sequences:
  expense_transaction_number_seq → expenses.transaction_number
```

---

## 4. Functions & RPCs

### Core Role/Auth Helpers

| Function | Returns | Description |
|---|---|---|
| `public.has_role(_user_id uuid, _role app_role)` | boolean | Checks user_roles table. STABLE, SECURITY DEFINER. |
| `public.is_master_admin()` | boolean | True if caller is in master_admin_memberships OR profiles.is_master_admin=true. |
| `public.is_org_admin(p_org_id uuid)` | boolean | True if caller is active admin in given org via organization_memberships. |
| `public.is_accountant_cashier(p_user_id uuid, p_org_id uuid)` | boolean | True if user is active cashier with is_accountant_cashier=true and org has cashier_accountant_mode feature. Added `290529_1700`. |

### Profile & User Triggers

| Function | Returns | Description |
|---|---|---|
| `public.handle_new_user()` | trigger | Creates profile row on new auth.users INSERT. |
| `public.update_notifications_updated_at()` | trigger | Sets notifications.updated_at = now() on UPDATE. |
| `public.update_updated_at_column()` | trigger | Generic updated_at setter for any table. |
| `public.sync_user_role_from_membership()` | trigger | Keeps user_roles in sync when organization_memberships.role changes. INSERT upserts, UPDATE deletes old + upserts new, DELETE removes old role. Added `20260522140000`. |

### Expense Core

| Function | Returns | Description |
|---|---|---|
| `public.update_expense_total()` | trigger | Recalculates expenses.total_amount from SUM of line items on INSERT/UPDATE/DELETE of expense_line_items. |
| `generate_transaction_number()` | text | Returns next value from expense_transaction_number_seq formatted as 5-digit zero-padded string. |
| `assign_transaction_number()` | trigger | Assigns transaction_number when expense status changes to 'submitted'. |
| `public.apply_expense_correction(p_expense_id uuid, p_updates jsonb, p_reason text DEFAULT NULL)` | jsonb | Admin or assigned engineer corrects another user's expense. Requires org feature `allow_manager_admin_expense_corrections`. Sets status to 'edited'. Logs to expense_correction_logs. Returns `{ok, expense_id, after}`. |
| `public.replace_expense_form_field_values(p_expense_id uuid, p_organization_id uuid, p_values jsonb)` | jsonb | Atomically replaces all custom form field values for an expense. Validates caller is owner or admin. Returns `{saved_count}`. Added `20260701120000`. |

### Hierarchy Approval Flow

| Function | Returns | Description |
|---|---|---|
| `public.expense_hierarchy_reviewer_can_act(e expenses, v_uid uuid)` | boolean | True when v_uid is the assigned TL/executive reviewer on this expense. Handles legacy tier mismatches. |
| `public.expense_manager_can_review(e expenses, v_uid uuid)` | boolean | True when v_uid is an engineer who can review this expense (via assignment, direct report, or team). |
| `public.manager_expense_visible_to_user(e expenses, p_user_id uuid)` | boolean | True when user has any visibility path (assignment, 2-level supervisor chain, or team). |
| `public.manager_expense_visible_to_user(p_expense_id uuid, p_manager_id uuid)` | boolean | Overload: takes expense id. |
| `public.expense_ready_for_manager_review(e expenses)` | boolean | True when expense is in a state the manager should act on (level_2_verified, tier='engineer' + correct status, or exec handoff detected). |
| `public.expense_executive_handoff_in_audit(e expenses)` | boolean | True when audit_logs shows executive advanced to engineer tier. |
| `public.reviewer_can_act_on_expense(p_expense_id uuid)` | boolean | Combined check: any reviewer (hierarchy or manager) can act. |
| `public.repair_expense_for_manager_review(p_expense_id uuid)` | jsonb | Self-service repair for stuck hierarchy rows; sets level_2_verified + engineer tier + assigns team manager. |
| `public.org_hierarchy_tier_enabled(p_organization_id uuid, p_tier text)` | boolean | True if the given hierarchy tier (team_leader/executive) is enabled via organization_features; always true for engineer/admin tiers. |
| `public.review_advance_expense_hierarchy_tier(p_expense_id uuid, p_next_approval_tier text, p_next_assigned_reviewer_id uuid, p_next_assigned_engineer_id uuid, p_comment text)` | jsonb | TL/executive verifies at their tier and advances workflow. Sets status=level_1_verified (TL) or level_2_verified (exec). Returns full expense row. |
| `public.review_verify_expense(p_expense_id uuid, p_comment text)` | jsonb | Manager (engineer) verifies expense → 'verified'. Auto-repairs stuck rows. Returns full expense row. |
| `public.review_reject_expense(p_expense_id uuid, p_comment text)` | jsonb | Admin, manager, or hierarchy reviewer rejects expense → 'rejected'. Returns full expense row. |
| `public.review_admin_verify_expense(p_expense_id uuid, p_comment text)` | jsonb | Org admin verifies expense → 'verified'. Added `20260702120000`. |
| `public.review_approve_expense(p_expense_id uuid, p_comment text)` | jsonb | Admin or manager approves expense → 'approved'. Auto-verifies submitted/edited if admin. Checks engineer_approval_limit. Added `20260702120000`. |
| `public.get_expense_review_head(p_expense_id uuid)` | jsonb | Returns key expense routing fields (id, status, approval_tier, reviewer ids) for UI. Visible to reviewer, submitter, or admin. |

### Queue / List RPCs

| Function | Returns | Description |
|---|---|---|
| `public.list_hierarchy_reviewer_expenses(p_organization_id uuid)` | SETOF expenses | TL/executive review queue: expenses assigned to caller + historical (via audit_logs). |
| `public.list_manager_reviewer_expenses(p_organization_id uuid)` | SETOF expenses | Engineer/manager full visible expense list (all statuses). |
| `public.list_manager_pending_expenses(p_organization_id uuid)` | SETOF expenses | Manager's actionable queue + recently acted-on history. Latest version: `290601_1200`. |
| `public.list_manager_level2_expenses(p_organization_id uuid)` | SETOF expenses | Dedicated level_2_verified queue for manager. |
| `public.manager_expense_visible_to_user(e expenses, p_user_id uuid)` | boolean | Latest version adds 2-level supervisor chain and formal team check. |

### Cash Transfer RPCs

| Function | Returns | Description |
|---|---|---|
| `get_original_cashier(recipient_user_id uuid)` | uuid | Returns cashier_id who first assigned money to recipient (FIFO). SECURITY DEFINER. |
| `cashier_can_manage_employee(cashier_user_id uuid, employee_user_id uuid)` | boolean | True if cashier can manage the employee (by location or direct engineer assignment). |
| `public.cashier_can_manage_engineer(cashier_user_id uuid, engineer_user_id uuid)` | boolean | Same logic for engineer targets. Added `20260423120000`. |
| `get_cashier_for_engineer(engineer_user_id uuid)` | uuid | Returns cashier for engineer via location first, then direct assignment. Latest version uses organization_memberships instead of user_roles. |
| `approve_money_return_update_balances(request_id uuid, cashier_user_id uuid)` | void | Atomically approves money return: updates both balances + sets request status. SECURITY DEFINER. |
| `public.log_money_return_to_history(request_id uuid)` | void | Inserts approved money return record into cash_transfer_history. Note field included. |
| `public.cashier_return_money_to_admin(cashier_user_id uuid, admin_user_id uuid, amount_param decimal)` | void | Transfers money from cashier to admin balance + logs to history. Blocks accountant cashiers. |
| `public._mask_bank_account_number(account_number text)` | text | Masks all but last 4 digits of account number. IMMUTABLE. |
| `public._primary_org_role(p_user_id uuid, p_org_id uuid)` | text | Returns highest-priority active role for user in org. |
| `public._resolve_outbound_transfer_type(p_transferrer_role text, p_recipient_role text)` | text | Resolves transfer_type string from transferrer+recipient role pair. |
| `public.propose_balance_transfer_offer(p_organization_id uuid, p_recipient_id uuid, p_amount decimal, p_payment_mode text, p_source_bank_account_id uuid, p_note text)` | uuid | Creates pending balance transfer offer. Admin self-transfer applies immediately. Latest version: `290529_1600`. |
| `public.accept_balance_transfer_offer(p_offer_id uuid)` | void | Recipient accepts offer: moves balance, creates money_assignment if cashier→employee, logs to history. |
| `public.reject_balance_transfer_offer(p_offer_id uuid, p_reason text)` | void | Recipient rejects offer with reason (min 3 chars). |
| `public.cancel_balance_transfer_offer(p_offer_id uuid)` | void | Sender cancels pending offer. |

### Tenant & Org RPCs (mostly pre-auth accessible)

| Function | Returns | Description |
|---|---|---|
| `public.get_organization_by_subdomain(p_subdomain text)` | TABLE(id,name,slug,logo_url) | Org lookup by subdomain; falls back to slug. SECURITY DEFINER, grantable to anon. |
| `public.get_organization_feature_enabled(p_organization_id uuid, p_feature_key text)` | boolean | Feature flag check. Safe for pre-auth. |
| `public.email_can_sign_in_on_tenant(p_email text, p_organization_id uuid)` | boolean | True if email is active org member. Pre-auth gate. |
| `public.get_tenant_sign_in_subdomain_for_email(p_email text)` | text | Preferred tenant subdomain for sign-in redirect by email. |
| `public.get_tenant_sign_in_subdomain_for_user(p_user_id uuid)` | text | Same by user_id. |
| `public.get_employee_auth_email(p_organization_id uuid, p_employee_id text)` | text | Pre-auth: returns auth email for employee_id login. Rate-limited (8/15 min per key, 60/15 min per org). VOLATILE. |
| `public.list_organizations_for_dev_login()` | TABLE(id,name,slug,subdomain) | Dev-only: lists all tenant orgs for localhost login picker. |
| `public.org_feature_enabled(p_organization_id uuid, p_feature_key text)` | boolean | Feature flag check (authenticated version). |
| `public.get_user_organization_id()` | uuid | Returns caller's org_id. Handles master admin null case. |

### Team Overview RPCs

| Function | Returns | Description |
|---|---|---|
| `public.user_is_team_leader(p_team_id uuid, p_organization_id uuid, p_user_id uuid)` | boolean | True if user is TL, executive, or manager of the team. |
| `public.user_has_formal_teams_as_leader(p_organization_id uuid, p_user_id uuid)` | boolean | True if user leads any team in the org. |
| `public.user_has_formal_teams_with_members(p_organization_id uuid, p_user_id uuid)` | boolean | True if user leads any team that has at least one member. |
| `public.get_subordinate_user_ids(p_organization_id uuid, p_leader_user_id uuid)` | TABLE(user_id uuid) | Recursive CTE: all direct+indirect reports via profiles.reporting_engineer_id. |
| `public.list_my_teams_overview(p_organization_id uuid, p_date_from timestamptz, p_date_to timestamptz)` | jsonb | Returns teams array with member expense aggregates. Falls back to supervisor-hierarchy virtual teams when no formal teams. |
| `public.list_team_expenses_for_leader(p_organization_id uuid, p_team_id uuid, ...)` | TABLE | Expenses for a team, filtered by status/date. Admin sees all. |

### Dashboard & Reporting

| Function | Returns | Description |
|---|---|---|
| `public.get_dashboard_expense_summary(p_organization_id uuid, p_user_id uuid)` | jsonb | One-round-trip dashboard aggregates: total/pending/approved amounts + counts. |
| `public.get_org_role_balance_totals(p_organization_id uuid)` | jsonb | Sum of profiles.balance grouped by role for active members. |
| `public.get_resubmitted_expense_ids(p_expense_ids uuid[])` | SETOF uuid | Batch lookup: which expenses were resubmitted (from audit_logs). |
| `public.get_reviewer_corrected_expense_ids(p_expense_ids uuid[], p_organization_id uuid)` | SETOF uuid | Batch lookup: which expenses were corrected by reviewer (from expense_correction_logs). |
| `public.get_expense_submitter_profiles(p_organization_id uuid, p_user_ids uuid[])` | TABLE(user_id,name,email,balance,employee_id) | Resolves display info for expense submitters; marks deactivated users "(Former)". |
| `public.get_expense_form_field_display(p_organization_id uuid, p_expense_id uuid, p_context text)` | TABLE(id,name,field_type,field_value,display_order) | Returns custom field labels+values for expense review/detail UI. Latest version: `20260630120000`. |
| `public.admin_restore_upsert_form_field_values(p_organization_id uuid, p_rows jsonb)` | integer | Bulk upsert form field values for admin restore. Returns count. |

### Profile Management

| Function | Returns | Description |
|---|---|---|
| `public.deactivate_organization_member(p_organization_id uuid, p_user_id uuid)` | void | Soft-removes org member: clears assignments, sets is_active=false, deactivated_at=now(). Admin only. |
| `public.deactivate_expense_category(p_organization_id uuid, p_category_id uuid)` | void | Soft-deactivates an expense category. Admin only. |
| `admin_reset_user_password(target_user_id uuid, new_password text, admin_password text)` | json | Verifies admin role; actual password update done via Supabase Admin API in app layer. |

### Form Field & Category Tracking

| Function | Returns | Description |
|---|---|---|
| `public.increment_category_usage(org_id uuid, user_id uuid, category_name text)` | void | Upserts category usage count for smart recommendations. |
| `public.increment_form_field_option_usage(p_organization_id uuid, p_user_id uuid, p_field_key text, p_field_kind text, p_option_value text)` | void | Upserts select option usage count. field_kind: template/branch/base. |

### Cashier Zone / Location Helpers

| Function | Returns | Description |
|---|---|---|
| `sync_engineers_with_location_cashier(location_id_param uuid)` | void | Syncs engineer→cashier assignments when cashier is assigned to a location. |
| `diagnose_cashier_assignment(engineer_user_id uuid)` | TABLE | Diagnostic function showing cashier assignment state for an engineer. |

### Misc / Org Admin

| Function | Returns | Description |
|---|---|---|
| `public.is_organization_active(org_id uuid)` | boolean | True if org is not blocked and payment_status is active. |
| `public.update_organization_activity(org_id uuid)` | void | Updates organizations.last_activity_at. |
| `public.create_organization_with_admin(...)` | void | Creates org + admin user atomically. Enforces max_users. |
| `public.check_organization_member_limit()` | trigger | Trigger: enforces max_users on organization_memberships INSERT. |
| `public.assign_user_to_organization(...)` | void | Assigns user to org with role. Enforces max_users. |
| `public.get_organization_member_counts(org_ids uuid[])` | TABLE | Batch active member count per org. Master admin only. |
| `public.get_storage_metrics()` / `public.get_detailed_storage_metrics()` / `public.get_organization_storage_breakdown()` | TABLE | Storage usage analytics for master admin. |

---

## 5. Triggers

| Table | Trigger Name | Event | When | Function Called |
|---|---|---|---|---|
| `auth.users` | `on_auth_user_created` | INSERT | AFTER | `public.handle_new_user()` |
| `public.expense_line_items` | `update_expense_total_on_line_item` | INSERT OR UPDATE OR DELETE | AFTER | `public.update_expense_total()` |
| `public.notifications` | `update_notifications_updated_at` | UPDATE | BEFORE | `public.update_notifications_updated_at()` |
| `public.expenses` | `trigger_assign_transaction_number` | INSERT OR UPDATE | BEFORE | `assign_transaction_number()` |
| `public.profiles` | `sync_engineers_on_cashier_location_change` | UPDATE OF cashier_assigned_location_id | AFTER | `trigger_sync_engineers_on_cashier_location_change()` |
| `public.engineer_locations` | `sync_engineer_on_location_assignment` | INSERT | AFTER | `trigger_sync_engineer_on_location_assignment()` |
| `public.organization_memberships` | `trg_sync_user_role_from_membership` | INSERT OR UPDATE OF role OR DELETE | AFTER | `public.sync_user_role_from_membership()` |
| `public.organization_memberships` | `enforce_organization_member_limit` | INSERT | BEFORE | `public.check_organization_member_limit()` |
| `public.expenses` | `trigger_update_org_activity_on_expense_insert` | INSERT | AFTER | `update_org_activity_on_expense()` |
| `public.expenses` | `trigger_update_org_activity_on_expense_update` | UPDATE | AFTER | `update_org_activity_on_expense()` |
| `public.cash_transfer_history` | `trigger_update_org_activity_on_transfer` | INSERT | AFTER | `update_org_activity_on_money_transfer()` |
| `public.money_return_requests` | `trigger_update_org_activity_on_return_insert` | INSERT | AFTER | `update_org_activity_on_money_return()` |
| `public.money_return_requests` | `trigger_update_org_activity_on_return_update` | UPDATE | AFTER | `update_org_activity_on_money_return()` |
| `public.money_return_requests` | `log_money_return_on_approval` | UPDATE OF status | AFTER (status='approved') | `trigger_log_money_return()` |
| `public.expense_form_field_templates` | `update_form_field_templates_updated_at` | UPDATE | BEFORE | `update_updated_at_column()` |
| `public.expense_form_field_values` | `update_form_field_values_updated_at` | UPDATE | BEFORE | `update_updated_at_column()` |
| `public.expense_form_field_option_branches` | `update_option_branches_updated_at` | UPDATE | BEFORE | `update_updated_at_column()` |
| `public.organization_bank_accounts` | `update_organization_bank_accounts_updated_at` | UPDATE | BEFORE | `update_updated_at_column()` |
| `public.organization_expense_form_fields` | `update_org_expense_form_fields_updated_at` | UPDATE | BEFORE | `update_updated_at_column()` |
| `public.form_field_option_usage_tracking` | `update_form_field_option_usage_updated_at` | UPDATE | BEFORE | `update_updated_at_column()` |
| `public.category_usage_tracking` | `update_category_usage_updated_at` | UPDATE | BEFORE | `update_updated_at_column()` |
| `public.teams` | (via `update_updated_at_column`) | UPDATE | BEFORE | `update_updated_at_column()` |

---

## 6. RLS Policies

### `public.profiles`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Users can view all profiles" | SELECT | All authenticated | Any authenticated user |
| "Engineers can view managed profiles" | SELECT | Engineers | Only profiles where reporting_engineer_id = caller |
| "Users can update their own profile" | UPDATE | Self | user_id = caller |
| "Admins can update any profile" | UPDATE | Admins | has_role(admin) |
| "Cashiers can update managed profiles" | UPDATE | Cashiers | Cashier is active in org AND (target is self OR target is employee/engineer the cashier can manage). Blocks accountant cashiers. |
| "Admins can insert profiles" | INSERT | Admins | has_role(admin) |
| "Admins can delete profiles" | DELETE | Admins | has_role(admin) |

---

### `public.user_roles`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Users can view their own roles" | SELECT | Self | user_id = caller |
| "Admins and cashiers can view all roles" | SELECT | Admin / Cashier | has_role(admin) OR has_role(cashier) |
| "Engineers and employees can view cashier and admin roles" | SELECT | Engineers / Employees | Caller is engineer/employee AND role IN ('cashier','admin') |
| "Cashiers can view admin roles" | SELECT | Cashiers | Caller is cashier AND role = 'admin' |
| "Admins can manage roles" | ALL | Admins | has_role(admin) |
| "Users can insert their own roles" | INSERT | Self | user_id = caller |
| "Users can update their own roles" | UPDATE | Self | user_id = caller |

---

### `public.expenses`

Multiple overlapping SELECT policies — a row is visible if ANY policy allows it.

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Users can view their own expenses" | SELECT | Submitter | user_id = caller |
| "Engineers can view assigned expenses" | SELECT | Engineers (legacy) | assigned_engineer_id = caller AND has_role(engineer) |
| "Engineers can view team reporting expenses" | SELECT | Engineers | Active engineer in org AND (assigned_engineer_id=caller OR assigned_reviewer_id=caller OR direct report OR team member where manager=caller) |
| "Admins can view all expenses" | SELECT | Admins (legacy) | has_role(admin) |
| "Org admins can view organization expenses" | SELECT | Org admins | Active admin in org via organization_memberships |
| "Hierarchy reviewers can view assigned expenses" | SELECT | TL / Executive | assigned_reviewer_id or assigned_engineer_id matches caller AND role matches tier |
| "Accountant cashiers can view reportable org expenses" | SELECT | Accountant cashiers | is_accountant_cashier=true AND status IN ('verified','approved') |
| "Employees can create expenses" (legacy) | INSERT | Employees / Admins | user_id=caller AND has_role(employee or admin) |
| "Employees, engineers, admins, or cashiers when allowed can create expenses" | INSERT | Employees, Engineers, Admins, TL, Exec, Cashiers (when setting enabled) | user_id=caller AND org_id set AND role IN ('employee','engineer','admin','team_leader','executive') OR (cashier AND allow_cashier_expense_submission=true) |
| "Users can update their submitted or rejected expenses" | UPDATE | Submitter | user_id=caller AND status IN ('submitted','rejected') AND active org membership. WITH CHECK: status must remain submitted or rejected. |
| "Engineers can update assigned expenses" | UPDATE | Engineers | Active engineer in org AND status in actionable set AND assigned. WITH CHECK: engineer identity + status must move to valid next state. |
| "Hierarchy reviewers can update assigned expenses" | UPDATE | TL / Executive | Caller is assigned reviewer AND tier IS NOT NULL AND status matches tier's valid input states. |
| "Admins can update any expense" | UPDATE | Admins | Active admin in org via organization_memberships. |
| "Users can delete their submitted expenses" | DELETE | Submitter | user_id=caller AND status='submitted' |
| "Admins can delete any expense" | DELETE | Admins | has_role(admin) |

> ⚠️ **Note:** The `expenses` table has both legacy `has_role()` policies (from initial schema) and newer `organization_memberships`-based policies. Both sets are active simultaneously. The newer policies are required for multi-org correctness.

---

### `public.expense_line_items`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Users can view line items of viewable expenses" | SELECT | Submitter / Engineer / Admin | Expense is viewable by caller (user_id, assigned_engineer_id, or admin) |
| "Users can insert line items for their expenses" | INSERT | Submitter | Expense belongs to caller (historically status='draft'; later policies relaxed) |
| "Users can update line items for their draft expenses" | UPDATE | Submitter | Expense belongs to caller AND status='draft' |
| "Users can delete line items from their draft expenses" | DELETE | Submitter | Expense belongs to caller AND status='draft' |
| "Admins can insert line items in their org for restore" | INSERT | Admins | Admin in expense's org (restore use-case) |
| "Admins can update line items in their org for restore" | UPDATE | Admins | Admin in expense's org (restore use-case) |
| "Accountant cashiers can view line items" | SELECT | Accountant cashiers | Expense is verified/approved AND is_accountant_cashier |

---

### `public.attachments`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Users can view attachments of viewable expenses" | SELECT | Submitter / Engineer / Admin | Expense is viewable by caller |
| "Users can upload attachments for their expenses" | INSERT | Submitter | Expense belongs to caller AND uploaded_by=caller |
| "Users can delete attachments for their expenses" | DELETE | Submitter | Expense belongs to caller AND status='submitted' |
| "Admins can delete any attachment" | DELETE | Admins | has_role(admin) |
| "Org admins can view organization attachments" | SELECT | Org admins | Admin in expense's org |
| "Admins can insert attachments in their org for restore" | INSERT | Admins | Admin in expense's org |
| "Admins can update attachments in their org for restore" | UPDATE | Admins | Admin in expense's org |
| "Accountant cashiers can view attachments" | SELECT | Accountant cashiers | Expense is verified/approved AND is_accountant_cashier |

---

### `public.audit_logs`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Users can view audit logs of viewable expenses" | SELECT | Submitter / Engineer / Admin | Expense is viewable by caller |
| "Authenticated users can create audit logs" | INSERT | Authenticated | user_id = caller |
| "Users can delete audit logs for their expenses" | DELETE | Submitter | Expense belongs to caller AND status='submitted' |
| "Admins can delete any audit logs" | DELETE | Admins | has_role(admin) |
| "Admins can insert audit logs in their org for restore" | INSERT | Admins | Admin in expense's org |
| "Admins can update audit logs in their org for restore" | UPDATE | Admins | Admin in expense's org |
| "Accountant cashiers can view audit logs" | SELECT | Accountant cashiers | Expense is verified/approved AND is_accountant_cashier |

---

### `public.expense_categories`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| `exp_cat_read` | SELECT | All authenticated | active = true |
| `exp_cat_admin_insert` | INSERT | Admins | has_role(admin) |
| `exp_cat_admin_update` | UPDATE | Admins | has_role(admin) |
| `exp_cat_admin_delete` | DELETE | Admins | has_role(admin) |

---

### `public.settings`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Admins can view settings" | SELECT | Admins | has_role(admin) |
| "Engineers can view settings" | SELECT | Engineers | has_role(engineer) |
| "Authenticated users can view settings" | SELECT | All authenticated | auth.role() = 'authenticated' |
| "Admins can update settings" | UPDATE | Admins | has_role(admin) |
| "Admins can insert settings" | INSERT | Admins | has_role(admin) |

---

### `public.notifications`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Users can view their own notifications" | SELECT | Self | user_id = caller |
| "Users can update their own notifications" | UPDATE | Self | user_id = caller |
| "Authenticated users can create notifications" | INSERT | Authenticated | auth.role() = 'authenticated' |

---

### `public.money_assignments`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Users can view their own assignments" | SELECT | Cashier / Recipient | cashier_id=caller OR recipient_id=caller |
| "Cashiers and admins can create assignments" | INSERT | Cashiers / Admins | has_role(cashier or admin) AND cashier_id=caller. Blocks accountant cashiers. |
| "Cashiers and admins can update assignments" | UPDATE | Cashiers / Admins | has_role(cashier or admin). Blocks accountant cashiers. |

---

### `public.locations`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Allow authenticated users to read locations" | SELECT | Authenticated | true (all authenticated) |
| "Only admins can insert locations" | INSERT | Admins | has_role(admin) via user_roles |
| "Only admins can update locations" | UPDATE | Admins | has_role(admin) via user_roles |
| "Only admins can delete locations" | DELETE | Admins | has_role(admin) via user_roles |

---

### `public.engineer_locations`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Allow authenticated users to read engineer_locations" | SELECT | Authenticated | true |
| "Only admins can insert engineer_locations" | INSERT | Admins | has_role(admin) |
| "Only admins can update engineer_locations" | UPDATE | Admins | has_role(admin) |
| "Only admins can delete engineer_locations" | DELETE | Admins | has_role(admin) |

---

### `public.money_return_requests`

> ⚠️ RLS on this table was revised three times (`20250131000003`, `20260423130000`). Final policies below:

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Employees and engineers can create return requests" | INSERT | Employees / Engineers | requester_id=caller AND caller is active employee/engineer in an org that also has cashier_id as active cashier/admin |
| "Users can view their own return requests" | SELECT | Requester / Cashier | (requester_id=caller OR cashier_id=caller) AND both share a common active org |
| "Cashiers can update return requests" | UPDATE | Cashiers / Admins | cashier_id=caller AND caller is active cashier/admin in org shared with requester. Blocks accountant cashiers. |

---

### `public.cash_transfer_history`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| (various SELECT policies) | SELECT | Admin / Cashier / Org member | Admin sees all in org; cashier sees own transfers; org members with appropriate roles |
| "Admins and cashiers can create transfers" | INSERT | Admin / Cashier | Active admin or cashier in org. Blocks accountant cashiers. |
| "Admins can update transfers in their organization" | UPDATE | Admins | Active admin in org |
| "Accountant cashiers can view org transfer history" | SELECT | Accountant cashiers | is_accountant_cashier=true for caller's org |

---

### `public.expense_batches`

> ⚠️ The SELECT policy was initially missing `assigned_reviewer_id` arm. Fixed in `20260630120000_expense_batches_reviewer_select.sql`. See [Section 9](#9-known-rls-gap-history).

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Users can view own expense batches" | SELECT | Submitter / Admin / Assigned Reviewer | user_id=caller OR admin in org OR any batch expense has assigned_engineer_id=caller OR assigned_reviewer_id=caller |
| "Users can insert own expense batches" | INSERT | Org members | user_id=caller AND active org membership exists |
| "Users can update own expense batches" | UPDATE | Submitter | user_id=caller |

---

### `public.expense_form_field_templates`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Org members can view form field templates" | SELECT | Org members | organization_id in caller's active memberships |
| (admin management policies) | INSERT / UPDATE / DELETE | Admins | Active admin in org |

---

### `public.expense_form_field_values`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "View form field values for visible expenses" | SELECT | Expense visibility | Expense exists and (org_id matches or is null). Inherits expenses RLS. |
| (insert/update policies) | INSERT / UPDATE | Submitter / Admin | Expense belongs to caller or caller is admin |
| "Accountant cashiers can view form field values" | SELECT | Accountant cashiers | Expense is verified/approved AND is_accountant_cashier |

---

### `public.expense_correction_logs`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "View correction logs for viewable expenses" | SELECT | Submitter / Engineer / Admin | Expense is viewable by caller (user_id, assigned_engineer_id, assigned_reviewer_id, or admin) |

No INSERT/UPDATE/DELETE for authenticated — writes go through `apply_expense_correction()` (SECURITY DEFINER).

---

### `public.teams`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| `teams_select_org` | SELECT | Org members | organization_id in caller's active memberships |
| `teams_admin_all` | ALL | Admins | Active admin in org |

---

### `public.team_members`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| `team_members_select_org` | SELECT | Org members | organization_id in caller's active memberships |
| `team_members_admin_all` | ALL | Admins | Active admin in org |

---

### `public.organization_bank_accounts`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Org members can view bank accounts" | SELECT | Admins / Cashiers | Active admin or cashier in org |
| "Org admins can manage bank accounts" | ALL | Admins | Active admin in org |

---

### `public.balance_transfer_offers`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| `balance_transfer_offers_select` | SELECT | Transferrer / Recipient / Admin | transferrer_id=caller OR recipient_id=caller OR active admin in org |

No client INSERT/UPDATE policies — mutations only via SECURITY DEFINER RPCs.

---

### `public.expense_submission_drafts`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Users select own submission drafts" | SELECT | Submitter | user_id=caller AND active org membership |
| "Users insert own submission drafts" | INSERT | Submitter | user_id=caller AND active org membership |
| "Users update own submission drafts" | UPDATE | Submitter | user_id=caller |
| "Org admins select submission drafts in org" | SELECT | Admins | Active admin in org |

---

### `public.organization_features`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| `organization_features_select` | SELECT | Org members / Master admin | Org member via memberships OR is_master_admin() |
| `organization_features_all_master` | ALL | Master admin | is_master_admin() |

---

### `public.strategies`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| `strategies_select_authenticated` | SELECT | Authenticated | true |

---

### `public.contact_leads`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| (public INSERT) | INSERT | Anyone | No auth required |
| (master admin SELECT/UPDATE/DELETE) | SELECT/UPDATE/DELETE | Master admin | is_master_admin() |

---

### `public.form_field_option_usage_tracking`

| Policy Name | Op | Who Can | Condition Summary |
|---|---|---|---|
| "Users can view own form field option usage" | SELECT | Self | user_id=caller AND in org |
| "Users can insert own form field option usage" | INSERT | Self | user_id=caller AND in org |
| "Users can update own form field option usage" | UPDATE | Self | user_id=caller AND in org |

---

## 7. Storage Buckets

### `receipts`

| Property | Value |
|---|---|
| Public | `true` (made public in `20250106070000`) |
| File size limit | 10 MB (updated to 2 MB in `20250312000000`) |
| Allowed MIME types | image/jpeg, image/jpg, image/png, image/heic, image/heif, application/pdf |

**Path conventions:**
- Upload path (temp): `temp/{userId}/{filename}`
- Final path (after edge function moves): `{expenseId}/{filename}`

**Storage Policies (final state after `20260429181000`):**

| Policy Name | Op | Condition |
|---|---|---|
| `receipts_select_policy` | SELECT | bucket_id = 'receipts' (public — any read) |
| `receipts_insert_policy` | INSERT | bucket_id = 'receipts' AND auth.uid() IS NOT NULL |
| `receipts_update_policy` | UPDATE | bucket_id = 'receipts' AND auth.uid() IS NOT NULL |
| `receipts_delete_policy` | DELETE | bucket_id = 'receipts' AND auth.uid() IS NOT NULL |

### `expense-attachments`

| Property | Value |
|---|---|
| Public | `true` (set in `20260429181000`) |
| File size limit | 10 MB |
| Allowed MIME types | image/jpeg, image/jpg, image/png, image/heic, image/heif, application/pdf |

> Note: Storage policies for `expense-attachments` were set similarly to `receipts` in `20250106070000` and `20260429181000`.

---

## 8. Indexes

### `public.profiles`

| Index | Columns | Notes |
|---|---|---|
| `idx_profiles_reporting_engineer` | (reporting_engineer_id) | |
| `idx_profiles_cashier_assigned_engineer` | (cashier_assigned_engineer_id) | |
| `idx_profiles_assigned_cashier` | (assigned_cashier_id) | |
| `idx_profiles_cashier_assigned_location` | (cashier_assigned_location_id) | |
| `idx_profiles_organization_id` | (organization_id) | Added `20260529160000` |
| `idx_profiles_is_master_admin` | (is_master_admin) WHERE is_master_admin=true | |
| `idx_profiles_organization_employee_id_unique` | (organization_id, employee_id) WHERE both not null | UNIQUE — for employee_id login |

### `public.expenses`

| Index | Columns | Notes |
|---|---|---|
| `idx_expenses_transaction_number` | (transaction_number) | |
| `idx_expenses_organization_id` | (organization_id) | Added `20260529150000` |
| `idx_expenses_user_id` | (user_id) | Added `20260529150000` |
| `idx_expenses_org_status` | (organization_id, status) | Added `20260529150000` |
| `idx_expenses_assigned_engineer_status` | (assigned_engineer_id, status) WHERE not null | Added `20260529150000` |
| `idx_expenses_assigned_reviewer` | (assigned_reviewer_id) WHERE not null | Added `20260522140000` |
| `idx_expenses_approval_tier` | (organization_id, approval_tier, status) WHERE not null | Added `20260522140000` |
| `idx_expenses_batch_id` | (batch_id) WHERE not null | Added `20260513160000` |

### `public.attachments`

| Index | Columns | Notes |
|---|---|---|
| `idx_attachments_expense_id` | (expense_id) | Added `20260330120000` |
| `idx_attachments_org_expense_id` | (organization_id, expense_id) | Added `20260330120000` |

### `public.notifications`

| Index | Columns | Notes |
|---|---|---|
| `idx_notifications_user_id` | (user_id) | |
| `idx_notifications_read` | (user_id, read) | |
| `idx_notifications_created_at` | (created_at DESC) | |
| `idx_notifications_user_org_read` | (user_id, organization_id, read) | Added `20260529160000` |
| `idx_notifications_user_created` | (user_id, created_at DESC) | Added `20260529160000` |

### `public.money_assignments`

| Index | Columns | Notes |
|---|---|---|
| `idx_money_assignments_recipient` | (recipient_id, is_returned) | |
| `idx_money_assignments_cashier` | (cashier_id) | |
| `idx_money_assignments_active` | (recipient_id, is_returned) WHERE is_returned=false | Partial |

### `public.money_return_requests`

| Index | Columns | Notes |
|---|---|---|
| `idx_money_return_requests_requester` | (requester_id, status) | |
| `idx_money_return_requests_cashier` | (cashier_id, status) | |
| `idx_money_return_requests_pending` | (cashier_id, status) WHERE status='pending' | Partial |

### `public.locations`

| Index | Columns | Notes |
|---|---|---|
| `idx_locations_name` | (name) | |
| `idx_engineer_locations_engineer_id` | (engineer_id) | On engineer_locations |
| `idx_engineer_locations_location_id` | (location_id) | On engineer_locations |

### `public.teams / team_members`

| Index | Columns | Notes |
|---|---|---|
| `idx_teams_organization` | (organization_id) | |
| `idx_team_members_user` | (user_id) | |
| `idx_team_members_one_team_per_user_per_org` | (organization_id, user_id) | UNIQUE |

### `public.cash_transfer_history`

| Index | Columns | Notes |
|---|---|---|
| `idx_cash_transfer_history_mode` | (organization_id, payment_mode, transferred_at DESC) | |
| `idx_cash_transfer_history_source_bank` | (source_bank_account_id) | |

### `public.organization_bank_accounts`

| Index | Columns | Notes |
|---|---|---|
| `idx_org_bank_accounts_org` | (organization_id, is_active, created_at DESC) | |
| `idx_org_bank_accounts_org_bank` | (organization_id, bank_name) | |

### `public.balance_transfer_offers`

| Index | Columns | Notes |
|---|---|---|
| `idx_balance_transfer_offers_recipient_pending` | (recipient_id, status) WHERE pending | Partial |
| `idx_balance_transfer_offers_transferrer` | (transferrer_id, status) | |
| `idx_balance_transfer_offers_org_proposed` | (organization_id, proposed_at DESC) | |

### `public.expense_form_field_values`

| Index | Columns | Notes |
|---|---|---|
| `uq_form_field_values_expense_template` | (expense_id, template_id) WHERE template_id IS NOT NULL | UNIQUE |
| `uq_form_field_values_expense_branch` | (expense_id, branch_field_id) WHERE branch_field_id IS NOT NULL | UNIQUE |
| `idx_form_field_values_org_expense` | (organization_id, expense_id) | |

### `public.expense_batches`

| Index | Columns | Notes |
|---|---|---|
| `idx_expense_batches_org_created` | (organization_id, created_at DESC) | |
| `idx_expense_batches_user` | (user_id, created_at DESC) | |

### `public.organization_memberships`

| Index | Columns | Notes |
|---|---|---|
| `idx_org_memberships_org_active` | (organization_id) WHERE is_active=true | Added `20260529160000` |
| `idx_org_memberships_user_org` | (user_id, organization_id) | Added `20260701120000` |

### `public.expense_submission_drafts`

| Index | Columns | Notes |
|---|---|---|
| `idx_expense_submission_drafts_user_org_created` | (user_id, organization_id, created_at DESC) | |
| `idx_expense_submission_drafts_expires` | (expires_at) WHERE dismissed_at IS NULL | Partial |
| `idx_expense_submission_drafts_source_expense` | (source_expense_id) WHERE not null | |

### `public.expense_correction_logs`

| Index | Columns | Notes |
|---|---|---|
| `idx_expense_correction_logs_expense` | (expense_id, created_at DESC) | |

---

## 9. Known RLS Gap History

This section documents RLS bugs that were discovered and fixed, so future developers understand which patterns break.

### Gap 1: `expense_batches` missing `assigned_reviewer_id` in SELECT policy

**Migration that introduced the gap:** `20260513160000_expense_batches.sql`

**What happened:** The initial `expense_batches` SELECT policy only checked `assigned_engineer_id` on batch expenses, not `assigned_reviewer_id`. When the approval hierarchy feature added `assigned_reviewer_id` as the primary assignment column for TL/executive reviewers, hierarchy reviewers could not see batches for expenses assigned to them.

**Migration that fixed it:** `20260630120000_expense_batches_reviewer_select.sql`

**Fix:** Added `OR EXISTS (... ex.assigned_reviewer_id = auth.uid())` arm to the SELECT policy.

**Pattern to avoid:** When adding a new assignment column to `expenses`, always audit all related tables (batches, attachments, line_items, correction_logs) to ensure their SELECT policies include the new column.

---

### Gap 2: `expenses` hierarchy reviewer SELECT missing `assigned_engineer_id` arm

**Migration that introduced the gap:** `20260524130000_expense_review_select_rls.sql`

**What happened:** The initial hierarchy reviewer SELECT policy only checked `assigned_reviewer_id`, not `assigned_engineer_id`. During the early hierarchy implementation, some expenses were routed with only `assigned_engineer_id` set (not `assigned_reviewer_id`). These were invisible to hierarchy reviewers.

**Migration that fixed it:** `20260524180000_expense_hierarchy_review_select_expand.sql`

**Fix:** Added `OR e.assigned_engineer_id = auth.uid()` to the hierarchy reviewer SELECT condition.

---

### Gap 3: `money_return_requests` RLS missing organization scope

**Migration that introduced the gap:** Initial `20250124000000_create_money_return_requests.sql` and subsequent `20250131000003` fix.

**What happened:** The original and first-fix versions of the money_return_requests RLS policies relied on role checks via `user_roles` table only, without cross-org validation. A cashier in Org A could potentially approve a return request from a user in Org B.

**Migration that fixed it:** `20260423130000_fix_money_return_requests_rls_without_org_column.sql`

**Fix:** Rewrote all three policies to use `organization_memberships` JOIN to ensure requester and cashier share a common active organization, without requiring an `organization_id` column on the table itself.

---

### Gap 4: `expenses` — `total_amount` vs `amount` column bug

**Not an RLS gap but a critical schema naming issue.**

The `expenses` table column is named `total_amount`. An early version of the Money Dashboard hook queried `expenses.amount` (non-existent column), causing 400 errors from PostgREST. Any future queries against `expenses` must use `total_amount`.

---

### Gap 5: `expense_status` enum `edited` in same transaction

**Migration `20260513139900`** adds `'edited'` to `expense_status` enum. PostgreSQL raises error `55P04` if you `ADD VALUE` to an enum and reference the new value in the same transaction. The migration was intentionally split: `20260513139900` only does `ALTER TYPE ... ADD VALUE`; `20260513140000` uses `'edited'` in a separate transaction.

Same pattern for `level_1_verified` / `level_2_verified` in `20260524250000` + `20260524250100`.

---

### Gap 6: `app_role` enum `team_leader` / `executive` in same transaction

Same PostgreSQL 55P04 constraint. `20260522139900` only adds the values; `20260522140000` (approval hierarchy) uses them in the next migration.

---

## 10. Migration Changelog

| Filename | Change Summary |
|---|---|
| `master_migration/02_schema.sql` | Full base schema: core types, all tables, triggers, functions, sequences, RLS enable |
| `010626_1430_manager_level2_queue_visibility.sql` | Fix `list_manager_pending_expenses` + `manager_expense_visible_to_user` for level_2 queue visibility; backfill misrouted expenses |
| `080608_1430_balance_transfer_offers.sql` | Add `balance_transfer_offers` table; RPCs: propose, accept, reject, cancel; helper functions for role/bank resolution |
| `20250106070000_fix_receipts_bucket_policies.sql` | Make receipts bucket public (10 MB); replace storage policies |
| `20250108000000_add_balance_column_and_fix_admin_access.sql` | Add `profiles.balance`; add admin update/insert/delete policies on profiles |
| `20250109000000_add_reporting_engineer_to_profiles.sql` | Add `profiles.reporting_engineer_id`; add engineer-managed-profiles SELECT policy |
| `20250110000000_create_expense_categories.sql` | Create `expense_categories` table with admin-only CRUD policies |
| `20250111000000_add_category_to_expenses.sql` | Add `expenses.category TEXT` column |
| `20250111000001_fix_expense_update_policy.sql` | Fix expense UPDATE policy to allow submitted (not just draft) status |
| `20250111000002_ensure_admin_only_category_management.sql` | Rebuild expense_categories policies using `has_role()` |
| `20250112000000_allow_engineers_to_update_expenses.sql` | Add engineer UPDATE policy for assigned expenses (submitted → verified) |
| `20250113000000_create_settings_table.sql` | Create `settings` table; admin-only RLS; seed `engineer_approval_limit` |
| `20250114000000_create_notifications_table.sql` | Create `notifications` table with RLS; `update_notifications_updated_at` trigger |
| `20250115000000_allow_engineers_read_settings.sql` | Allow engineers and authenticated to read settings |
| `20250116000000_allow_cashiers_view_all_roles.sql` | Allow cashiers to view all user_roles |
| `20250117000000_allow_engineers_employees_view_cashier_admin_roles.sql` | Engineers/employees can view cashier/admin roles; cashiers can view admin roles |
| `20250118000000_admin_reset_user_password.sql` | `admin_reset_user_password` RPC (skeleton; actual reset via Supabase Admin API) |
| `20250118000001_track_money_assignments.sql` | Create `money_assignments` table; `get_original_cashier` function |
| `20250118000002_assign_engineers_to_cashiers.sql` | Add `profiles.cashier_assigned_engineer_id`; `cashier_can_manage_employee` function |
| `20250119000000_allow_users_delete_submitted_expenses.sql` | Users can delete own submitted expenses; admins can delete any |
| `20250120000000_enable_realtime_notifications.sql` | REPLICA IDENTITY FULL on notifications, expenses, profiles |
| `20250121000000_add_assigned_cashier_to_employees.sql` | Add `profiles.assigned_cashier_id` |
| `20250122000000_create_locations_and_engineer_locations.sql` | Create `locations` + `engineer_locations` tables with RLS |
| `20250123000000_add_transaction_number_to_expenses.sql` | Add `expenses.transaction_number`; sequence + trigger for auto-assignment |
| `20250124000000_create_money_return_requests.sql` | Create `money_return_requests` table with RLS |
| `20250125000000_add_location_based_cashier_assignment.sql` | Add `profiles.cashier_assigned_location_id`; location-based cashier sync triggers |
| `20250126000000_add_attachment_required_above_amount_setting.sql` | Seed `attachment_required_above_amount` setting |
| `20250127000000_clear_all_data_for_deployment.sql` | Data cleanup for deployment (no schema changes) |
| `20250128000000_delete_all_users_except_admin.sql` | Data cleanup: remove non-admin users (no schema changes) |
| `20250129000000_create_cash_transfer_history.sql` | Create `cash_transfer_history` table |
| `20250130000000_add_organization_id_to_cash_transfer_history.sql` | Add `organization_id` to cash_transfer_history; update RLS |
| `20250130000001_allow_pdf_in_receipts_bucket.sql` | Add PDF to receipts bucket allowed MIME types |
| `20250130000002_allow_edit_rejected_expenses.sql` | Allow users to update rejected expenses |
| `20250130000003_add_file_size_to_attachments.sql` | Add `attachments.file_size BIGINT` |
| `20250130000004_create_expense_form_fields.sql` | Create `expense_form_field_templates`, `expense_category_form_fields`, `expense_form_field_values` tables |
| `20250130000005_track_category_usage.sql` | Create `category_usage_tracking` table; `increment_category_usage` function |
| `20250130000006_allow_admin_edit_approved_expenses.sql` | Allow admin UPDATE on approved expenses |
| `20250131000000_fix_get_cashier_for_engineer_organization_filter.sql` | Fix `get_cashier_for_engineer` to filter by org |
| `20250131000001_diagnose_cashier_assignment.sql` | Add `diagnose_cashier_assignment` diagnostic RPC |
| `20250131000002_simplify_get_cashier_location_match.sql` | Simplify `get_cashier_for_engineer` location-match logic |
| `20250131000003_fix_money_return_requests_rls.sql` | Fix money_return_requests RLS (first attempt) |
| `20250131000004_fix_money_return_balance_and_history.sql` | Fix `approve_money_return_update_balances` + `log_money_return_to_history` |
| `20250131000005_add_cashier_to_admin_return.sql` | Add `cashier_return_money_to_admin` RPC |
| `20250201000000_create_master_admin_system.sql` | Master admin system: `master_admin_memberships`, org payment fields, `subscription_plans`, `organization_payments`, announcements; `is_master_admin()` function |
| `20250201000001_add_activity_tracking.sql` | Add `last_activity_at` to orgs; activity tracking triggers |
| `20250201000002_allow_null_org_id_for_master_admin.sql` | Make `profiles.organization_id` nullable for master admin |
| `20250201000003_enhance_storage_metrics.sql` | Enhanced storage metrics RPCs |
| `20250202000000_block_cashiers_from_creating_expenses.sql` | Update expense INSERT policy to only allow employee/admin by default |
| `20250220000000_create_contact_leads.sql` | Create `contact_leads` table |
| `20250302000000_add_transfer_backdate_columns.sql` | Add backdate tracking columns to cash_transfer_history |
| `20250303200000_allow_admin_restore_rls.sql` | Add admin INSERT/UPDATE policies on expenses, line_items, attachments, audit_logs for restore |
| `20250305120000_add_max_users_per_org.sql` | Add `organizations.max_users`; enforce via trigger |
| `20250305130000_update_max_users_error_message.sql` | Update max_users error message |
| `20250305140000_allow_cashier_expense_submission_setting.sql` | Add `allow_cashier_expense_submission` setting; update expense INSERT policy |
| `20250312000000_update_file_upload_limit_to_2mb.sql` | Update file upload limit to 2MB |
| `20251005171552_6159c659-1917-425b-813e-9ef879ba396e.sql` | **Initial schema** (earliest applied): core types, tables, triggers, RLS, storage bucket |
| `20251006063119_setup_storage_buckets.sql` | Setup storage buckets with policies |
| `20251006064514_fix_storage_policies.sql` | Fix storage bucket policies |
| `20251007091500_expand_expense_categories.sql` | Expand expense_category_v2 enum with more categories |
| `20260330120000_add_attachments_indexes_for_submit.sql` | Add `idx_attachments_expense_id`, `idx_attachments_org_expense_id` |
| `20260402100000_allow_org_members_select_expense_form_fields.sql` | Allow all org members to SELECT expense form field templates |
| `20260402153000_allow_submit_draft_to_submitted_expense_update.sql` | Allow draft→submitted expense UPDATE |
| `20260408090000_org_expense_form_builder_and_bulk.sql` | Create `organization_expense_form_fields` table; bulk operations RPC |
| `20260420130000_create_organization_bank_accounts.sql` | Create `organization_bank_accounts` table with RLS |
| `20260420130500_extend_cash_transfer_history_bank_mode.sql` | Add `payment_mode`, bank snapshot columns to cash_transfer_history |
| `20260421101500_add_admin_to_admin_transfer_type.sql` | Add `admin_to_admin` to transfer_type CHECK constraint |
| `20260421113000_backfill_approved_money_returns_to_history.sql` | Backfill old approved money returns into cash_transfer_history |
| `20260423120000_allow_cashier_balance_updates_for_managed_users.sql` | Add `cashier_can_manage_engineer` function; replace cashier UPDATE policy on profiles |
| `20260423123000_fix_get_cashier_for_engineer_memberships.sql` | Fix `get_cashier_for_engineer` to use organization_memberships |
| `20260423130000_fix_money_return_requests_rls_without_org_column.sql` | Final fix for money_return_requests RLS using org membership JOIN |
| `20260428125500_add_note_to_money_return_requests.sql` | Add `money_return_requests.note`; update `log_money_return_to_history` to include it |
| `20260429181000_make_attachment_buckets_public_and_pdf_viewable.sql` | Make receipts + expense-attachments buckets public; add HEIC/HEIF support |
| `20260513120000_strategies_tenant.sql` | Create `strategies` reference table |
| `20260513120100_organizations_subdomain_strategy.sql` | Add `subdomain`, `strategy_slug` to organizations |
| `20260513120200_organization_features.sql` | Create `organization_features` table with dynamic RLS |
| `20260513120300_profiles_employee_id.sql` | Add `profiles.employee_id` with org-scoped unique index |
| `20260513120400_tenant_lookup_rpc.sql` | Add `get_organization_by_subdomain`, `get_organization_feature_enabled` RPCs |
| `20260513139900_expense_status_add_edited_enum.sql` | Add `'edited'` to expense_status enum (isolated transaction) |
| `20260513140000_expense_corrections_edited_status.sql` | Create `expense_correction_logs`; `apply_expense_correction` RPC; update engineer UPDATE policy |
| `20260513150000_org_admin_expense_select_rls.sql` | Add org-memberships-based admin SELECT policy on expenses |
| `20260513160000_expense_batches.sql` | Create `expense_batches` table; add `expenses.batch_id`; add `batch_expense_attachment_mode` to org_settings |
| `20260514120000_conditional_dropdown_branches.sql` | Create `expense_form_field_option_branches` table; extend form_field_values for branch_field_id |
| `20260515120000_employee_auth_email_rpc.sql` | `get_employee_auth_email` pre-auth RPC (initial version) |
| `20260516120000_category_form_fields_ask_once_per_batch.sql` | Add `ask_once_per_batch` to expense_category_form_fields |
| `20260516130000_tenant_email_sign_in_check.sql` | `email_can_sign_in_on_tenant` RPC |
| `20260516140000_tenant_sign_in_redirect_rpc.sql` | `get_tenant_sign_in_subdomain_for_email/user` RPCs |
| `20260517120000_profiles_preferred_language.sql` | Add `profiles.preferred_language` with CHECK IN ('en','hi','gu') |
| `20260522120000_tenant_lookup_logo_url.sql` | Extend `get_organization_by_subdomain` to return logo_url |
| `20260522130000_form_field_option_usage_tracking.sql` | Create `form_field_option_usage_tracking` table; `increment_form_field_option_usage` RPC |
| `20260522139900_app_role_add_hierarchy_roles.sql` | Add `team_leader`, `executive` to app_role enum (isolated transaction) |
| `20260522140000_approval_hierarchy.sql` | Create `teams`, `team_members`; add `expenses.approval_tier` + `assigned_reviewer_id`; `sync_user_role_from_membership` trigger; hierarchy RLS policies |
| `20260522150000_harden_employee_auth_email_rpc.sql` | Rate-limited version of `get_employee_auth_email`; `employee_auth_lookup_attempts` table |
| `20260523120000_require_immediate_supervisor.sql` | Add `require_immediate_supervisor` to organization_settings |
| `20260524120000_fix_get_employee_auth_email_volatile.sql` | Fix `get_employee_auth_email` to VOLATILE (was incorrectly STABLE) |
| `20260524130000_expense_review_select_rls.sql` | Add hierarchy reviewer SELECT policies on expenses |
| `20260524140000_expense_review_update_rls.sql` | Add hierarchy reviewer UPDATE policy on expenses |
| `20260524150000_fix_hierarchy_reviewer_update_rls.sql` | Refine hierarchy reviewer UPDATE policy |
| `20260524160000_expense_review_rpc_and_rls.sql` | Add `review_advance_expense_hierarchy_tier`, `review_verify_expense`, `review_reject_expense` RPCs |
| `20260524170000_review_rpc_return_expense.sql` | Update review RPCs to return full expense row |
| `20260524180000_expense_hierarchy_review_select_expand.sql` | Expand hierarchy SELECT policy to include assigned_engineer_id arm |
| `20260524190000_list_organizations_for_dev_login.sql` | `list_organizations_for_dev_login` dev RPC |
| `20260524190100_fix_dev_tenant_list_use_slug.sql` | Fix dev org list + `get_organization_by_subdomain` to fall back to slug |
| `20260524200000_tl_executive_expense_submit_and_select.sql` | Expand expense INSERT to include team_leader/executive; expand hierarchy SELECT |
| `20260524210000_list_hierarchy_reviewer_expenses_rpc.sql` | `list_hierarchy_reviewer_expenses` RPC; backfill misrouted hierarchy expenses |
| `20260524220000_fix_hierarchy_reviewer_act_permissions.sql` | Fix `expense_hierarchy_reviewer_can_act`; add `reviewer_can_act_on_expense` wrapper |
| `20260524230000_fix_hierarchy_verify_advance.sql` | Add `get_expense_review_head` RPC; refine advance function approval_tier check |
| `20260524240000_hierarchy_tl_verify_fix.sql` | Fix TL can act on tier='engineer' rows (legacy misrouted); data backfill |
| `20260524250000_hierarchy_verification_statuses.sql` | Add `level_1_verified`, `level_2_verified` to expense_status (isolated transaction) |
| `20260524250100_hierarchy_verification_statuses_apply.sql` | Update all review RPCs + RLS to use new level_1/2_verified statuses |
| `20260524260000_fix_hierarchy_verify_status_by_role.sql` | `review_advance_expense_hierarchy_tier` now sets status by verifier's role |
| `20260524270000_backfill_level2_queue_after_tl_verify.sql` | Backfill: route level_1_verified expenses to executive |
| `20260524280000_manager_review_queue_and_managing_engineer.sql` | `list_manager_reviewer_expenses` RPC; fix assigned_engineer_id preservation on advance |
| `20260524290000_expand_manager_team_visibility.sql` | Manager can see team members' expenses; update `list_manager_reviewer_expenses` |
| `20260524300000_fix_level2_verified_manager_queue.sql` | Fix manager queue for level_2_verified; data backfill |
| `20260524310000_executive_handoff_to_manager_level2.sql` | Auto-resolve team manager on executive→engineer advance; `list_manager_level2_expenses` RPC |
| `20260524320000_manager_sees_stuck_executive_queue.sql` | `manager_expense_visible_to_user`; `expense_ready_for_manager_review`; redesign manager queue RPCs |
| `20260524330000_manager_verify_auto_repair.sql` | `expense_executive_handoff_in_audit`; `repair_expense_for_manager_review`; auto-repair in verify flow |
| `20260528183500_manager_visibility_stable_rpc.sql` | Add `expenses.approved_by/approved_at`; stabilize manager visibility with 2-level supervisor chain |
| `20260529120000_manager_assigned_keep_approved_visible.sql` | Manager queue includes verified/approved/rejected if manager was assigned |
| `20260529120000_manager_queue_skipped_tiers.sql` | `org_hierarchy_tier_enabled`; manager queue handles disabled tiers |
| `20260529130000_resubmitted_expense_ids_rpc.sql` | `get_resubmitted_expense_ids`, `get_reviewer_corrected_expense_ids` RPCs |
| `20260529140000_daily_project_expense_report.sql` | Add `daily_expense_report_config` to organization_settings |
| `20260529140000_dashboard_expense_summary_rpc.sql` | `get_dashboard_expense_summary`, `get_org_role_balance_totals` RPCs |
| `20260529150000_dashboard_expense_indexes.sql` | Add 4 performance indexes on expenses |
| `20260529160000_large_org_perf_indexes.sql` | Add performance indexes on profiles, org_memberships, notifications |
| `20260529170000_expense_submission_drafts.sql` | Create `expense_submission_drafts` table with 7-day TTL |
| `20260529180000_attachments_restore_upsert_rls.sql` | Add admin INSERT/UPDATE on attachments, line_items, audit_logs for restore |
| `20260530120000_fix_public_schema_grants_after_restore.sql` | Fix public schema grants post-restore |
| `20260530130000_admin_restore_form_field_values_rpc.sql` | `is_org_admin`, `admin_restore_upsert_form_field_values` RPCs for bulk restore |
| `20260530140000_teams_enabled_feature.sql` | Document `teams_enabled` feature key (comment only) |
| `20260530150000_my_teams_overview_rpc.sql` | `list_my_teams_overview`, `list_team_expenses_for_leader` RPCs; helper functions |
| `20260530160000_backfill_teams_enabled_from_hierarchy.sql` | Backfill: set teams_enabled=true for orgs with approval_hierarchy=true |
| `20260531120000_expense_submitter_profiles_rpc.sql` | `get_expense_submitter_profiles` RPC |
| `20260531140000_soft_delete_audit_retention.sql` | Add `deactivated_at` to profiles + expense_categories; `deactivate_organization_member/category` RPCs |
| `20260619130000_expense_submitter_profiles_employee_id.sql` | Add `employee_id` to `get_expense_submitter_profiles` return type |
| `20260619140000_my_teams_hierarchy_fallback.sql` | Teams overview fallback to supervisor hierarchy when no formal teams |
| `20260619150000_fix_my_teams_hierarchy_rpc.sql` | Fix `get_subordinate_user_ids` return type; helper status predicates |
| `20260620120000_hierarchy_reviewer_expense_history.sql` | Expand `list_hierarchy_reviewer_expenses` to include historical expenses via audit_logs |
| `20260621120000_expense_form_field_display_access.sql` | `get_expense_form_field_display` RPC v1; fix form_field_values SELECT RLS |
| `20260621140000_form_fields_display_v2_and_self_transfer.sql` | Simplify form field values SELECT RLS; v2 `get_expense_form_field_display`; fix `propose_balance_transfer_offer` for admin self-transfer |
| `20260626120000_expense_batches_reviewer_rls.sql` | Add `assigned_reviewer_id` arm to expense_batches SELECT policy |
| `20260629120000_add_storage_path_to_attachments.sql` | Add `attachments.storage_path` |
| `20260629120000_form_field_display_labels.sql` | Fix `get_expense_form_field_display` label resolution order |
| `20260630120000_custom_form_fields_review_fix.sql` | Final `get_expense_form_field_display` RPC; fix form_field_values SELECT RLS with org_id guard |
| `20260630120000_expense_batches_reviewer_select.sql` | ⚠️ Final expense_batches SELECT policy with assigned_reviewer_id arm |
| `20260701120000_expense_form_field_values_atomic_write.sql` | Deduplicate form_field_values; add UNIQUE constraints; `replace_expense_form_field_values` atomic write RPC |
| `20260702120000_expense_review_admin_approve_rpc.sql` | `review_admin_verify_expense`, `review_approve_expense` RPCs; update admin/engineer UPDATE RLS |
| `20260703120000_base_field_input_customization.sql` | Add `input_type`, `options` to organization_expense_form_fields; expand field_kind to include 'base' |
| `290529_1600_fix_propose_balance_transfer_offer_v_bank.sql` | Fix PL/pgSQL variable access bug in `propose_balance_transfer_offer` for bank transfers |
| `290529_1700_cashier_accountant_mode.sql` | Add `is_accountant_cashier` to org_memberships; `is_accountant_cashier()` function; accountant cashier SELECT policies; write policy guards |
| `290529_1730_accountant_transfer_history_read.sql` | Add accountant cashier SELECT on cash_transfer_history |
| `290601_1200_manager_reviewer_expenses_visibility.sql` | Final `list_manager_reviewer_expenses` + `list_manager_pending_expenses` RPCs |
