"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeMetadataImportReady = probeMetadataImportReady;
/**
 * Import-based preflight was unsafe: it wrote a test ledger into whichever company
 * Tally had open. Keep this compatibility API read-only and fail closed until an
 * isolated-tested, non-mutating readiness check is available.
 */
async function probeMetadataImportReady(tally, companyName) {
    void tally;
    return {
        ok: false,
        excerpt: companyName.trim()
            ? "metadata import readiness probe disabled; no Tally XML was sent"
            : "company_not_configured; no Tally XML was sent",
    };
}
