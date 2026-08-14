/**
 * IndexedDB storage for receipt file bytes tied to submitted-expense browser backups.
 * localStorage only holds URLs/metadata; this keeps the actual images/PDFs (7 days).
 */

import type { ExpenseFormDraftPayload } from "@/lib/expenseFormDraft";
import {
  extractReceiptStoragePath,
  loadAttachmentBlobForPreview,
} from "@/lib/attachmentPreview";
import type { ReceiptFinalizationResult } from "@/lib/receiptFinalization";

const DB_NAME = "pesowise-submitted-backup-receipts";
const DB_VERSION = 1;
const STORE = "receipts";
const MAX_RECEIPTS_BYTES = 5 * 1024 * 1024;

type ReceiptRecord = {
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

function backupKey(userId: string, organizationId: string, backupLocalId: string) {
  return `${organizationId}:${userId}:${backupLocalId}`;
}

function receiptId(backupKeyStr: string, index: number) {
  return `${backupKeyStr}:${index}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("by_backupKey", "backupKey", { unique: false });
        store.createIndex("by_expiresAt", "expiresAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function idbPut(record: ReceiptRecord): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB put failed"));
        };
        tx.objectStore(STORE).put(record);
      }),
  );
}

function idbGetAllByBackupKey(key: string): Promise<ReceiptRecord[]> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const store = tx.objectStore(STORE);
        const index = store.index("by_backupKey");
        const req = index.getAll(key);
        req.onsuccess = () => {
          db.close();
          const rows = (req.result ?? []) as ReceiptRecord[];
          resolve(rows.sort((a, b) => a.sortIndex - b.sortIndex));
        };
        req.onerror = () => {
          db.close();
          reject(req.error ?? new Error("IndexedDB read failed"));
        };
      }),
  );
}

function idbDeleteByBackupKey(key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const index = store.index("by_backupKey");
        const req = index.openCursor(key);
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB delete failed"));
        };
      }),
  );
}

function filenameFromUrl(url: string, index: number): string {
  try {
    const path = extractReceiptStoragePath(url) ?? url;
    const base = path.split("/").pop() || `receipt-${index + 1}`;
    return decodeURIComponent(base.split("?")[0] || base);
  } catch {
    return `receipt-${index + 1}.jpg`;
  }
}

function contentTypeFromFilename(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".heic") || lower.endsWith(".heif")) return "image/heic";
  return "image/jpeg";
}

async function collectReceiptSources(payload: ExpenseFormDraftPayload) {
  const sources: Array<{ url: string; filename: string; contentType: string }> = [];
  const seen = new Set<string>();

  // Process full attachment URLs first — they always have the correct storage path.
  // Also mark each URL's bare filename as seen so sessionTempMeta can't re-add the same
  // file with a broken bare-filename path (FileUpload sets storage_path = filename only).
  for (const url of payload.attachments ?? []) {
    const normalized = url?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const bareFilename = normalized.split("/").pop()?.split("?")[0];
    if (bareFilename) seen.add(bareFilename);
    const meta = payload.sessionTempMeta?.find(
      (m) => normalized.includes(m.filename) || normalized.includes(m.path),
    );
    sources.push({
      url: normalized,
      filename: meta?.filename || filenameFromUrl(normalized, sources.length),
      contentType: meta?.content_type || contentTypeFromFilename(normalized),
    });
  }

  // sessionTempMeta: only add files not already covered by a full attachment URL above.
  for (const meta of payload.sessionTempMeta ?? []) {
    const path = meta.path || meta.filename;
    if (!path || seen.has(path)) continue;

    // A valid bucket-relative path always contains at least one "/" (e.g. temp/uid/file.jpg).
    // A bare filename (no "/") cannot be resolved to a storage object — skip it and emit a
    // structured diagnostic so it is traceable without exposing the filename in error UI.
    if (!path.includes("/")) {
      console.warn("[backup] skipping bare filename in sessionTempMeta — no bucket path available", {
        filename: meta.filename,
        hasAttachments: (payload.attachments?.length ?? 0) > 0,
      });
      continue;
    }

    seen.add(path);
    sources.push({
      url: path,
      filename: meta.filename || filenameFromUrl(path, sources.length),
      contentType: meta.content_type || contentTypeFromFilename(meta.filename),
    });
  }

  return sources;
}

/** Download receipt bytes and persist in IndexedDB for this backup. */
export async function saveBackupReceiptsToIndexedDB(params: {
  userId: string;
  organizationId: string;
  backupLocalId: string;
  expiresAt: string;
  payload: ExpenseFormDraftPayload;
  /** When provided, use confirmed finalization results instead of reconstructing sources
   *  from stale payload.attachments — avoids 400s against moved temp paths. */
  finalizationResults?: ReceiptFinalizationResult[];
}): Promise<{ saved: number; totalBytes: number }> {
  const { userId, organizationId, backupLocalId, expiresAt, payload, finalizationResults } = params;
  const key = backupKey(userId, organizationId, backupLocalId);

  await deleteBackupReceiptsFromIndexedDB(userId, organizationId, backupLocalId);

  let totalBytes = 0;
  let saved = 0;

  if (finalizationResults && finalizationResults.length > 0) {
    // Fast path: use confirmed paths and cached blobs from finalization — no network guessing.
    for (let i = 0; i < finalizationResults.length; i++) {
      if (totalBytes >= MAX_RECEIPTS_BYTES) break;
      const result = finalizationResults[i];
      if (result.status === "failed") continue;

      let blob: Blob | null = null;

      // Both "finalized" and "temporary_fallback" use the in-memory blob captured
      // at upload time — zero post-submit network calls. Skip if no blob available.
      if (!result.cachedBlob) {
        console.info("[backup] no cachedBlob for result — skipping zero-network backup", {
          filename: result.filename,
          status: result.status,
        });
        continue;
      }
      blob = result.cachedBlob;

      if (!blob || blob.size === 0) continue;
      if (totalBytes + blob.size > MAX_RECEIPTS_BYTES) break;

      const filename = result.filename || filenameFromUrl(result.resolvedPath ?? result.sourcePath, i);
      const contentType = contentTypeFromFilename(filename);

      await idbPut({
        id: receiptId(key, i),
        backupKey: key,
        backupLocalId,
        userId,
        organizationId,
        filename,
        contentType: blob.type || contentType || "application/octet-stream",
        fileSize: blob.size,
        expiresAt,
        sortIndex: i,
        blob,
      });

      totalBytes += blob.size;
      saved += 1;
    }
  } else {
    // Fallback path: no finalization results (e.g. edit mode, draft save).
    // Reconstruct sources from payload — may hit stale temp URLs for unfinalized files.
    const sources = await collectReceiptSources(payload);

    for (let i = 0; i < sources.length; i++) {
      if (totalBytes >= MAX_RECEIPTS_BYTES) break;
      const source = sources[i];
      const blob = await loadAttachmentBlobForPreview(source.url, source.contentType);
      if (!blob || blob.size === 0) continue;
      if (totalBytes + blob.size > MAX_RECEIPTS_BYTES) break;

      await idbPut({
        id: receiptId(key, i),
        backupKey: key,
        backupLocalId,
        userId,
        organizationId,
        filename: source.filename,
        contentType: source.contentType || blob.type || "application/octet-stream",
        fileSize: blob.size,
        expiresAt,
        sortIndex: i,
        blob,
      });

      totalBytes += blob.size;
      saved += 1;
    }
  }

  return { saved, totalBytes };
}

export async function countBackupReceiptsInIndexedDB(
  userId: string,
  organizationId: string,
  backupLocalId: string,
): Promise<number> {
  try {
    const rows = await idbGetAllByBackupKey(backupKey(userId, organizationId, backupLocalId));
    const now = Date.now();
    return rows.filter((r) => new Date(r.expiresAt).getTime() > now).length;
  } catch {
    return 0;
  }
}

export async function deleteBackupReceiptsFromIndexedDB(
  userId: string,
  organizationId: string,
  backupLocalId: string,
): Promise<void> {
  try {
    await idbDeleteByBackupKey(backupKey(userId, organizationId, backupLocalId));
  } catch {
    // ignore
  }
}

export type RestoredBackupReceiptUpload = {
  file_url: string;
  storage_path: string;
  filename: string;
  content_type: string;
  file_size: number;
};

/** Re-upload stored receipt blobs to temp storage when user taps Submit again. */
export async function reuploadBackupReceiptsFromIndexedDB(
  supabase: import("@supabase/supabase-js").SupabaseClient,
  userId: string,
  organizationId: string,
  backupLocalId: string,
): Promise<RestoredBackupReceiptUpload[]> {
  const rows = await idbGetAllByBackupKey(backupKey(userId, organizationId, backupLocalId));
  const now = Date.now();
  const active = rows.filter((r) => new Date(r.expiresAt).getTime() > now);
  const uploaded: RestoredBackupReceiptUpload[] = [];

  for (const row of active) {
    const ext = row.filename.includes(".")
      ? row.filename.split(".").pop()
      : row.contentType.includes("pdf")
        ? "pdf"
        : "jpg";
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const storagePath = `temp/${userId}/${fileName}`;

    const { error } = await supabase.storage.from("receipts").upload(storagePath, row.blob, {
      cacheControl: "3600",
      upsert: false,
      contentType: row.contentType,
    });

    if (error) {
      console.warn("Failed to re-upload backup receipt:", error.message);
      continue;
    }

    const { data: urlData } = supabase.storage.from("receipts").getPublicUrl(storagePath);
    uploaded.push({
      file_url: urlData.publicUrl,
      storage_path: fileName,
      filename: row.filename,
      content_type: row.contentType,
      file_size: row.fileSize,
    });
  }

  return uploaded;
}
