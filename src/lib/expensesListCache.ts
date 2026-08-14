/**
 * Stale-while-revalidate persistence for the Expenses list (localStorage).
 *
 * The page keeps an in-memory Map for instant in-session navigation, but that is lost on
 * refresh. This backs it with localStorage so a hard refresh paints the last-known list
 * immediately while fresh data loads in the background. Generic over the row type so the
 * page's Expense interface stays the single source of truth (no circular import).
 */

export type PersistedExpensesListEntry<T> = {
  expenses: T[];
  totalCount: number;
  allLoaded: boolean;
};

const STORAGE_PREFIX = "pesowise-expenses-list-v1";
/** Show cached rows for up to a day while revalidating; older than that, fetch fresh first. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Cap persisted rows so we never blow the localStorage quota on large orgs. */
const MAX_PERSISTED_ITEMS = 200;

function cacheKey(userId: string): string {
  return `${STORAGE_PREFIX}:${userId}`;
}

export function readPersistedExpensesCache<T>(
  userId: string | undefined,
): PersistedExpensesListEntry<T> | null {
  if (!userId || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedExpensesListEntry<T> & { cachedAt?: number };
    if (!parsed?.cachedAt || Date.now() - parsed.cachedAt > MAX_AGE_MS) {
      localStorage.removeItem(cacheKey(userId));
      return null;
    }
    return {
      expenses: parsed.expenses ?? [],
      totalCount: parsed.totalCount ?? 0,
      allLoaded: parsed.allLoaded ?? false,
    };
  } catch {
    return null;
  }
}

export function writePersistedExpensesCache<T>(
  userId: string | undefined,
  entry: PersistedExpensesListEntry<T>,
): void {
  if (!userId || typeof window === "undefined") return;
  try {
    const capped = entry.expenses.slice(0, MAX_PERSISTED_ITEMS);
    // If we truncated, the cached snapshot is no longer the complete set — mark it so the
    // page revalidates rather than trusting a partial "all loaded" list.
    const allLoaded = entry.allLoaded && capped.length === entry.expenses.length;
    localStorage.setItem(
      cacheKey(userId),
      JSON.stringify({
        expenses: capped,
        totalCount: entry.totalCount,
        allLoaded,
        cachedAt: Date.now(),
      }),
    );
  } catch {
    // Quota or private mode — ignore; in-memory cache still works.
  }
}
