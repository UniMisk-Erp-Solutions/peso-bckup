/**
 * DOC-158: trusted-actor plumbing for the immutable user-account audit history.
 *
 * WHY THIS EXISTS. The admin edge functions mutate users with the SERVICE ROLE (Supabase Auth Admin API, privileged writes).
 * Without help, the database only sees "service_role" and the human administrator who asked for the change is lost.
 * Before every privileged mutation a function calls `registerAuditContext` with the actor it DERIVED FROM THE VERIFIED JWT; the
 * database re-checks that this actor really is an active administrator of the organization and only then lets the audit
 * triggers attribute the service-role writes to that human (metadata.execution_context stays "service_role").
 *
 * RULES (enforced by tests/static contract checks):
 *  - The actor id must come from `serviceClient.auth.getUser(jwt)` / `callerClient.auth.getUser()`. NEVER from the request body.
 *  - Registration FAILS CLOSED: if the context cannot be registered the mutation is refused (no unattributed privileged change).
 *  - Nothing sensitive is ever passed here: no password, token, OTP, hash or auth payload. Reasons are short category codes.
 *  - `recordAuditEvent` is best-effort and must never mask the original error of the operation it describes.
 *
 * Deployment order: apply migration 20261031100000_user_account_audit_history_v1.sql BEFORE deploying functions that import this.
 */

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

// deno-lint-ignore no-explicit-any
type Rpc = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ error: { code?: string; message?: string } | null }> } & Record<string, any>;

/** One id per admin action; reused for every row/event the action causes. A caller-supplied id is accepted only if it is a safe token. */
export function newRequestId(req?: Request): string {
  const header = req?.headers.get("x-request-id") ?? null;
  return header && SAFE_ID.test(header) ? header : crypto.randomUUID();
}

/** A batch id groups the per-chunk requests of one bulk import. It carries no identity, so accepting it from the client is safe. */
export function safeBatchId(value: unknown): string | null {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

export type AuditSource =
  | "user_management" | "master_admin" | "bulk_upload" | "admin_edge_function" | "auth_admin"
  | "auth_recovery" | "password_reset" | "account_settings" | "self_service" | "system";

export type AuditContextInput = {
  /** MUST be the authenticated caller's id from the verified JWT. */
  actorUserId: string;
  organizationId: string;
  requestId: string;
  source: AuditSource;
  targetUserIds?: string[];
  /** Account creation: the auth user id does not exist yet, so the context is keyed by e-mail. */
  targetEmail?: string;
  batchId?: string | null;
  /** "organization" covers every user of that organization (bulk import); it must be cleared when the work ends. */
  scope?: "target" | "organization";
  ttlSeconds?: number;
  /** Short non-sensitive tag, e.g. "admin_reset". */
  method?: string;
};

export async function registerAuditContext(client: Rpc, input: AuditContextInput): Promise<void> {
  const { error } = await client.rpc("register_user_account_audit_context_v1", {
    p_actor_user_id: input.actorUserId,
    p_organization_id: input.organizationId,
    p_request_id: input.requestId,
    p_source: input.source,
    p_target_user_ids: input.targetUserIds ?? null,
    p_target_email: input.targetEmail ?? null,
    p_batch_id: input.batchId ?? null,
    p_scope: input.scope ?? "target",
    p_ttl_seconds: input.ttlSeconds ?? 120,
    p_method: input.method ?? null,
  });
  if (error) {
    // Fail closed. Do not echo database internals to the browser.
    console.error("audit context registration failed", error.code ?? "rpc_error");
    throw new Error("Audit trail unavailable: the change was not made. Please try again or contact support.");
  }
}

export async function clearAuditContext(client: Rpc, requestId: string): Promise<void> {
  try {
    await client.rpc("clear_user_account_audit_context_v1", { p_request_id: requestId });
  } catch {
    /* the context expires on its own */
  }
}

export type AuditEventInput = {
  organizationId: string;
  targetUserId: string;
  /** The authenticated caller, from the verified JWT. */
  actorUserId: string | null;
  eventType:
    | "password_reset_requested" | "password_reset_completed" | "admin_password_reset" | "password_changed"
    | "user_creation_failed" | "email_change_failed" | "deactivation_failed" | "reactivation_failed" | "password_reset_failed"
    | "account_change_denied" | "auth_ban_failed" | "auth_unban_failed" | "auth_sync_recovered" | "account_identity_changed";
  source: AuditSource;
  requestId: string;
  /** Category codes only (e.g. { reason: "email_already_registered" }). Never payloads, never secrets. */
  metadata?: Record<string, string | number | boolean | null>;
  batchId?: string | null;
};

/** Best-effort: an audit write failure on a failure/denial event must never replace the real error the caller is about to return. */
export async function recordAuditEvent(client: Rpc, e: AuditEventInput): Promise<void> {
  try {
    const { error } = await client.rpc("record_user_account_audit_event_v1", {
      p_organization_id: e.organizationId,
      p_target_user_id: e.targetUserId,
      p_actor_user_id: e.actorUserId,
      p_event_type: e.eventType,
      p_source: e.source,
      p_request_id: e.requestId,
      p_metadata: e.metadata ?? null,
      p_batch_id: e.batchId ?? null,
    });
    if (error) console.error("audit event not recorded", e.eventType, error.code ?? "rpc_error");
  } catch {
    console.error("audit event not recorded", e.eventType);
  }
}

/** Maps an upstream error message to a SAFE category. The message itself is never stored. */
export function failureReason(message: string | null | undefined): string {
  const m = String(message ?? "").toLowerCase();
  if (m.includes("already") && (m.includes("registered") || m.includes("exists"))) return "email_already_registered";
  if (m.includes("invalid") && m.includes("email")) return "invalid_email";
  if (m.includes("password") && (m.includes("weak") || m.includes("short") || m.includes("least"))) return "password_policy";
  if (m.includes("not found")) return "not_found";
  if (m.includes("permission") || m.includes("not allowed") || m.includes("only")) return "not_permitted";
  if (m.includes("timeout") || m.includes("timed out")) return "timeout";
  return "upstream_error";
}
