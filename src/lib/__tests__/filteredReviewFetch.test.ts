import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchReviewQueuePage = vi.fn();
vi.mock("@/features/reviewQueueServer/api", () => ({
  fetchReviewQueuePage: (...a: unknown[]) => fetchReviewQueuePage(...a),
}));

import {
  FILTERED_MAX_PAGES,
  engineerSortToServerSort,
  fetchFilteredReviewExpenses,
  reviewQueueItemToExpense,
} from "@/lib/filteredReviewFetch";

const item = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  transaction_number: "06174",
  batch_id: null,
  user_id: "u-6174",
  employee_name: "Sanjaykumar Vinodbhai Katara",
  employee_id: "6174",
  employee_email: null,
  identity_source: "profile",
  identity_issue: null,
  current_balance: 1000,
  title: "CCTV work",
  purpose: "Site",
  category: "Travel",
  destination: "Surat",
  total_amount: 3960,
  status: "submitted",
  approval_tier: "executive",
  created_at: "2026-06-30T10:00:00Z",
  trip_start: "2026-06-30",
  is_resubmitted: false,
  was_reviewer_corrected: false,
  is_actionable: false,
  view_only: true,
  available_actions: [],
  custom_fields: [{ source: "template", field_id: "f1", field_key: "vehicle", label: "Vehicle", value: "Car" }],
  ...over,
});

const page = (over: Record<string, unknown> = {}) => ({
  contract: "debug-review-queue",
  version: 1,
  filtered_total: 30,
  total_pages: 1,
  has_more: false,
  next_cursor: null,
  items: [item()],
  ...over,
});

beforeEach(() => fetchReviewQueuePage.mockReset());

describe("reviewQueueItemToExpense", () => {
  it("maps identity onto the row so it never flashes — (§39)", () => {
    const e = reviewQueueItemToExpense(item() as never) as {
      user_name: string;
      user_employee_id?: string;
      transaction_number?: string;
      user_id: string;
      total_amount: number;
      custom_fields?: Record<string, string>;
    };
    expect(e.user_name).toBe("Sanjaykumar Vinodbhai Katara");
    expect(e.user_employee_id).toBe("6174");
    expect(e.user_id).toBe("u-6174");
    expect(e.transaction_number).toBe("06174");
    expect(e.total_amount).toBe(3960);
    expect(e.custom_fields?.vehicle).toBe("Car");
  });
});

describe("engineerSortToServerSort", () => {
  it("maps created/trip × asc/desc", () => {
    expect(engineerSortToServerSort("created_at", "desc")).toBe("created_desc");
    expect(engineerSortToServerSort("created_at", "asc")).toBe("created_asc");
    expect(engineerSortToServerSort("trip_start", "desc")).toBe("expense_date_desc");
    expect(engineerSortToServerSort("trip_start", "asc")).toBe("expense_date_asc");
  });
});

describe("fetchFilteredReviewExpenses", () => {
  it("passes the employee user_id and returns only the filtered rows (not the full scope)", async () => {
    fetchReviewQueuePage.mockResolvedValue(page());
    const res = await fetchFilteredReviewExpenses({} as never, {
      organizationId: "org",
      employeeUserId: "u-6174",
      sort: "created_desc",
    });
    expect(fetchReviewQueuePage).toHaveBeenCalledTimes(1);
    expect(fetchReviewQueuePage.mock.calls[0][0]).toMatchObject({
      organizationId: "org",
      employeeUserId: "u-6174",
    });
    expect(res.rows).toHaveLength(1);
    expect(res.filteredTotal).toBe(30);
    expect(res.truncated).toBe(false);
  });

  it("bounds a huge general search: stops at the page cap and reports truncated (§9/§32/§46)", async () => {
    // A never-ending result (filtered_total huge, always has_more) must NOT be
    // downloaded in full — the loop stops at FILTERED_MAX_PAGES.
    let n = 0;
    fetchReviewQueuePage.mockImplementation(async () =>
      page({
        filtered_total: 5000,
        has_more: true,
        next_cursor: { sk: String(n), id: `c${n}` },
        items: [item({ id: `e${n++}` })],
      }),
    );
    const res = await fetchFilteredReviewExpenses({} as never, { organizationId: "org", generalSearch: "CCTV" });
    expect(fetchReviewQueuePage).toHaveBeenCalledTimes(FILTERED_MAX_PAGES);
    expect(res.truncated).toBe(true);
    expect(res.filteredTotal).toBe(5000);
    expect(res.rows.length).toBeLessThanOrEqual(FILTERED_MAX_PAGES);
  });

  it("passes the AbortSignal to the queue RPC and stops paging once aborted (§19/§31)", async () => {
    const controller = new AbortController();
    fetchReviewQueuePage.mockImplementation(async () => {
      controller.abort(); // abort after the first page resolves
      return page({ has_more: true, next_cursor: { sk: "1", id: "e1" } });
    });
    const res = await fetchFilteredReviewExpenses({} as never, {
      organizationId: "org",
      employeeUserId: "u-6174",
      signal: controller.signal,
    });
    // The signal is forwarded to the RPC, and the loop stops after the abort
    // rather than following next_cursor into another request.
    expect(fetchReviewQueuePage.mock.calls[0][0]).toMatchObject({ signal: controller.signal });
    expect(fetchReviewQueuePage).toHaveBeenCalledTimes(1);
    expect(res.rows).toHaveLength(1);
  });

  it("pages until has_more is false and de-duplicates by id", async () => {
    fetchReviewQueuePage
      .mockResolvedValueOnce(
        page({ has_more: true, next_cursor: { sk: "1", id: "e1" }, items: [item({ id: "e1" }), item({ id: "e2" })] }),
      )
      .mockResolvedValueOnce(
        page({ has_more: false, next_cursor: null, items: [item({ id: "e2" }), item({ id: "e3" })] }),
      );
    const res = await fetchFilteredReviewExpenses({} as never, { organizationId: "org", generalSearch: "CCTV" });
    expect(fetchReviewQueuePage).toHaveBeenCalledTimes(2);
    expect(res.rows.map((r) => r.id)).toEqual(["e1", "e2", "e3"]);
  });
});
