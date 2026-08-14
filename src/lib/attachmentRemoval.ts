/**
 * Attachment removal — soft delete only, never a physical storage delete (DOC-078).
 *
 * Incident that motivated this (DOC-077 §5d): a receipt was uploaded at 17:56:27 UTC,
 * previewed successfully at 17:57:04, and physically destroyed at 18:00:14 by a
 * browser-issued `storage.object.delete_many` from the uploader's own authenticated
 * session. The bucket is unversioned, the file had no staging twin, and no backup
 * covered its ~4-minute lifetime. The bytes are gone.
 *
 * The rule this module enforces: **no ordinary browser action may physically delete a
 * linked receipt object.** Removing an attachment now only changes metadata. Storage
 * objects are retained, so a mistaken tap can always be undone, and a metadata failure
 * can never destroy bytes.
 *
 * Physical purge is deliberately out of scope — see DOC-078 §"Physical purge policy".
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** PostgREST code for "function not found" — the migration has not been applied yet. */
const RPC_MISSING = "PGRST202";

export type AttachmentRemovalMode =
  /** soft_delete_attachment RPC applied the deletion — row retained, object retained. */
  | "soft_deleted"
  /** Migration not yet applied: the row was unlinked, but the object was still retained. */
  | "row_removed_object_retained"
  /** Client-only attachment that was never persisted. */
  | "local_only";

export type AttachmentRemovalResult = {
  mode: AttachmentRemovalMode;
  /** Always false — this module never issues a storage delete. */
  objectDeleted: false;
  /** True when the removal can be undone through restoreAttachment(). */
  undoable: boolean;
  attachmentId: string | null;
};

function isRpcMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === RPC_MISSING || Boolean(error.message?.includes("soft_delete_attachment"));
}

/** True for optimistic client-side ids that never reached the database. */
export function isLocalOnlyAttachmentId(attachmentId?: string | null): boolean {
  return !attachmentId || attachmentId.startsWith("temp-");
}

/**
 * Removes an attachment from an expense **without deleting any storage object**.
 *
 * Prefers the server-authorized soft delete. When that RPC is absent (migration not yet
 * applied) it falls back to unlinking the metadata row — still never touching storage,
 * so the previous destructive behaviour is gone either way.
 */
export async function removeAttachmentSafely(
  supabase: SupabaseClient,
  params: { attachmentId: string | null; reason?: string; source?: string },
): Promise<AttachmentRemovalResult> {
  const { attachmentId } = params;

  if (isLocalOnlyAttachmentId(attachmentId)) {
    return { mode: "local_only", objectDeleted: false, undoable: false, attachmentId: null };
  }

  const { error } = await supabase.rpc("soft_delete_attachment", {
    p_attachment_id: attachmentId,
    p_reason: params.reason ?? null,
    p_source: params.source ?? "expense_form",
  });

  if (!error) {
    return {
      mode: "soft_deleted",
      objectDeleted: false,
      undoable: true,
      attachmentId,
    };
  }

  if (!isRpcMissing(error)) {
    throw error;
  }

  // Migration not applied yet. Unlink the row so the UI behaves, but leave the object
  // in place — losing the link is recoverable, losing the bytes is not.
  const { error: deleteError } = await supabase
    .from("attachments")
    .delete()
    .eq("id", attachmentId as string);

  if (deleteError) throw deleteError;

  return {
    mode: "row_removed_object_retained",
    objectDeleted: false,
    undoable: false,
    attachmentId,
  };
}

/** Reverses a soft delete. No-op modes return false rather than throwing. */
export async function restoreAttachment(
  supabase: SupabaseClient,
  attachmentId: string,
): Promise<boolean> {
  const { error } = await supabase.rpc("restore_soft_deleted_attachment", {
    p_attachment_id: attachmentId,
  });
  if (!error) return true;
  if (isRpcMissing(error)) return false;
  throw error;
}
