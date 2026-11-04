/**
 * Canonical public URL for a stored receipt.
 *
 * `finalize-expense-receipts` runs inside the Supabase network and builds the stored `file_url` from its
 * INTERNAL base URL (`http://supabase-kong:8000/...`), which no browser can reach (about 13,700 active rows,
 * 666 in the last 7 days; every one of them also has a `storage_path`). New rows are written with the PUBLIC base
 * instead. Historical rows are NOT rewritten here; readers keep deriving the URL from `storage_path`.
 */
const INTERNAL_HOST = /^https?:\/\/(?:supabase-kong|kong|localhost|127\.0\.0\.1|host\.docker\.internal)(?::\d+)?(?=\/)/i;

export function canonicalReceiptFileUrl(fileUrl: string | null | undefined, publicBaseUrl: string | null | undefined): string {
  const url = (fileUrl ?? "").trim();
  const base = (publicBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (!url || !base || !INTERNAL_HOST.test(url)) return url;
  return url.replace(INTERNAL_HOST, base);
}
