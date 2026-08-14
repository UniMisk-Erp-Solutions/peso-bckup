/**
 * Shared client-side search for expense list rows (review queue, my expenses, etc.).
 *
 * Identity options control whether employee email / employee ID are included so
 * employee-ID-only organizations never expose synthetic auth emails in search.
 */
import { employeeIdFromSyntheticEmail } from "@/lib/personIdentitySearch";

export type ExpenseSearchRow = {
  title?: string | null;
  destination?: string | null;
  purpose?: string | null;
  category?: string | null;
  status?: string | null;
  total_amount?: number | null;
  user_name?: string | null;
  user_email?: string | null;
  user_employee_id?: string | null;
  transaction_number?: string | null;
  custom_fields?: Record<string, string>;
};

export type ExpenseSearchIdentityOptions = {
  /** Include the full email address in search tokens. */
  includeEmail: boolean;
  /** Include the employee_id field in search tokens. */
  includeEmployeeId: boolean;
  /**
   * When employee_id is absent and the email is synthetic, parse and include
   * only the employee-ID fragment — never the full email.
   */
  allowSyntheticEmployeeIdFallback: boolean;
};

/** Default options preserve the original all-fields behavior. */
const DEFAULT_IDENTITY_OPTIONS: ExpenseSearchIdentityOptions = {
  includeEmail: true,
  includeEmployeeId: true,
  allowSyntheticEmployeeIdFallback: true,
};

function collectSearchTokens(
  row: ExpenseSearchRow,
  identityOptions: ExpenseSearchIdentityOptions,
): string[] {
  const tokens: string[] = [];
  const add = (value: unknown) => {
    if (value == null) return;
    const text = String(value).trim();
    if (text) tokens.push(text.toLowerCase());
  };

  // Non-identity fields — always searched
  add(row.title);
  add(row.destination);
  add(row.purpose);
  add(row.category);
  add(row.status);
  add(row.user_name);
  add(row.transaction_number);
  add(row.total_amount);

  if (row.custom_fields) {
    for (const [key, value] of Object.entries(row.custom_fields)) {
      add(key);
      add(value);
    }
  }

  // Identity-gated fields
  if (identityOptions.includeEmail) {
    add(row.user_email);
  }

  if (identityOptions.includeEmployeeId) {
    add(row.user_employee_id);
  }

  // Synthetic email fallback: only the ID fragment, never the full email
  if (
    identityOptions.allowSyntheticEmployeeIdFallback &&
    !String(row.user_employee_id ?? "").trim()
  ) {
    add(employeeIdFromSyntheticEmail(row.user_email ?? ""));
  }

  return tokens;
}

export function expenseRowMatchesSearch(
  row: ExpenseSearchRow,
  searchTerm: string,
  identityOptions?: ExpenseSearchIdentityOptions,
): boolean {
  const query = searchTerm.trim().toLowerCase();
  if (!query) return true;

  const opts = identityOptions ?? DEFAULT_IDENTITY_OPTIONS;
  const haystack = collectSearchTokens(row, opts).join(" ");
  if (haystack.includes(query)) return true;

  // Also match individual query words (e.g. "6849 sanand").
  const words = query.split(/\s+/).filter(Boolean);
  return words.every((word) => haystack.includes(word));
}
