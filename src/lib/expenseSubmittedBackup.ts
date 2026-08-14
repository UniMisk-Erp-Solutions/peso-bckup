/**
 * Browser-local copies of submitted (or draft-saved) expenses.
 * Kept for 7 days so users can resubmit if a server row disappears.
 */

import type { ExpenseFormDraftPayload } from "@/lib/expenseFormDraft";
import { deleteBackupReceiptsFromIndexedDB } from "@/lib/expenseSubmittedBackupReceipts";

const BACKUP_VERSION = 1;
const BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BACKUPS_PER_USER = 40;

export type SubmittedExpenseBackupStatus = "submitted" | "draft";

export type SubmittedExpenseBackup = {
  v: number;
  localId: string;
  savedAt: string;
  expiresAt: string;
  expenseId?: string | null;
  submissionStatus: SubmittedExpenseBackupStatus;
  payload: ExpenseFormDraftPayload;
};

function indexKey(userId: string, organizationId: string) {
  return `pesowise:expense-submitted-backups:${organizationId}:${userId}`;
}

function entryKey(userId: string, organizationId: string, localId: string) {
  return `${indexKey(userId, organizationId)}:item:${localId}`;
}

function readIndex(userId: string, organizationId: string): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(indexKey(userId, organizationId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeIndex(userId: string, organizationId: string, ids: string[]) {
  if (typeof localStorage === "undefined") return;
  try {
    if (ids.length === 0) {
      localStorage.removeItem(indexKey(userId, organizationId));
    } else {
      localStorage.setItem(indexKey(userId, organizationId), JSON.stringify(ids));
    }
  } catch {
    // ignore quota errors
  }
}

function parseEntry(raw: string | null): SubmittedExpenseBackup | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SubmittedExpenseBackup;
    if (parsed.v !== BACKUP_VERSION) return null;
    if (!parsed.localId || !parsed.savedAt || !parsed.payload) return null;
    const expiresAt = parsed.expiresAt || parsed.savedAt;
    if (Date.now() > new Date(expiresAt).getTime()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function removeEntry(userId: string, organizationId: string, localId: string) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(entryKey(userId, organizationId, localId));
  } catch {
    // ignore
  }
}

/** Drop expired backups and trim oldest when over cap. */
export function pruneSubmittedExpenseBackups(userId: string, organizationId: string): void {
  const ids = readIndex(userId, organizationId);
  const kept: { id: string; savedAt: number }[] = [];

  for (const id of ids) {
    const entry = parseEntry(localStorage.getItem(entryKey(userId, organizationId, id)));
    if (!entry) {
      removeEntry(userId, organizationId, id);
      continue;
    }
    kept.push({ id, savedAt: new Date(entry.savedAt).getTime() });
  }

  kept.sort((a, b) => b.savedAt - a.savedAt);
  const trimmed = kept.slice(0, MAX_BACKUPS_PER_USER);
  for (const dropped of kept.slice(MAX_BACKUPS_PER_USER)) {
    removeEntry(userId, organizationId, dropped.id);
  }
  writeIndex(
    userId,
    organizationId,
    trimmed.map((x) => x.id),
  );
}

export function saveSubmittedExpenseBackup(
  userId: string | undefined,
  organizationId: string | null | undefined,
  options: {
    expenseId?: string | null;
    submissionStatus: SubmittedExpenseBackupStatus;
    payload: ExpenseFormDraftPayload;
  },
): { ok: boolean; localId?: string; expiresAt?: string } {
  if (!userId || !organizationId) return { ok: false };
  if (typeof localStorage === "undefined") return { ok: false };

  pruneSubmittedExpenseBackups(userId, organizationId);

  const now = new Date();
  const localId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `backup-${now.getTime()}-${Math.random().toString(36).slice(2, 9)}`;

  const entry: SubmittedExpenseBackup = {
    v: BACKUP_VERSION,
    localId,
    savedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + BACKUP_TTL_MS).toISOString(),
    expenseId: options.expenseId ?? null,
    submissionStatus: options.submissionStatus,
    payload: options.payload,
  };

  try {
    localStorage.setItem(entryKey(userId, organizationId, localId), JSON.stringify(entry));
    const ids = readIndex(userId, organizationId).filter((id) => id !== localId);
    ids.unshift(localId);
    writeIndex(userId, organizationId, ids.slice(0, MAX_BACKUPS_PER_USER));
    return { ok: true, localId, expiresAt: entry.expiresAt };
  } catch {
    return { ok: false };
  }
}

export function listSubmittedExpenseBackups(
  userId: string | undefined,
  organizationId: string | null | undefined,
): SubmittedExpenseBackup[] {
  if (!userId || !organizationId) return [];
  if (typeof localStorage === "undefined") return [];

  pruneSubmittedExpenseBackups(userId, organizationId);

  const ids = readIndex(userId, organizationId);
  const entries: SubmittedExpenseBackup[] = [];

  for (const id of ids) {
    const entry = parseEntry(localStorage.getItem(entryKey(userId, organizationId, id)));
    if (entry) entries.push(entry);
  }

  return entries.sort(
    (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
  );
}

export function getSubmittedExpenseBackup(
  userId: string | undefined,
  organizationId: string | null | undefined,
  localId: string,
): SubmittedExpenseBackup | null {
  if (!userId || !organizationId) return null;
  return parseEntry(localStorage.getItem(entryKey(userId, organizationId, localId)));
}

export function removeSubmittedExpenseBackup(
  userId: string | undefined,
  organizationId: string | null | undefined,
  localId: string,
): void {
  if (!userId || !organizationId) return;
  removeEntry(userId, organizationId, localId);
  writeIndex(
    userId,
    organizationId,
    readIndex(userId, organizationId).filter((id) => id !== localId),
  );
  void deleteBackupReceiptsFromIndexedDB(userId, organizationId, localId);
}

export function submittedBackupToDraftPayload(
  backup: SubmittedExpenseBackup,
): ExpenseFormDraftPayload {
  return backup.payload;
}

export function getSubmittedBackupDaysRemaining(backup: SubmittedExpenseBackup): number {
  const ms = new Date(backup.expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}
