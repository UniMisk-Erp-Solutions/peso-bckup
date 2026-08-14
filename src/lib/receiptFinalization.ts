/**
 * Receipt finalization — move temp receipts to their permanent expense folder
 * via a Supabase Edge Function (server-side, no browser Storage calls).
 *
 * The browser calls `invokeFinalizeExpenseReceipts`, which POSTs to the
 * `finalize-expense-receipts` edge function. The EF uses the service-role key
 * to run a server-side download → upload → download-verify sequence that is
 * not subject to self-hosted gateway CORS/504 issues.
 *
 * If the EF is unavailable, synthetic results are returned:
 *  - "temporary_fallback" for files whose blob is in the in-memory cache
 *  - "failed" for files with no cached blob
 *
 * Safe rules enforced here:
 *  - No storage.move / storage.copy / storage.createSignedUrl / storage.download
 *    from the browser during finalization or backup.
 *  - The service-role key never leaves the Edge Function.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReceiptFinalizationStatus =
  | "finalized"
  | "temporary_fallback"
  | "failed";

export type ReceiptFinalizationResult = {
  /** Bucket-relative source path (temp/{userId}/{filename}). */
  sourcePath: string;
  /** Desired final bucket-relative path ({expenseId}/{filename}). */
  desiredFinalPath: string;
  /** Confirmed path used for the attachment row. Null only for "failed". */
  resolvedPath: string | null;
  status: ReceiptFinalizationStatus;
  /** Original bare filename (e.g. "1749123456789-abc.jpg"). */
  filename: string;
  /** Public URL of resolvedPath. Undefined only for "failed". */
  fileUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  /**
   * In-memory blob for this file, populated from the session upload cache.
   * Present when status is "temporary_fallback" (blob was captured at upload
   * time). May also be present for "finalized" when EF returned successfully
   * and a blob was found in the cache — backup reads this to avoid any network
   * call after submission.
   */
  cachedBlob?: Blob;
};

export type FinalizeReceiptsInput = {
  /** Bare filename (no "/" or URL scheme). */
  filename: string;
  contentType?: string;
  fileSize?: number;
};

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Run `tasks` with at most `limit` concurrent at any one time, preserving
 * input order in the returned results array.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  if (workerCount === 0) return results;
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Edge Function invocation
// ---------------------------------------------------------------------------

/**
 * Finalize receipt files for an expense by calling the server-side
 * `finalize-expense-receipts` edge function.
 *
 * The edge function validates expense ownership, builds source and destination
 * paths server-side, and runs download→upload→download-verify per file.
 * The browser never calls storage.move / copy / createSignedUrl / download.
 *
 * Results are enriched with `cachedBlob` from `blobCache` (keyed by bare
 * filename), so the post-submit backup path has zero additional network calls.
 *
 * If the edge function is unreachable or returns an error, synthetic results
 * are returned so the expense can still complete:
 *  - Files with a cached blob  → "temporary_fallback" at temp path
 *  - Files without a cached blob → "failed"
 */
export async function invokeFinalizeExpenseReceipts(
  supabase: SupabaseClient,
  params: {
    expenseId: string;
    userId: string;
    receipts: FinalizeReceiptsInput[];
    blobCache?: Map<string, Blob>;
  },
): Promise<ReceiptFinalizationResult[]> {
  const { expenseId, userId, receipts, blobCache } = params;

  const { data, error } = await supabase.functions.invoke(
    "finalize-expense-receipts",
    { body: { expenseId, receipts } },
  );

  if (error || !data || data.ok === false || !data.results) {
    // Log structured EF error fields only — no tokens, blobs, or secrets.
    if (data?.ok === false) {
      console.warn(
        "[invokeFinalizeExpenseReceipts] edge function returned structured error — synthetic fallback",
        {
          expenseId,
          requestId: data.requestId,
          stage: data.stage,
          code: data.code,
        },
      );
    } else {
      console.warn(
        "[invokeFinalizeExpenseReceipts] edge function unavailable — synthetic fallback",
        { expenseId, error: error?.message ?? "no results in response" },
      );
    }

    return receipts.map((r): ReceiptFinalizationResult => {
      const sourcePath = `temp/${userId}/${r.filename}`;
      const desiredFinalPath = `${expenseId}/${r.filename}`;
      const cachedBlob = blobCache?.get(r.filename);
      if (cachedBlob) {
        return {
          sourcePath,
          desiredFinalPath,
          resolvedPath: sourcePath,
          status: "temporary_fallback",
          filename: r.filename,
          fileUrl: supabase.storage
            .from("receipts")
            .getPublicUrl(sourcePath).data.publicUrl,
          cachedBlob,
        };
      }
      return {
        sourcePath,
        desiredFinalPath,
        resolvedPath: null,
        status: "failed",
        filename: r.filename,
        errorMessage: "Edge function unavailable and no cached blob",
      };
    });
  }

  // Enrich EF results with cachedBlob from the in-memory upload cache.
  return (
    data.results as Array<Omit<ReceiptFinalizationResult, "cachedBlob">>
  ).map(
    (r): ReceiptFinalizationResult => ({
      ...r,
      cachedBlob: blobCache?.get(r.filename),
    }),
  );
}
