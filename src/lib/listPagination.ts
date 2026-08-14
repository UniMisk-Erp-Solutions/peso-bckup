/**
 * List Pagination Helpers
 *
 * Pure, tested utilities shared by Manage Users, Balances, Transfer History,
 * Sent Offers, and any other paginated list.  No React or Supabase imports.
 */

/** Total number of pages for a given list size and page size. Always ≥ 1. */
export function getTotalPages(totalItems: number, pageSize: number): number {
  if (pageSize <= 0 || totalItems <= 0) return 1;
  return Math.ceil(totalItems / pageSize);
}

/**
 * Clamp a requested page number to the valid range [1, totalPages].
 * Safe to call even when totalItems or pageSize is 0.
 */
export function clampPage(page: number, totalItems: number, pageSize: number): number {
  const total = getTotalPages(totalItems, pageSize);
  return Math.max(1, Math.min(Math.floor(page), total));
}

/** Slice an array to the items visible on a single page. */
export function paginateItems<T>(items: T[], page: number, pageSize: number): T[] {
  if (pageSize <= 0) return items;
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/**
 * Human-readable pagination range for "Showing X–Y of Z".
 * Returns { from: 0, to: 0, total: 0 } when the list is empty.
 */
export function getPaginationRange(
  page: number,
  pageSize: number,
  totalItems: number,
): { from: number; to: number; total: number } {
  if (totalItems === 0) return { from: 0, to: 0, total: 0 };
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalItems);
  return { from, to, total: totalItems };
}

/**
 * Page numbers to show in a pagination control, with ellipsis represented by -1.
 *
 * Example (page=5, totalPages=12, maxVisible=7):
 *   [1, -1, 4, 5, 6, -1, 12]
 */
export function getVisiblePageNumbers(
  page: number,
  totalPages: number,
  maxVisible = 7,
): number[] {
  if (totalPages <= maxVisible) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: number[] = [];
  const half = Math.floor((maxVisible - 2) / 2); // slots between first and last

  let start = Math.max(2, page - half);
  let end = Math.min(totalPages - 1, page + half);

  // Expand the window if it was clamped
  if (end - start + 1 < maxVisible - 2) {
    if (start === 2) {
      end = Math.min(totalPages - 1, start + maxVisible - 3);
    } else {
      start = Math.max(2, end - maxVisible + 3);
    }
  }

  pages.push(1);
  if (start > 2) pages.push(-1); // leading ellipsis
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < totalPages - 1) pages.push(-1); // trailing ellipsis
  pages.push(totalPages);

  return pages;
}
