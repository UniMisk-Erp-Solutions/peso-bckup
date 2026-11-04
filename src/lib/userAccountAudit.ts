/**
 * DOC-158: client side of the immutable user-account audit history.
 *
 * The browser never WRITES audit rows and never supplies an actor: rows are produced by database triggers and by
 * service-role edge functions that derive the actor from the authenticated JWT. This module only
 *   - reads the history (RLS limits it to the viewer's own organization),
 *   - asks for the "how much history rides on this account" summary,
 *   - records the admin's explicit confirmation of a name + login-email re-assignment,
 *   - registers "I am changing MY OWN password" so the change is attributed to the user.
 */
import { supabase } from "@/integrations/supabase/client";

// src/integrations/supabase/types.ts predates these objects (same narrow, commented escape other lib files use).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type UserAuditEvent = {
  event_id: string;
  occurred_at: string;
  event_type: string;
  summary: string;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_type: string;
  source: string;
  field_name: string | null;
  old_value: unknown;
  new_value: unknown;
  identity_name: string | null;
  identity_email: string | null;
  request_id: string | null;
  execution_context: string | null;
};

export type IdentityHistorySummary = {
  expense_count: number;
  audit_log_count: number;
  balance_ledger_count: number;
  batch_count: number;
  account_audit_event_count: number;
  account_created_at: string | null;
  first_expense_at: string | null;
  has_history: boolean;
};

/** Event types that concern credentials. Their rows carry no value, and the UI must never render one even if one existed. */
const PASSWORD_EVENT_TYPES = new Set([
  "password_changed", "password_reset_requested", "password_reset_completed", "admin_password_reset", "password_reset_failed",
]);
export function isPasswordEvent(eventType: string): boolean {
  return PASSWORD_EVENT_TYPES.has(eventType);
}

export const AUDIT_EVENT_LABELS: Record<string, string> = {
  baseline_snapshot: "State when audit history started",
  user_created: "Account created",
  user_deleted: "Account deleted",
  membership_added: "Added to organization",
  membership_removed: "Removed from organization",
  profile_updated: "Profile updated",
  email_changed: "Email changed",
  employee_id_changed: "Employee ID changed",
  role_changed: "Role changed",
  legacy_role_changed: "Legacy role record changed",
  accountant_cashier_changed: "Accountant-cashier setting changed",
  supervisor_changed: "Supervisor changed",
  team_changed: "Team changed",
  cashier_assignment_changed: "Cashier assignment changed",
  location_changed: "Location changed",
  profile_status_changed: "Profile status changed",
  organization_changed: "Organization changed",
  master_admin_flag_changed: "Master admin flag changed",
  user_deactivated: "User deactivated",
  user_reactivated: "User reactivated",
  user_banned: "Login suspended",
  user_unbanned: "Login restored",
  password_changed: "Password changed",
  password_reset_requested: "Password reset requested",
  password_reset_completed: "Password reset completed",
  admin_password_reset: "Password reset by administrator",
  account_identity_changed: "Name and email changed together (confirmed)",
  user_creation_failed: "User creation failed",
  email_change_failed: "Email change failed",
  deactivation_failed: "Deactivation failed",
  reactivation_failed: "Reactivation failed",
  password_reset_failed: "Password reset failed",
  account_change_denied: "Change denied",
  auth_ban_failed: "Login suspension failed",
  auth_unban_failed: "Login restore failed",
  auth_sync_recovered: "Login state re-synchronised",
};

export const AUDIT_SOURCE_LABELS: Record<string, string> = {
  user_management: "User Management",
  master_admin: "Master Admin",
  bulk_upload: "Bulk upload",
  admin_edge_function: "Admin service",
  auth_admin: "Sign-in administration",
  auth_recovery: "Password recovery",
  password_reset: "Password reset",
  account_settings: "Account settings",
  self_service: "Self-service",
  auth_flow: "Sign-in service (unattributed)",
  database: "Direct database change (unattributed)",
  system: "System",
  migration: "Migration",
  historical_backfill: "Historical record",
};

export function auditEventLabel(eventType: string): string {
  return AUDIT_EVENT_LABELS[eventType] ?? eventType.replace(/_/g, " ");
}
export function auditSourceLabel(source: string): string {
  return AUDIT_SOURCE_LABELS[source] ?? source.replace(/_/g, " ");
}

/** Renders a jsonb scalar for display. Password events never show a value. */
export function formatAuditValue(eventType: string, value: unknown): string {
  if (isPasswordEvent(eventType)) return "";
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value === "" ? "—" : value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("name" in o || "email" in o) return [o.name, o.email].filter(Boolean).join(" · ");
    return JSON.stringify(value);
  }
  return String(value);
}

