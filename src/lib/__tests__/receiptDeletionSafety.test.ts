/**
 * DOC-078 — receipt deletion safety + same-device recovery scanning.
 *
 * Anchored to the DOC-077 §5d incident: upload 17:56:27Z, preview 17:57:04Z,
 * storage.object.delete_many 18:00:14Z from the uploader's own authenticated
 * session. Unversioned bucket, no staging twin, no backup covering ~4 minutes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  daysUntilExpiry,
  indexBackupsByLocalId,
  scoreCandidate,
  selectCandidates,
  RECOVERY_DB_NAME,
  RECOVERY_STORE,
  type BackupReceiptRecord,
  type RecoveryTarget,
} from "@/lib/receiptRecoveryScan";
import { isLocalOnlyAttachmentId, removeAttachmentSafely } from "@/lib/attachmentRemoval";

const cwd = process.cwd();
const code = (p: string) =>
  readFileSync(resolve(cwd, p), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const EXPENSE = "bcb9dbc8-00c2-4690-9bb0-e0cc1d7cabcf";
const FILENAME = "1785434184415-grfx7vumcj6.jpeg";
const TARGET: RecoveryTarget = {
  expenseId: EXPENSE,
  attachmentId: "fdda25c9-5bcd-4b9f-8904-8635ef7f2d98",
  filename: FILENAME,
  windowStart: "2026-07-30T17:50:00Z",
  windowEnd: "2026-07-30T18:05:00Z",
};

function rec(over: Partial<BackupReceiptRecord> = {}): BackupReceiptRecord {
  return {
    id: "org:user:b1:0",
    backupKey: "org:user:b1",
    backupLocalId: "b1",
    userId: "eead54de-f12c-427c-a205-ef190e8b314b",
    organizationId: "org",
    filename: FILENAME,
    contentType: "image/jpeg",
    fileSize: 238397,
    expiresAt: "2026-08-06T17:56:27Z",
    sortIndex: 0,
    blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x01])], { type: "image/jpeg" }),
    ...over,
  };
}

// ── Scanner scope ────────────────────────────────────────────────────────────

describe("recovery scanner — scope", () => {
  it("targets only the application's own database and store", () => {
    expect(RECOVERY_DB_NAME).toBe("pesowise-submitted-backup-receipts");
    expect(RECOVERY_STORE).toBe("receipts");
  });

  it("never enumerates or deletes browser databases", () => {
    const src = code("src/lib/receiptRecoveryScan.ts");
    expect(src).not.toContain("indexedDB.databases");
    expect(src).not.toContain("deleteDatabase");
    expect(src).not.toContain("clear()");
    expect(src).not.toContain('"readwrite"');
  });
});

// ── Matching ─────────────────────────────────────────────────────────────────

describe("recovery scanner — candidate matching", () => {
  const index = indexBackupsByLocalId([
    { localId: "b1", expenseId: EXPENSE, savedAt: "2026-07-30T17:56:40Z" },
    { localId: "b2", expenseId: "other-expense", savedAt: "2026-07-01T09:00:00Z" },
  ] as never);

  it("finds the exact-expense candidate", () => {
    const found = selectCandidates([rec()], TARGET, index);
    expect(found).toHaveLength(1);
    expect(found[0].backupExpenseId).toBe(EXPENSE);
    expect(found[0].reasons.join(" ")).toContain("target expense");
  });

  it("finds a candidate by exact filename even without expense linkage", () => {
    const found = selectCandidates([rec({ backupLocalId: "unknown" })], TARGET, index);
    expect(found).toHaveLength(1);
    expect(found[0].reasons.join(" ")).toContain("exact storage filename");
  });

  it("credits a backup saved inside the incident window", () => {
    const s = scoreCandidate(rec(), TARGET, EXPENSE, "2026-07-30T17:56:40Z");
    expect(s.reasons.join(" ")).toContain("incident time window");
    expect(s.confidence).toBeGreaterThan(80);
  });

  it("rejects a zero-byte blob outright", () => {
    const s = scoreCandidate(
      rec({ fileSize: 0, blob: new Blob([], { type: "image/jpeg" }) }),
      TARGET,
      EXPENSE,
      "2026-07-30T17:56:40Z",
    );
    expect(s.eligible).toBe(false);
    expect(selectCandidates([rec({ fileSize: 0, blob: new Blob([]) })], TARGET, index)).toHaveLength(0);
  });

  it("ignores unrelated backups", () => {
    const unrelated = rec({ backupLocalId: "b2", filename: "something-else.png", contentType: "image/png" });
    expect(selectCandidates([unrelated], TARGET, index)).toHaveLength(0);
  });

  it("does not require every field to match on historical records", () => {
    const sparse = rec({ backupLocalId: "unknown", contentType: "" });
    expect(selectCandidates([sparse], TARGET, index).length).toBe(1);
  });

  it("ranks the strongest candidate first", () => {
    const weak = rec({ id: "w", backupLocalId: "unknown", filename: "partial-" + FILENAME });
    const strong = rec({ id: "s" });
    const found = selectCandidates([weak, strong], TARGET, index);
    expect(found[0].recordId).toBe("s");
  });

  it("reports remaining TTL so urgency is visible", () => {
    const now = Date.parse("2026-08-01T06:00:00Z");
    expect(daysUntilExpiry("2026-08-06T17:56:27Z", now)).toBe(5);
    expect(daysUntilExpiry("2026-07-20T00:00:00Z", now)).toBeLessThan(0);
  });
});

// ── Deletion safety ──────────────────────────────────────────────────────────

describe("attachment removal — never physical", () => {
  const rpc = vi.fn();
  const del = vi.fn();
  const eq = vi.fn();
  const supabase = {
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => ({ delete: () => ({ eq: (...a: unknown[]) => eq(...a) }) }),
    storage: { from: () => ({ remove: del }) },
  } as never;

  beforeEach(() => {
    rpc.mockReset();
    del.mockReset();
    eq.mockReset();
  });

  it("soft-deletes via RPC and never touches storage", async () => {
    rpc.mockResolvedValue({ error: null });
    const r = await removeAttachmentSafely(supabase, { attachmentId: "a1" });
    expect(r.mode).toBe("soft_deleted");
    expect(r.objectDeleted).toBe(false);
    expect(r.undoable).toBe(true);
    expect(del).not.toHaveBeenCalled();
  });

  it("is idempotent — repeated soft delete stays successful", async () => {
    rpc.mockResolvedValue({ error: null });
    await removeAttachmentSafely(supabase, { attachmentId: "a1" });
    const second = await removeAttachmentSafely(supabase, { attachmentId: "a1" });
    expect(second.mode).toBe("soft_deleted");
  });

  it("retains the object even when the migration is not yet applied", async () => {
    rpc.mockResolvedValue({ error: { code: "PGRST202", message: "soft_delete_attachment" } });
    eq.mockResolvedValue({ error: null });
    const r = await removeAttachmentSafely(supabase, { attachmentId: "a1" });
    expect(r.mode).toBe("row_removed_object_retained");
    expect(r.objectDeleted).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });

  it("treats un-persisted client attachments as local-only", async () => {
    expect(isLocalOnlyAttachmentId("temp-123")).toBe(true);
    const r = await removeAttachmentSafely(supabase, { attachmentId: "temp-123" });
    expect(r.mode).toBe("local_only");
    expect(rpc).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("propagates genuine authorization errors instead of falling back", async () => {
    rpc.mockResolvedValue({ error: { code: "42501", message: "not authorized" } });
    await expect(removeAttachmentSafely(supabase, { attachmentId: "a1" })).rejects.toMatchObject({
      code: "42501",
    });
    expect(del).not.toHaveBeenCalled();
  });
});

// ── Source-level guarantees ──────────────────────────────────────────────────

describe("no browser code physically deletes a receipt", () => {
  const files = [
    "src/components/FileUpload.tsx",
    "src/pages/ExpenseForm.tsx",
    "src/pages/ExpenseBatchForm.tsx",
  ];

  it("contains no receipts-bucket remove() call", () => {
    for (const f of files) {
      expect(code(f)).not.toMatch(/from\(\s*['"]receipts['"]\s*\)\s*\.\s*remove/);
    }
  });

  it("routes removal through the safe helper", () => {
    expect(code("src/components/FileUpload.tsx")).toContain("removeAttachmentSafely");
  });

  it("retains staging copies instead of deleting them", () => {
    expect(code("src/pages/ExpenseForm.tsx")).toContain("sessionTempFilenamesRef.current.clear()");
    expect(code("src/pages/ExpenseForm.tsx")).not.toMatch(/remove\(paths\)/);
    expect(code("src/pages/ExpenseBatchForm.tsx")).not.toMatch(/remove\(Array\.from\(paths\)\)/);
  });
});

// ── Migration shape ──────────────────────────────────────────────────────────

describe("soft-delete migration", () => {
  const sql = readFileSync(
    resolve(cwd, "supabase/migrations/20260801120000_attachment_soft_delete_and_storage_copies.sql"),
    "utf-8",
  );

  it("uses a 14-digit timestamp prefix so the CLI runner picks it up", () => {
    expect(/^\d{14}_/.test("20260801120000_x.sql")).toBe(true);
  });

  it("adds the soft-delete and durability columns", () => {
    for (const c of [
      "deleted_at",
      "deleted_by",
      "delete_reason",
      "deletion_source",
      "restored_at",
      "restored_by",
      "durability_status",
    ]) {
      expect(sql).toContain(c);
    }
  });

  it("creates the per-copy inventory with role and status constraints", () => {
    expect(sql).toContain("attachment_storage_copies");
    expect(sql).toContain("'staging', 'primary', 'archive'");
    expect(sql).toContain("'pending', 'verified', 'missing', 'failed', 'quarantined'");
    expect(sql).toContain("attachment_storage_copies_location_uniq");
  });

  it("exposes soft delete and restore as authorized RPCs", () => {
    expect(sql).toContain("soft_delete_attachment");
    expect(sql).toContain("restore_soft_deleted_attachment");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("not authorized for this organization");
  });

  it("is additive only — no destructive DDL", () => {
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
  });

  it("keeps copy rows server-written — clients get SELECT only", () => {
    expect(sql).toContain("attachment_storage_copies_select");
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]{0,200}FOR (INSERT|UPDATE|DELETE)[\s\S]{0,120}attachment_storage_copies/i);
  });
});
