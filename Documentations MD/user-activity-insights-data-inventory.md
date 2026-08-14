# User Activity Insights — Data Inventory / Record of Processing

**Document type:** Data inventory and record of processing activities  
**For feature:** User Activity Insights (PesoWise)  
**Doc status:** Technical record — review with legal/DPO before production rollout  
**Last updated:** 2026-07-13  
**Related:** [user-activity-insights.md](./user-activity-insights.md) · [user-activity-insights-privacy-notice.md](./user-activity-insights-privacy-notice.md) · [user-activity-insights-dpia.md](./user-activity-insights-dpia.md)

---

## 1. Overview

This document inventories every field collected by the User Activity Insights feature, its source, purpose, who can access it, recommended retention, and how it can be exported or deleted in response to a data principal request.

---

## 2. Data source

| Item | Detail |
|------|--------|
| **Collected by** | PesoWise frontend (UserActivityTracker component) via Supabase RPCs |
| **Stored in** | Supabase PostgreSQL (`public` schema) |
| **Storage location** | Supabase project hosting region (confirm with your Supabase project settings) |
| **Data subjects** | Employees and authorised PesoWise users of enabled organisations |
| **Admin viewers** | Organisation admins (via `/admin/user-activity` route) |
| **Master admin access** | PesoWise master admin (via Supabase SQL / admin dashboard) |

---

## 3. Field inventory

### Table: `public.user_activity_sessions`

| Field | Type | Purpose | Access | Retention recommendation | Legal basis placeholder |
|-------|------|---------|--------|--------------------------|------------------------|
| `id` | uuid | Primary key; links heartbeats and session end | Admin + master admin | Same as session data | — |
| `organization_id` | uuid | Scopes data to org; enforces RLS isolation | Admin + master admin | Same as session data | — |
| `user_id` | uuid | Links to auth.users; enables per-user reporting | Admin + master admin | Same as session data | Legitimate interest / employment |
| `started_at` | timestamptz | Session start timestamp | Admin + master admin | 180 days | Legitimate interest / employment |
| `ended_at` | timestamptz | Session end timestamp (null until tab closes) | Admin + master admin | 180 days | Legitimate interest / employment |
| `last_seen_at` | timestamptz | Most recent heartbeat or start time | Admin + master admin | 180 days | Legitimate interest / employment |
| `visible_seconds` | integer | Cumulative visible PesoWise time in this session | Admin + master admin | 180 days | Legitimate interest / employment |
| `heartbeat_count` | integer | Number of 60-second heartbeat ticks received | Admin + master admin | 180 days | Operational / system health |
| `user_agent` | text | Browser user agent string (device/browser type) | Admin + master admin | 180 days | Operational / security |
| `created_at` | timestamptz | Row creation timestamp | Admin + master admin | 180 days | — |

### Table: `public.user_activity_daily_rollups`

| Field | Type | Purpose | Access | Retention recommendation | Legal basis placeholder |
|-------|------|---------|--------|--------------------------|------------------------|
| `id` | uuid | Primary key | Admin + master admin | Same as rollup data | — |
| `organization_id` | uuid | Org scoping / RLS | Admin + master admin | Same as rollup data | — |
| `user_id` | uuid | Per-user daily summary | Admin + master admin | Same as rollup data | — |
| `activity_date` | date | The calendar date of the rollup | Admin + master admin | 180 days | Legitimate interest / employment |
| `first_seen_at` | timestamptz | First session start that day | Admin + master admin | 180 days | Legitimate interest / employment |
| `last_seen_at` | timestamptz | Last session heartbeat that day | Admin + master admin | 180 days | Legitimate interest / employment |
| `visible_seconds` | integer | Total visible PesoWise time that day | Admin + master admin | 180 days | Legitimate interest / employment |
| `session_count` | integer | Number of sessions that day | Admin + master admin | 180 days | Legitimate interest / employment |
| `expenses_submitted_count` | integer | Number of expenses submitted that day (from trigger) | Admin + master admin | 180 days | Operational |
| `is_active` | boolean | True if visible_seconds > threshold | Admin + master admin | 180 days | Operational |
| `updated_at` | timestamptz | Last rollup update | Admin + master admin | 180 days | — |

