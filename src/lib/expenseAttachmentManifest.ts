/**
 * Canonical attachment set for expense submission.
 *
 * The attachments the employee SEES in the form are the only attachments that
 * may be finalized and linked to the expense. Everything downstream (the
 * finalize payload, attachment rows, the safety copy, the duplicate check)
 * must derive from that visible set, never from a second list that was only
 * ever appended to.
 *
 * Incident: removing a file from the upload list only changed the upload
 * component's own list. The form's session registries (temp filenames, upload
 * metadata, URL map, blob cache) were append-only, so every file that was ever
 * uploaded was finalized and given an attachment row at submit time.
 */

import { canonicalReceiptFileUrl } from "@/lib/receiptFileUrl";
import type { SupabaseClient } from "@supabase/supabase-js";
import { removeAttachmentSafely } from "@/lib/attachmentRemoval";
import { recoverTempFilenamesFromAttachmentUrls } from "@/lib/expenseAttachmentTempPaths";
import {
  invokeFinalizeExpenseReceipts,
  runWithConcurrency,
  type FinalizeReceiptsInput,
  type ReceiptFinalizationResult,
} from "@/lib/receiptFinalization";

/** The form's per-session upload registries, keyed by bare temp filename. */
export interface SessionReceiptRegistries {
  tempNames: Set<string>;
  meta: Map<string, unknown>;
  pathByUrl: Map<string, string>;
  blobs: Map<string, Blob>;
}

/** Bare temp object names (under `temp/{userId}/`) that a receipt URL refers to. */
export function tempNamesForAttachmentUrl(
  userId: string,
  url: string,
  pathByUrl?: Map<string, string>,
): string[] {
  const names = new Set<string>();
  const mapped = pathByUrl?.get(url);
  if (mapped) names.add(mapped);
  recoverTempFilenamesFromAttachmentUrls(userId, [url], names);
  return Array.from(names);
}

/**
 * The finalize manifest: the temp files to finalize for THIS submit, derived
 * only from the attachments currently visible in the form. URLs that already
 * have an attachment row (persisted) are excluded.
 */
export function buildFinalizeManifest(params: {
  userId: string;
  visibleUrls: readonly string[];
  persistedUrls?: ReadonlySet<string>;
  pathByUrl?: Map<string, string>;
}): string[] {
  const { userId, visibleUrls, persistedUrls, pathByUrl } = params;
  const manifest: string[] = [];
  const seen = new Set<string>();
  for (const url of visibleUrls) {
    if (!url || persistedUrls?.has(url)) continue;
    for (const name of tempNamesForAttachmentUrl(userId, url, pathByUrl)) {
      if (seen.has(name)) continue;
      seen.add(name);
      manifest.push(name);
    }
  }
  return manifest;
}

/**
 * Forget a removed attachment in every session registry so no later step
 * (finalize, backup copy, draft payload) can see it again. The storage object
 * itself is left alone (DOC-078: no browser-issued physical deletes).
 */
export function removeAttachmentFromSessionRegistries(
  registries: SessionReceiptRegistries,
  removed: { url?: string | null; storagePath?: string | null; userId?: string | null },
): string[] {
  const names = new Set<string>();
  if (removed.storagePath) names.add(removed.storagePath);
  if (removed.url) {
    const mapped = registries.pathByUrl.get(removed.url);
    if (mapped) names.add(mapped);
    if (removed.userId) {
      for (const n of tempNamesForAttachmentUrl(removed.userId, removed.url)) names.add(n);
    }
    registries.pathByUrl.delete(removed.url);
  }
  for (const name of names) {
    registries.tempNames.delete(name);
    registries.meta.delete(name);
    registries.blobs.delete(name);
  }
  return Array.from(names);
}

export interface ActiveAttachmentRow {
  id: string;
  storage_path?: string | null;
  file_url?: string | null;
  created_at?: string | null;
  deleted_at?: string | null;
}

