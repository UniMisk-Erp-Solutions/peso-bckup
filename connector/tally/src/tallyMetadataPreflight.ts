import type { TallyClient } from "./tallyClient.js";

/**
 * Import-based preflight was unsafe: it wrote a test ledger into whichever company
 * Tally had open. Keep this compatibility API read-only and fail closed until an
 * isolated-tested, non-mutating readiness check is available.
 */
export async function probeMetadataImportReady(
  tally: TallyClient,
  companyName: string,
): Promise<{ ok: false; excerpt: string }> {
  void tally;
  return {
    ok: false,
    excerpt: companyName.trim()
      ? "metadata import readiness probe disabled; no Tally XML was sent"
      : "company_not_configured; no Tally XML was sent",
  };
}
