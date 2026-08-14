import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchReviewQueuePage = vi.fn();
const fetchReviewQueuePageAnchor = vi.fn();
vi.mock("@/features/reviewQueueServer/api", () => ({
  fetchReviewQueuePage: (...a: unknown[]) => fetchReviewQueuePage(...a),
  fetchReviewQueuePageAnchor: (...a: unknown[]) => fetchReviewQueuePageAnchor(...a),
}));

import {
  CURSOR_HISTORY_MAX,
  SERVER_QUERY_PAGE_SIZE,
  fetchServerQueryPage,
  fetchServerQueryPageByNumber,
  newCursorHistory,
  recordCursor,
  totalPagesFor,
} from "@/lib/reviewServerPagination";
import type { ServerQueryParams } from "@/lib/reviewServerPagination";

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  transaction_number: null,
  batch_id: null,
  user_id: "u-6174",
  employee_name: "Sanjaykumar Vinodbhai Katara",
  employee_id: "6174",
  employee_email: null,
  identity_source: "profile",
  identity_issue: null,
  current_balance: 0,
  title: "row",
  purpose: null,
  category: null,
  destination: null,
  total_amount: 100,
  status: "level_2_verified",
  approval_tier: null,
  created_at: "2026-06-30T10:00:00Z",
  trip_start: "2026-06-30",
  is_resubmitted: false,
  was_reviewer_corrected: false,
  is_actionable: false,
  view_only: true,
  available_actions: [],
  custom_fields: [],
  ...over,
});

const page = (over: Record<string, unknown> = {}) => ({
  contract: "debug-review-queue",
  version: 1,
  filtered_total: 1663,
  total_pages: 67,
  has_more: true,
  next_cursor: { sk: "100", id: "e25", sort: "created_desc" },
  items: Array.from({ length: 25 }, (_, i) => item(`e${i + 1}`)),
  filtered_summary: null,
  selected_employee: null,
  ...over,
});

const params: ServerQueryParams = {
  organizationId: "org-1",
  statuses: ["level_2_verified"],
  sort: "created_desc",
};

beforeEach(() => {
  fetchReviewQueuePage.mockReset();
  fetchReviewQueuePageAnchor.mockReset();
});

describe("fetchServerQueryPage — one page, one request (§22/§45)", () => {
  it("requests exactly 25 rows and maps them + pagination", async () => {
    fetchReviewQueuePage.mockResolvedValueOnce(page());
    const res = await fetchServerQueryPage(params, { cursor: null });
    expect(fetchReviewQueuePage).toHaveBeenCalledTimes(1);
    const arg = fetchReviewQueuePage.mock.calls[0][0];
    expect(arg.pageSize).toBe(SERVER_QUERY_PAGE_SIZE);
    expect(arg.statuses).toEqual(["level_2_verified"]);
    expect(arg.cursor).toBeNull();
    expect(res.rows).toHaveLength(25);
    expect(res.filteredTotal).toBe(1663);
    expect(res.totalPages).toBe(67);
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toEqual({ sk: "100", id: "e25", sort: "created_desc" });
  });

  it("derives total pages when the server omits total_pages", async () => {
    fetchReviewQueuePage.mockResolvedValueOnce(page({ total_pages: 0, filtered_total: 30 }));
    const res = await fetchServerQueryPage(params, { cursor: null });
    expect(res.totalPages).toBe(2); // ceil(30/25)
  });
});

describe("fetchServerQueryPageByNumber — direct jump via anchor (§26/§52)", () => {
  it("page 1 skips the anchor call entirely", async () => {
    fetchReviewQueuePage.mockResolvedValueOnce(page());
    const { cursor } = await fetchServerQueryPageByNumber(params, { targetPage: 1 });
    expect(fetchReviewQueuePageAnchor).not.toHaveBeenCalled();
    expect(fetchReviewQueuePage).toHaveBeenCalledTimes(1);
    expect(cursor).toBeNull();
  });

  it("page 67 = ONE anchor call + ONE page call, never a 66-page walk", async () => {
    fetchReviewQueuePageAnchor.mockResolvedValueOnce({
      contract: "debug-review-page-anchor",
      version: 1,
      target_page: 67,
      page_size: 25,
      filtered_total: 1663,
      total_pages: 67,
      cursor: { sk: "1", id: "e1650", sort: "created_desc" },
    });
    fetchReviewQueuePage.mockResolvedValueOnce(page({ next_cursor: null, has_more: false }));
    const { page: res, cursor } = await fetchServerQueryPageByNumber(params, { targetPage: 67 });
    expect(fetchReviewQueuePageAnchor).toHaveBeenCalledTimes(1);
    expect(fetchReviewQueuePage).toHaveBeenCalledTimes(1);
    expect(cursor).toEqual({ sk: "1", id: "e1650", sort: "created_desc" });
    expect(res.rows).toHaveLength(25);
  });
});

describe("totalPagesFor", () => {
  it("computes ceil and floors empties at 0", () => {
    expect(totalPagesFor(1663, 25)).toBe(67);
    expect(totalPagesFor(25, 25)).toBe(1);
    expect(totalPagesFor(0, 25)).toBe(0);
    expect(totalPagesFor(1, 25)).toBe(1);
  });
});

describe("cursor history (§25) — Previous reuses stored cursors", () => {
  it("page 1 is always null; recorded cursors round-trip", () => {
    const h = newCursorHistory();
    expect(h.get(1)).toBeNull();
    recordCursor(h, 2, { sk: "100", id: "e25", sort: "created_desc" });
    recordCursor(h, 3, { sk: "50", id: "e50", sort: "created_desc" });
    expect(h.get(2)).toEqual({ sk: "100", id: "e25", sort: "created_desc" });
    expect(h.get(3)).toEqual({ sk: "50", id: "e50", sort: "created_desc" });
  });

  it("is bounded — page 1 survives eviction", () => {
    const h = newCursorHistory();
    for (let p = 2; p <= CURSOR_HISTORY_MAX + 50; p++) {
      recordCursor(h, p, { sk: String(p), id: `e${p}`, sort: "created_desc" });
    }
    expect(h.size).toBeLessThanOrEqual(CURSOR_HISTORY_MAX);
    expect(h.get(1)).toBeNull();
  });
});