### Table: `public.user_activity_notice_acknowledgements`

| Field | Type | Purpose | Access | Retention recommendation | Legal basis placeholder |
|-------|------|---------|--------|--------------------------|------------------------|
| `id` | uuid | Primary key | User (own) + org admin + master admin | Until feature disabled or erasure request | — |
| `organization_id` | uuid | Org scoping | User (own) + org admin + master admin | — | — |
| `user_id` | uuid | Which user acknowledged | User (own) + org admin + master admin | Until feature disabled or erasure request | Compliance record |
| `notice_version` | text | Which version of the notice was acknowledged | User (own) + org admin + master admin | Until feature disabled or erasure request | Compliance record |
| `acknowledged_at` | timestamptz | When the user clicked "I understand" | User (own) + org admin + master admin | Until feature disabled or erasure request | Compliance / consent record |
| `created_at` | timestamptz | Row creation timestamp | User (own) + org admin + master admin | Until feature disabled or erasure request | — |

### Table: `public.user_activity_feature_audit_logs` *(if SQL file 13 applied)*

| Field | Type | Purpose | Access | Retention recommendation | Legal basis placeholder |
|-------|------|---------|--------|--------------------------|------------------------|
| `id` | uuid | Primary key | Org admin + master admin | Long-term (compliance audit) | Accountability |
| `organization_id` | uuid | Which org the feature was toggled for | Org admin + master admin | Long-term | — |
| `actor_user_id` | uuid | Master admin who performed the toggle | Master admin | Long-term | Accountability |
| `feature_key` | text | Always `'user_activity_insights'` | Org admin + master admin | Long-term | — |
| `action` | text | `'enabled'` or `'disabled'` | Org admin + master admin | Long-term | Accountability |
| `confirmation_version` | text | Version of disclaimer accepted | Master admin | Long-term | Compliance |
| `confirmation_text` | text | Snapshot of disclaimer text accepted | Master admin | Long-term | Compliance |
| `created_at` | timestamptz | When the action was performed | Org admin + master admin | Long-term | Accountability |

---

## 4. Access controls summary

| Layer | Control |
|-------|---------|
| **RLS** | All activity tables have Row-Level Security enabled. Users cannot read other users' data. |
| **SECURITY DEFINER RPCs** | All write and cross-user read operations go through server-side RPCs that validate the caller's role and org membership. |
| **Admin-only route** | `/admin/user-activity` is accessible only to users with `admin` role (enforced in React + RLS). |
| **Feature flag** | Data collection only starts if `user_activity_insights` is enabled for the org in `organization_features`. |
| **Notice gate** | Tracking does not start until the user has acknowledged the notice (`noticeAcknowledged` prop). |

---

## 5. Deletion process

| Target | SQL file | Notes |
|--------|----------|-------|
| Retention cleanup (all orgs, age-based) | `10_retention_cleanup_activity_data_DO_NOT_RUN_AUTOMATICALLY.sql` | Preview → approve → uncomment DELETE |
| Access request export | `11_export_user_activity_data_for_request.sql` | Read-only; produce CSV for user |
| Individual erasure request | `12_erasure_user_activity_data_DO_NOT_RUN_AUTOMATICALLY.sql` | Preview → approve → uncomment DELETE |

---

## 6. Export / access process

1. Receive access request from data principal.
2. Run `11_export_user_activity_data_for_request.sql` with user's email and org name.
3. Export results as CSV from Supabase SQL Editor (Download button).
4. Send to data principal within legally required response window.
5. Log the request, requester identity, handler, date, and delivery method.

---

## 7. Retention enforcement

There is no automatic scheduled deletion. The organisation is responsible for:

1. Deciding the retention period (recommended: 180 days).
2. Running `10_retention_cleanup_activity_data_DO_NOT_RUN_AUTOMATICALLY.sql` periodically with appropriate approvals.
3. Documenting each cleanup run (who ran it, when, row counts deleted).

A scheduled SQL job or Supabase Edge Function cron can automate retention cleanup — this requires separate implementation and approval before activation.
