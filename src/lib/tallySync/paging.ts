/**
 * Shared paging invariants for Tally dataset preparation (mirrors export workers).
 */
export function assertFullDatasetAssembled(
  total: number | null,
  assembled: number,
  label: string,
): void {
  if (total != null && assembled !== total) {
    throw new Error(`Incomplete ${label}: expected ${total}, assembled ${assembled}`);
  }
}

export type PageResult<T> = {
  rows: T[];
  hasMore: boolean;
  nextCursor: unknown;
  total: number | null;
};

/** Test helper: page until hasMore is false; fail-closed on total mismatch. */
export async function assembleAllPages<T>(
  pageSize: number,
  fetchPage: (cursor: unknown, withTotal: boolean) => Promise<PageResult<T>>,
  label: string,
): Promise<{ rows: T[]; pages: number }> {
  const out: T[] = [];
  let cursor: unknown = null;
  let total: number | null = null;
  let pages = 0;
  for (;;) {
    const p = await fetchPage(cursor, pages === 0);
    if (pages === 0) total = p.total;
    out.push(...p.rows);
    pages += 1;
    if (!p.hasMore || p.nextCursor == null) break;
    cursor = p.nextCursor;
  }
  assertFullDatasetAssembled(total, out.length, label);
  return { rows: out, pages };
}
