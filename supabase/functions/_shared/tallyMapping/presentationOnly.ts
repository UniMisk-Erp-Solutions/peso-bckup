/**
 * V2 integration: reports are persisted as metadata ledgers + flat UDFs only.
 * No expense/balance vouchers — avoids empty TDL / ledger errors / accounting side effects.
 */
export const TALLY_PRESENTATION_V2 = true;

export function isPresentationOnlyJob(parameters: unknown): boolean {
  if (!TALLY_PRESENTATION_V2) return false;
  const p = parameters && typeof parameters === "object" ? (parameters as Record<string, unknown>) : {};
  if (p.tally_accounting_vouchers === true) return false;
  return true;
}

export function syncRunIdFromJob(parameters: unknown): string | undefined {
  const p = parameters && typeof parameters === "object" ? (parameters as Record<string, unknown>) : {};
  const id = p.sync_run_id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}
