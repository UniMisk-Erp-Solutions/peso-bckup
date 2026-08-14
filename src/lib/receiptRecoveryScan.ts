/**
 * Same-device receipt recovery scanner (DOC-078).
 *
 * Reads ONLY the application's own submitted-expense backup store:
 *   IndexedDB database : pesowise-submitted-backup-receipts   (version 1)
 *   object store       : receipts   (keyPath "id", indexes by_backupKey / by_expiresAt)
 *   localStorage index : pesowise:expense-submitted-backups:{orgId}:{userId}
 *
 * It never enumerates, opens, mutates or deletes any other browser database, and it
 * never deletes or expires a record — recovery must not destroy the evidence it is
 * searching. Everything here is read-only against the browser.
 *
 * Why this can work at all: ExpenseForm.persistSubmittedSafetyCopy() runs on the EDIT
 * path too (ExpenseForm.tsx, the `if (id)` branch), so saving an edit downloads the
 * then-live receipt bytes into IndexedDB. A receipt deleted from storage minutes later
 * can therefore still have a browser-side copy — until the 7-day TTL expires it.
 */

import type { SubmittedExpenseBackup } from "@/lib/expenseSubmittedBackup";

export const RECOVERY_DB_NAME = "pesowise-submitted-backup-receipts";
export const RECOVERY_DB_VERSION = 1;
export const RECOVERY_STORE = "receipts";

/** Mirrors the record written by saveBackupReceiptsToIndexedDB. */
export type BackupReceiptRecord = {
  id: string;
  backupKey: string;
  backupLocalId: string;
  userId: string;
  organizationId: string;
  filename: string;
  contentType: string;
  fileSize: number;
  expiresAt: string;
  sortIndex: number;
  blob: Blob;
};

export type RecoveryTarget = {
  expenseId: string;
  attachmentId?: string;
  /** Storage object filename, e.g. 1785434184415-grfx7vumcj6.jpeg */
  filename?: string;
  /** Inclusive ISO window around the incident. */
  windowStart?: string;
  windowEnd?: string;
};

export type RecoveryCandidate = {
  recordId: string;
  backupLocalId: string;
  /** Expense the backup was saved against, resolved via the localStorage index. */
  backupExpenseId: string | null;
  savedAt: string | null;
  expiresAt: string;
  filename: string;
  contentType: string;
  fileSize: number;
  /** 0–100. Higher means more signals agreed. */
  confidence: number;
  reasons: string[];
  blob: Blob;
};

export type RecoveryStatus =
  | "not_checked"
  | "no_local_backup"
  | "candidate_found"
  | "restored"
  | "verification_failed";

/** Opens the app's own backup DB read-only. Never creates it if absent. */
export function openRecoveryDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const req = indexedDB.open(RECOVERY_DB_NAME, RECOVERY_DB_VERSION);
    // If the store does not exist we must not create it — abort instead.
    req.onupgradeneeded = () => {
      try {
        req.transaction?.abort();
      } catch {
        /* ignore */
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECOVERY_STORE)) {
        db.close();
        resolve(null);
        return;
      }
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/** Reads every record in the app's backup store. Read-only transaction. */
export function readAllBackupReceipts(db: IDBDatabase): Promise<BackupReceiptRecord[]> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(RECOVERY_STORE, "readonly");
      const req = tx.objectStore(RECOVERY_STORE).getAll();
      req.onsuccess = () => resolve((req.result ?? []) as BackupReceiptRecord[]);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/**
 * Scores one record against the target.
 *
 * Deliberately tolerant: historical backup records predate this feature and may lack
 * fields, so no single signal is mandatory. A record is only a candidate when it has
 * real bytes AND at least one positive identifying signal.
 */
export function scoreCandidate(
  record: BackupReceiptRecord,
  target: RecoveryTarget,
  backupExpenseId: string | null,
  savedAt: string | null,
): { confidence: number; reasons: string[]; eligible: boolean } {
  const reasons: string[] = [];
  let confidence = 0;

  // Hard gate: a zero-byte blob is never a recovery candidate.
  if (!record.blob || record.fileSize <= 0 || record.blob.size <= 0) {
    return { confidence: 0, reasons: ["empty blob"], eligible: false };
  }

  if (backupExpenseId && backupExpenseId === target.expenseId) {
    confidence += 45;
    reasons.push("backup belongs to the target expense");
  }

  if (target.filename && record.filename) {
    if (record.filename === target.filename) {
      confidence += 35;
      reasons.push("exact storage filename match");
    } else if (
      target.filename.includes(record.filename) ||
      record.filename.includes(target.filename)
    ) {
      confidence += 15;
      reasons.push("partial filename match");
    }
  }

  if (savedAt && target.windowStart && target.windowEnd) {
    const t = Date.parse(savedAt);
    const a = Date.parse(target.windowStart);
    const b = Date.parse(target.windowEnd);
    if (Number.isFinite(t) && Number.isFinite(a) && Number.isFinite(b) && t >= a && t <= b) {
      confidence += 25;
      reasons.push("saved inside the incident time window");
    }
  }

  const type = (record.contentType || record.blob.type || "").toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) {
    confidence += 10;
    reasons.push("JPEG content type");
  }

  reasons.push(`${record.fileSize} bytes present`);

  return {
    confidence: Math.min(100, confidence),
    reasons,
    // At least one identifying signal beyond "it has bytes".
    eligible: confidence > 10,
  };
}

/** Builds backupLocalId → {expenseId, savedAt} from the localStorage backup index. */
export function indexBackupsByLocalId(
  backups: SubmittedExpenseBackup[],
): Map<string, { expenseId: string | null; savedAt: string | null }> {
  const map = new Map<string, { expenseId: string | null; savedAt: string | null }>();
  for (const b of backups) {
    if (!b?.localId) continue;
    map.set(b.localId, { expenseId: b.expenseId ?? null, savedAt: b.savedAt ?? null });
  }
  return map;
}

/** Pure matcher — exported so the rules are testable without a browser. */
export function selectCandidates(
  records: BackupReceiptRecord[],
  target: RecoveryTarget,
  backupIndex: Map<string, { expenseId: string | null; savedAt: string | null }>,
): RecoveryCandidate[] {
  const out: RecoveryCandidate[] = [];
  for (const record of records) {
    const meta = backupIndex.get(record.backupLocalId) ?? { expenseId: null, savedAt: null };
    const { confidence, reasons, eligible } = scoreCandidate(
      record,
      target,
      meta.expenseId,
      meta.savedAt,
    );
    if (!eligible) continue;
    out.push({
      recordId: record.id,
      backupLocalId: record.backupLocalId,
      backupExpenseId: meta.expenseId,
      savedAt: meta.savedAt,
      expiresAt: record.expiresAt,
      filename: record.filename,
      contentType: record.contentType,
      fileSize: record.fileSize,
      confidence,
      reasons,
      blob: record.blob,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/** SHA-256 of a Blob, hex-encoded. Computed locally; nothing leaves the device. */
export async function sha256Hex(blob: Blob): Promise<string | null> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/** True when the bytes begin with the JPEG SOI marker (FF D8 FF). */
export async function looksLikeJpeg(blob: Blob): Promise<boolean> {
  try {
    const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
    return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  } catch {
    return false;
  }
}

/** Days until this record's TTL expires (negative once expired). */
export function daysUntilExpiry(expiresAt: string, now = Date.now()): number {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return 0;
  return Math.floor((t - now) / (24 * 60 * 60 * 1000));
}
