/**
 * Defence in depth: an attachment may only be rendered inside the expense that owns it.
 *
 * Rows that carry an `expense_id` which differs from the expense on screen are dropped and reported
 * with a safe diagnostic (short id prefixes only, never urls, filenames or payloads). Rows without an
 * `expense_id` field cannot be checked and are kept, because the query that produced them was already
 * scoped to the expense. Backend corruption is therefore never hidden silently.
 */
export function filterAttachmentsForExpense<T extends { id: string; expense_id?: string | null }>(
  rows: readonly T[],
  expenseId: string,
  warn: (message: string, detail: { row: string; expected: string; actual: string }) => void = (m, d) =>
    console.warn(m, d),
): T[] {
  const kept: T[] = [];
  for (const row of rows) {
    if (row.expense_id && row.expense_id !== expenseId) {
      warn("[attachments] dropped a row that belongs to a different expense", {
        row: String(row.id).slice(0, 8),
        expected: expenseId.slice(0, 8),
        actual: String(row.expense_id).slice(0, 8),
      });
      continue;
    }
    kept.push(row);
  }
  return kept;
}
