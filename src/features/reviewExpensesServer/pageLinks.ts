/**
 * Page quick-link algorithm (DOC-080 §9).
 *
 * Always: 1, 2, 3 (where they exist), the last page, and the current page with
 * one neighbour on each side. Duplicates collapse, and an ellipsis appears only
 * where a real numeric gap exists — never between consecutive pages.
 */

export type PageLink = number | "ellipsis";

export function buildPageLinks(currentPage: number, totalPages: number): PageLink[] {
  if (totalPages <= 0) return [];

  const wanted = new Set<number>();
  for (const p of [1, 2, 3, totalPages, currentPage - 1, currentPage, currentPage + 1]) {
    if (p >= 1 && p <= totalPages) wanted.add(p);
  }

  const pages = [...wanted].sort((a, b) => a - b);
  const out: PageLink[] = [];
  let previous = 0;

  for (const page of pages) {
    // Only a genuine gap earns an ellipsis; a single skipped page shows itself.
    if (previous !== 0 && page - previous > 1) {
      if (page - previous === 2) out.push(previous + 1);
      else out.push("ellipsis");
    }
    out.push(page);
    previous = page;
  }

  return out;
}

/** Validates manual page input. Returns the page, or a stable error key. */
export function validatePageInput(
  raw: string,
  totalPages: number,
): { ok: true; page: number } | { ok: false; error: "empty" | "notInteger" | "outOfRange" } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: "empty" };
  if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: "notInteger" };
  const page = Number(trimmed);
  if (!Number.isInteger(page)) return { ok: false, error: "notInteger" };
  if (page < 1 || page > totalPages) return { ok: false, error: "outOfRange" };
  return { ok: true, page };
}
