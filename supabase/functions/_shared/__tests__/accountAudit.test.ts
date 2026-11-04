/**
 * DOC-158: the edge-function side of the audit trail. Runs in Vitest (the helper has no Deno-only imports).
 */
import { describe, expect, it, vi } from "vitest";
import {
  clearAuditContext, failureReason, newRequestId, recordAuditEvent, registerAuditContext, safeBatchId,
} from "../accountAudit";

const rpcOk = () => vi.fn().mockResolvedValue({ error: null });

describe("request / batch ids", () => {
  it("generates a fresh id when none is supplied", () => {
    expect(newRequestId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(newRequestId()).not.toBe(newRequestId());
  });
  it("accepts a safe caller-supplied x-request-id and rejects anything else", () => {
    const ok = new Request("https://x.test", { headers: { "x-request-id": "req-abc_123" } });
    expect(newRequestId(ok)).toBe("req-abc_123");
    const bad = new Request("https://x.test", { headers: { "x-request-id": "bad id with spaces; drop table" } });
    expect(newRequestId(bad)).not.toContain(" ");
    expect(newRequestId(bad)).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("batch ids are validated tokens, never free text", () => {
    expect(safeBatchId("bulk-1234")).toBe("bulk-1234");
    expect(safeBatchId("x".repeat(65))).toBeNull();
    expect(safeBatchId("a b")).toBeNull();
    expect(safeBatchId(undefined)).toBeNull();
    expect(safeBatchId({ a: 1 })).toBeNull();
  });
});

describe("registerAuditContext", () => {
  it("passes the actor it is given, plus the request, source and targets, to the trusted RPC", async () => {
    const rpc = rpcOk();
    await registerAuditContext({ rpc } as never, { actorUserId: "admin-1", organizationId: "org-1", requestId: "r-1", source: "user_management", targetUserIds: ["t-1"] });
    expect(rpc).toHaveBeenCalledWith("register_user_account_audit_context_v1", expect.objectContaining({
      p_actor_user_id: "admin-1", p_organization_id: "org-1", p_request_id: "r-1", p_source: "user_management", p_target_user_ids: ["t-1"], p_scope: "target",
    }));
  });
  it("FAILS CLOSED: when the context cannot be registered the privileged change must not run", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { code: "42501", message: "actor is not an administrator of this organization" } });
    await expect(registerAuditContext({ rpc } as never, { actorUserId: "x", organizationId: "o", requestId: "r", source: "user_management" })).rejects.toThrow(/Audit trail unavailable/);
  });
  it("never leaks database internals to the browser", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { code: "XX000", message: "relation \"user_account_audit_context\" secret detail" } });
    await expect(registerAuditContext({ rpc } as never, { actorUserId: "x", organizationId: "o", requestId: "r", source: "user_management" })).rejects.not.toThrow(/relation|secret detail/);
  });
  it("supports organization scope for bulk imports", async () => {
    const rpc = rpcOk();
    await registerAuditContext({ rpc } as never, { actorUserId: "a", organizationId: "o", requestId: "r", source: "bulk_upload", batchId: "batch-9", scope: "organization", ttlSeconds: 900 });
    expect(rpc).toHaveBeenCalledWith("register_user_account_audit_context_v1", expect.objectContaining({ p_scope: "organization", p_batch_id: "batch-9", p_ttl_seconds: 900 }));
  });
});

describe("recordAuditEvent", () => {
  it("is best effort: an RPC error or exception never propagates and masks the real failure", async () => {
    const failing = vi.fn().mockResolvedValue({ error: { code: "XX000" } });
    await expect(recordAuditEvent({ rpc: failing } as never, { organizationId: "o", targetUserId: "t", actorUserId: "a", eventType: "email_change_failed", source: "user_management", requestId: "r" })).resolves.toBeUndefined();
    const throwing = vi.fn().mockRejectedValue(new Error("network"));
    await expect(recordAuditEvent({ rpc: throwing } as never, { organizationId: "o", targetUserId: "t", actorUserId: "a", eventType: "email_change_failed", source: "user_management", requestId: "r" })).resolves.toBeUndefined();
  });
  it("sends only the fields the RPC defines (no free-form payload, no password field)", async () => {
    const rpc = rpcOk();
    await recordAuditEvent({ rpc } as never, { organizationId: "o", targetUserId: "t", actorUserId: "a", eventType: "admin_password_reset", source: "password_reset", requestId: "r", metadata: { method: "admin_reset" } });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(
      ["p_actor_user_id", "p_batch_id", "p_event_type", "p_metadata", "p_organization_id", "p_request_id", "p_source", "p_target_user_id"].sort(),
    );
    expect(JSON.stringify(args)).not.toMatch(/new_password|"password"|token|secret/i);
  });
  it("clearAuditContext swallows errors (the context also expires by itself)", async () => {
    await expect(clearAuditContext({ rpc: vi.fn().mockRejectedValue(new Error("x")) } as never, "r")).resolves.toBeUndefined();
  });
});

describe("failureReason maps upstream messages to SAFE categories (the message itself is never stored)", () => {
  it.each([
    ["A user with this email address has already been registered", "email_already_registered"],
    ["Invalid email address", "invalid_email"],
    ["Password should be at least 6 characters", "password_policy"],
    ["User not found", "not_found"],
    ["Only administrators can do this", "not_permitted"],
    ["request timed out", "timeout"],
    ["something weird with secret=abc123", "upstream_error"],
    [null, "upstream_error"],
  ])("%s -> %s", (msg, expected) => {
    expect(failureReason(msg as string | null)).toBe(expected);
  });
  it("the category never contains the original text", () => {
    expect(failureReason("token=eyJhbGciOi.abc.def failed")).not.toContain("eyJ");
  });
});
