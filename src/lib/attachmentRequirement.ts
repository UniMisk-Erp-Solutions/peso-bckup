/**
 * Bill/receipt requirement (DOC-150). The database is the authority
 * (validate_expense_attachment_requirement_v1 on the transition to 'submitted'); this mirrors its
 * rule so the form can say the same thing BEFORE any request.
 *
 * Rule: amount > organization_settings.attachment_required_above_amount requires one live bill.
 * "Above" is strict: an amount EQUAL to the threshold needs no bill.
 */

export function isBillRequired(amount: number | string | null | undefined, threshold: number | string | null | undefined): boolean {
  if (threshold === null || threshold === undefined || threshold === "") return false;
  const t = Number(threshold);
  const a = Number(amount ?? 0);
  if (!Number.isFinite(t) || !Number.isFinite(a)) return false;
  // compare in paise so 499.01 > 499 is exact and 499.00 === 499
  return Math.round(a * 100) > Math.round(t * 100);
}

/** Same wording as the database message: "₹499", "₹499.5" - never "₹499.00". */
export function formatThreshold(threshold: number | string): string {
  const t = Number(threshold);
  if (!Number.isFinite(t)) return String(threshold);
  return Number.isInteger(t) ? String(t) : String(parseFloat(t.toFixed(2)));
}

export function billRequiredMessage(threshold: number | string): string {
  return `Bill photos are required for expenses above ₹${formatThreshold(threshold)}. Please upload at least one receipt or bill before submitting.`;
}

/** True when an error (any layer) is the bill-required refusal. */
export function isBillRequiredError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const code = err && typeof err === "object" ? String((err as { hint?: unknown; details?: unknown }).hint ?? (err as { details?: unknown }).details ?? "") : "";
  return /bill photos are required for expenses above/i.test(raw) || /attachment_required/i.test(code);
}
