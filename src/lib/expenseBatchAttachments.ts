import { supabase } from "@/integrations/supabase/client";
import {
  invokeFinalizeExpenseReceipts,
  runWithConcurrency,
  type ReceiptFinalizationResult,
} from "@/lib/receiptFinalization";

export type TempUploadMeta = {
  filename: string;
  file_size: number;
  content_type: string;
};

/**
 * Move session temp receipt files into an expense folder and insert attachment rows.
 */
export async function moveTempFilesToExpense(params: {
  expenseId: string;
  userId: string;
  organizationId: string;
  tempFileNames: string[];
  metaByFilename: Map<string, TempUploadMeta>;
}): Promise<void> {
  const { expenseId, userId, organizationId, tempFileNames, metaByFilename } = params;
  if (tempFileNames.length === 0) return;

  const receipts = tempFileNames.filter(Boolean).map((fileName) => {
    const meta = metaByFilename.get(fileName);
    return {
      filename: fileName,
      contentType: meta?.content_type || "image/jpeg",
      fileSize: meta?.file_size || 0,
    };
  });

  const allResults = await invokeFinalizeExpenseReceipts(supabase, {
    expenseId,
    userId,
    receipts,
  });

  const insertTasks = allResults.map(
    (result) => async (): Promise<ReceiptFinalizationResult | null> => {
      if (result.status === "failed") return result;

      const meta = metaByFilename.get(result.filename);
      const { error: insertError } = await supabase.from("attachments").insert({
        expense_id: expenseId,
        organization_id: organizationId,
        file_url: result.fileUrl || "",
        filename: meta?.filename || result.filename,
        content_type: meta?.content_type || "image/jpeg",
        uploaded_by: userId,
        file_size: meta?.file_size && meta.file_size > 0 ? meta.file_size : null,
        storage_path: result.resolvedPath,
      });

      if (insertError) {
        console.error("[batch] attachment insert error", { fileName: result.filename, insertError });
        return { ...result, status: "failed" as const, resolvedPath: null };
      }

      return result;
    },
  );

  const results = await runWithConcurrency(insertTasks, 2);
  const valid = results.filter((r): r is ReceiptFinalizationResult => r != null);
  const movedCount = valid.filter((r) => r.status === "finalized").length;
  const tempFallbackCount = valid.filter((r) => r.status === "temporary_fallback").length;

  if (movedCount === 0 && tempFallbackCount === 0 && tempFileNames.length > 0) {
    throw new Error("Failed to attach uploaded bill photos. Please re-upload and try again.");
  }
}

/**
 * Copy already-attached files from source expense to target (shared receipt mode).
 */
export async function copyAttachmentsFromExpense(params: {
  sourceExpenseId: string;
  targetExpenseId: string;
  userId: string;
  organizationId: string;
}): Promise<void> {
  const { sourceExpenseId, targetExpenseId, userId, organizationId } = params;

  const { data: sourceRows, error } = await supabase
    .from("attachments")
    .select("filename, content_type, file_url, file_size")
    .eq("expense_id", sourceExpenseId)
    .eq("organization_id", organizationId);

  if (error || !sourceRows?.length) {
    throw new Error("Shared receipt could not be linked to this expense.");
  }

  for (const row of sourceRows) {
    const fileUrl = row.file_url as string;
    const baseName = row.filename || `receipt-${Date.now()}`;
    const uniqueName = `${Date.now()}-${baseName}`;
    const sourcePath = fileUrl.includes("/receipts/")
      ? decodeURIComponent(fileUrl.split("/receipts/")[1]?.split("?")[0] || "")
      : `${sourceExpenseId}/${baseName}`;

    const destPath = `${targetExpenseId}/${uniqueName}`;
    const { error: copyError } = await supabase.storage
      .from("receipts")
      .copy(sourcePath, destPath);

    if (copyError) {
      console.error("copyAttachmentsFromExpense:", copyError);
      continue;
    }

    const { data: urlData } = supabase.storage.from("receipts").getPublicUrl(destPath);
    await supabase.from("attachments").insert({
      expense_id: targetExpenseId,
      organization_id: organizationId,
      file_url: urlData?.publicUrl || "",
      filename: row.filename,
      content_type: row.content_type,
      uploaded_by: userId,
      file_size: row.file_size,
    });
  }
}

export async function enforceMaxAttachmentSize(
  expenseId: string,
  organizationId: string,
): Promise<void> {
  const MAX_TOTAL_SIZE = 50 * 1024 * 1024;
  const { data, error } = await supabase
    .from("attachments")
    .select("file_size")
    .eq("expense_id", expenseId)
    .eq("organization_id", organizationId);

  if (error) {
    throw new Error("Failed to validate total attachment size.");
  }

  const totalBytes = (data || []).reduce((sum, item) => {
    const size = Number(item?.file_size || 0);
    return sum + (Number.isFinite(size) ? size : 0);
  }, 0);

  if (totalBytes > MAX_TOTAL_SIZE) {
    const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
    throw new Error(
      `Total attachment size is ${totalMB}MB, which exceeds the 50MB limit.`,
    );
  }
}
