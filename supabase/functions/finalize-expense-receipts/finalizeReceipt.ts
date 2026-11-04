/**
 * One receipt: temp object -> final object.
 *
 * BEFORE (v4): list(dest) + download(temp) + upload(dest) + download(dest) = every byte of the file crosses this
 * function THREE times (two reads, one write) plus a listing, per file, inside the Submit request.
 *
 * NOW (v5): list(dest) + copy(temp -> dest) + list(dest)  = three metadata calls, ZERO bytes through the function.
 * `copy` is the storage service's own server-side object copy. The old download/upload/verify sequence is kept
 * as a fallback for a copy that is rejected, so a storage quirk can never turn into a lost receipt.
 *
 * No Deno-only imports here so the logic is unit-testable.
 */

export type ReceiptResult = {
  filename: string;
  sourcePath: string;
  desiredFinalPath: string;
  resolvedPath: string | null;
  status: "finalized" | "temporary_fallback" | "failed";
  fileUrl?: string;
  errorMessage?: string;
  /** How the final object was produced (telemetry / tests only). */
  method?: "already_present" | "copy" | "download_upload";
};

export interface StorageBucketLike {
  list(path: string, opts?: { search?: string; limit?: number }): Promise<{
    data: Array<{ name: string }> | null;
    error?: { message: string } | null;
  }>;
  copy(from: string, to: string): Promise<{ data?: unknown; error: { message: string } | null }>;
  download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>;
  upload(
    path: string,
    body: Blob,
    opts: { upsert: boolean; contentType: string },
  ): Promise<{ error: { message: string } | null }>;
  getPublicUrl(path: string): { data: { publicUrl: string } };
}

async function existsAt(bucket: StorageBucketLike, dir: string, filename: string): Promise<boolean> {
  const { data } = await bucket.list(dir, { search: filename, limit: 1 });
  return !!data?.some((f) => f.name === filename);
}

export async function finalizeOneReceipt(
  bucket: StorageBucketLike,
  p: { expenseId: string; userId: string; filename: string; contentType?: string },
): Promise<ReceiptResult> {
  const sourcePath = `temp/${p.userId}/${p.filename}`;
  const destPath = `${p.expenseId}/${p.filename}`;
  const done = (method: ReceiptResult["method"]): ReceiptResult => ({
    filename: p.filename,
    sourcePath,
    desiredFinalPath: destPath,
    resolvedPath: destPath,
    status: "finalized",
    fileUrl: bucket.getPublicUrl(destPath).data.publicUrl,
    method,
  });

  // A. Idempotent probe: a retry after a lost response finds the file already in place.
  if (await existsAt(bucket, p.expenseId, p.filename)) return done("already_present");

  // B. Server-side copy (no bytes through this function), then confirm the object exists.
  const copied = await bucket.copy(sourcePath, destPath);
  if (!copied.error && (await existsAt(bucket, p.expenseId, p.filename))) return done("copy");

  // C. Fallback: the previous proven sequence (download -> upload -> download-verify).
  const { data: sourceBlob, error: downloadError } = await bucket.download(sourcePath);
  if (downloadError || !sourceBlob) {
    return {
      filename: p.filename,
      sourcePath,
      desiredFinalPath: destPath,
      resolvedPath: null,
      status: "failed",
      errorMessage: downloadError?.message ?? "Source file not found or inaccessible",
    };
  }
  await bucket.upload(destPath, sourceBlob, { upsert: true, contentType: p.contentType || "image/jpeg" });
  const { data: verifyBlob, error: verifyError } = await bucket.download(destPath);
  if (!verifyError && verifyBlob) return done("download_upload");

  // D. Last resort: keep the temp object as the receipt so the expense can still be submitted.
  return {
    filename: p.filename,
    sourcePath,
    desiredFinalPath: destPath,
    resolvedPath: sourcePath,
    status: "temporary_fallback",
    fileUrl: bucket.getPublicUrl(sourcePath).data.publicUrl,
    errorMessage: copied.error?.message,
  };
}