function lastSegment(value: string): string {
  const clean = value.split("?")[0].split("#")[0];
  const seg = clean.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** Bare object name an attachment row points at, or "" when it cannot be told. */
export function attachmentRowObjectName(row: ActiveAttachmentRow): string {
  if (row.storage_path) return lastSegment(row.storage_path);
  if (row.file_url) return lastSegment(row.file_url);
  return "";
}

/**
 * Which active rows of a freshly created expense must be unlinked so the
 * stored set equals the intended set:
 *  - rows for a file that is no longer in the intended set (removed by the
 *    employee after an earlier attempt already attached it), and
 *  - second and later rows for the same file (a retried attach).
 * Rows whose object cannot be identified are never touched.
 */
export function planAttachmentReconciliation(
  rows: readonly ActiveAttachmentRow[],
  wantedNames: readonly string[],
): { keepIds: string[]; removeIds: string[] } {
  const wanted = new Set(wantedNames);
  const ordered = rows
    .filter((r) => !r.deleted_at)
    .slice()
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  const kept = new Set<string>();
  const keepIds: string[] = [];
  const removeIds: string[] = [];
  for (const row of ordered) {
    const name = attachmentRowObjectName(row);
    if (!name) {
      keepIds.push(row.id);
      continue;
    }
    if (!wanted.has(name) || kept.has(name)) {
      removeIds.push(row.id);
      continue;
    }
    kept.add(name);
    keepIds.push(row.id);
  }
  return { keepIds, removeIds };
}

/**
 * Make the active attachment rows of a just-attached expense equal the
 * intended set. Metadata-only (soft delete); storage objects are retained.
 * Throws if an unlink fails so the caller aborts before submitting.
 */
export async function reconcileExpenseAttachments(
  supabase: SupabaseClient,
  params: { expenseId: string; organizationId: string; wantedNames: readonly string[] },
): Promise<{ removed: number; kept: number }> {
  const { expenseId, organizationId, wantedNames } = params;
  const { data, error } = await supabase
    .from("attachments")
    .select("*")
    .eq("expense_id", expenseId)
    .eq("organization_id", organizationId);
  if (error) throw error;

  const { keepIds, removeIds } = planAttachmentReconciliation(
    (data ?? []) as ActiveAttachmentRow[],
    wantedNames,
  );
  for (const attachmentId of removeIds) {
    await removeAttachmentSafely(supabase, {
      attachmentId,
      reason: "not_in_submitted_set",
      source: "expense_form_reconcile",
    });
  }
  return { removed: removeIds.length, kept: keepIds.length };
}

/** Display metadata kept per temp object while the form is open. */
export interface SessionTempMeta {
  filename: string;
  file_size: number;
  content_type: string;
}

/**
 * Remember an upload the employee just completed (new-expense mode). The form's
 * canonical attachment list is updated by the caller; this keeps the finalize
 * registries in step with it.
 */
export function registerUploadedAttachment(
  registries: SessionReceiptRegistries & { meta: Map<string, SessionTempMeta> },
  upload: {
    url: string;
    storagePath?: string | null;
    filename: string;
    fileSize?: number | null;
    contentType?: string | null;
    blob?: Blob;
  },
  userId?: string | null,
): void {
  if (userId) {
    for (const name of tempNamesForAttachmentUrl(userId, upload.url)) registries.tempNames.add(name);
  }
  if (!upload.storagePath) return;
  registries.tempNames.add(upload.storagePath);
  registries.pathByUrl.set(upload.url, upload.storagePath);
  registries.meta.set(upload.storagePath, {
    filename: upload.filename,
    file_size: upload.fileSize ?? 0,
    content_type: upload.contentType || "image/jpeg",
  });
  if (upload.blob) registries.blobs.set(upload.storagePath, upload.blob);
}

/**
 * Finalize the manifest's temp files onto `expenseId` (server-side, via the
 * edge function) and insert one attachment row per finalized file. Exactly the
 * files in `manifest` are acted on - nothing else is read from the registries.
 */
export async function finalizeAndLinkReceipts(
  supabase: SupabaseClient,
  params: {
    expenseId: string;
    organizationId: string;
    userId: string;
    manifest: readonly string[];
    meta: Map<string, SessionTempMeta>;
    blobCache?: Map<string, Blob>;
  },
): Promise<ReceiptFinalizationResult[]> {
  const { expenseId, organizationId, userId, manifest, meta, blobCache } = params;

  const receipts: FinalizeReceiptsInput[] = manifest.filter(Boolean).map((fileName) => {
    const m = meta.get(fileName);
    return {
      filename: fileName,
      contentType: m?.content_type || "image/jpeg",
      fileSize: m?.file_size || 0,
    };
  });

  // Server-side download -> upload -> download-verify. No browser storage moves.
  const allResults = await invokeFinalizeExpenseReceipts(supabase, {
    expenseId,
    userId,
    receipts,
    blobCache,
  });

  const insertTasks = allResults.map((result) => async (): Promise<ReceiptFinalizationResult | null> => {
    if (result.status === "failed") return result;

    const m = meta.get(result.filename);
    const filename = m?.filename || result.filename;
    const contentType = m?.content_type || "image/jpeg";
    const fileSize = Number.isFinite(m?.file_size) ? (m?.file_size as number) : 0;

    const { error: attachmentInsertError } = await supabase.from("attachments").insert({
      expense_id: expenseId,
      organization_id: organizationId,
      file_url: canonicalReceiptFileUrl(result.fileUrl, import.meta.env.VITE_SUPABASE_URL),
      filename,
      content_type: contentType,
      uploaded_by: userId,
      file_size: fileSize > 0 ? fileSize : null,
      storage_path: result.resolvedPath,
    });

    if (attachmentInsertError) {
      console.error("[finalizeAndLinkReceipts] attachment insert error", {
        fileName: result.filename,
        resolvedPath: result.resolvedPath,
        attachmentInsertError,
      });
      return { ...result, status: "failed" as const, resolvedPath: null };
    }
    return result;
  });

  const perFileResults = await runWithConcurrency(insertTasks, 2);
  return perFileResults.filter((r): r is ReceiptFinalizationResult => r != null);
}