/** Who made the change, as the history should say it: the human, never just "service_role". */
export function describeActor(e: Pick<UserAuditEvent, "actor_user_id" | "actor_name" | "actor_type" | "execution_context" | "source">): {
  name: string;
  note: string | null;
} {
  if (e.actor_user_id) {
    return { name: e.actor_name || "Administrator", note: e.execution_context === "service_role" ? "via admin service" : null };
  }
  if (e.source === "migration") return { name: "Audit history setup", note: null };
  if (e.source === "historical_backfill") return { name: "Not recorded", note: "before audit history" };
  return { name: "Not attributed", note: e.actor_type === "service_role" ? "service-level change" : "automatic change" };
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** The "this may re-assign another person's account" rule: BOTH the display name and the login email change on one account. */
export function identityChangeNeedsWarning(p: { oldName: string; newName: string; oldEmail: string; newEmail: string }): boolean {
  return norm(p.oldName) !== norm(p.newName) && norm(p.oldEmail) !== norm(p.newEmail);
}

export const IDENTITY_WARNING_TEXT =
  "This account already has historical activity. Changing both the user's name and login email may reassign another person's account. Creating a new user is recommended.";

export async function fetchIdentityHistorySummary(organizationId: string, userId: string): Promise<IdentityHistorySummary | null> {
  const { data, error } = await db.rpc("get_user_identity_history_summary_v1", { p_organization_id: organizationId, p_target_user_id: userId });
  if (error || !data) return null;
  return data as IdentityHistorySummary;
}

/** Throws on failure: the confirmation is part of the audit trail, so an unrecorded confirmation must not proceed. */
export async function confirmIdentityChange(p: { organizationId: string; userId: string; newName: string; newEmail: string }): Promise<void> {
  const { error } = await db.rpc("record_account_identity_change_confirmation_v1", {
    p_organization_id: p.organizationId,
    p_target_user_id: p.userId,
    p_new_name: p.newName,
    p_new_email: p.newEmail,
  });
  if (error) throw new Error("Could not record the confirmation in the audit history; the change was not made.");
}

/** Called right before supabase.auth.updateUser({ password }) from account settings. Best effort: never blocks the user. */
export async function registerMyAccountAuditContext(): Promise<void> {
  try {
    await db.rpc("register_my_account_audit_context_v1", { p_source: "account_settings", p_method: "self_service" });
  } catch {
    /* the password change is recorded as unattributed rather than blocked */
  }
}

export async function fetchUserIdentityTimeline(organizationId: string, userId: string, limit = 500): Promise<UserAuditEvent[]> {
  const { data, error } = await db.rpc("user_identity_timeline_v1", { p_organization_id: organizationId, p_target_user_id: userId, p_limit: limit });
  if (error) throw error;
  return (data ?? []) as UserAuditEvent[];
}

export type AuditEventFilters = {
  organizationId: string;
  targetUserId?: string | null;
  actorUserId?: string | null;
  eventType?: string | null;
  source?: string | null;
  from?: string | null;
  to?: string | null;
  page: number;
  pageSize: number;
};

export type AuditEventRow = {
  id: string;
  created_at: string;
  event_type: string;
  source: string;
  actor_user_id: string | null;
  actor_type: string;
  actor_snapshot: { name?: string; email?: string } | null;
  target_user_id: string;
  target_snapshot: { name?: string; email?: string; role?: string } | null;
  field_name: string | null;
  old_value: unknown;
  new_value: unknown;
  request_id: string | null;
  batch_id: string | null;
  metadata: Record<string, unknown> | null;
};

/** Organization-wide listing for Administration → User Audit. RLS decides what the viewer may see; the filter is convenience only. */
export async function fetchAuditEvents(f: AuditEventFilters): Promise<{ rows: AuditEventRow[]; total: number }> {
  let q = db
    .from("user_account_audit_events")
    .select("id, created_at, event_type, source, actor_user_id, actor_type, actor_snapshot, target_user_id, target_snapshot, field_name, old_value, new_value, request_id, batch_id, metadata", { count: "exact" })
    .eq("organization_id", f.organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(f.page * f.pageSize, f.page * f.pageSize + f.pageSize - 1);
  if (f.targetUserId) q = q.eq("target_user_id", f.targetUserId);
  if (f.actorUserId) q = q.eq("actor_user_id", f.actorUserId);
  if (f.eventType) q = q.eq("event_type", f.eventType);
  if (f.source) q = q.eq("source", f.source);
  if (f.from) q = q.gte("created_at", f.from);
  if (f.to) q = q.lte("created_at", f.to);
  const { data, error, count } = await q;
  if (error) throw error;
  return { rows: (data ?? []) as AuditEventRow[], total: count ?? 0 };
}
