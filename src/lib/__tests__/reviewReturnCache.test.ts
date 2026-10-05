import { describe, expect, it, beforeEach } from "vitest";
import {
  REVIEW_RETURN_CACHE_MAX_ROWS,
  REVIEW_RETURN_CACHE_TTL_MS,
  REVIEW_RETURN_CACHE_VERSION,
  type ReviewReturnCache,
  clearReviewReturnCache,
  loadReviewReturnCache,
  reviewQueryKey,
  saveReviewReturnCache,
  validateReviewReturnCache,
} from "@/lib/reviewReturnCache";

const ORG = "org-1";
const REV = "rev-1";
const NOW = 1_700_000_000_000;

const cache = (over: Partial<ReviewReturnCache> = {}): ReviewReturnCache => ({
  version: REVIEW_RETURN_CACHE_VERSION,
  organizationId: ORG,
  reviewerUserId: REV,
  mode: "filtered",
  queryKey: "filtered|c76edc75||all|all|created_at|desc",
  rows: [{ id: "e1" }, { id: "e2" }],
  totalAvailable: 30,
  filteredResultCount: 30,
  allExpensesLoaded: true,
  truncated: false,
  currentPage: 2,
  savedAt: NOW,
  ...over,
});

beforeEach(() => sessionStorage.clear());

describe("save / load round-trip", () => {
  it("restores rows, page and counts for the same org+reviewer", () => {
    saveReviewReturnCache(cache());
    const loaded = loadReviewReturnCache(ORG, REV, NOW + 1000);
    expect(loaded?.rows).toHaveLength(2);
    expect(loaded?.currentPage).toBe(2);
    expect(loaded?.filteredResultCount).toBe(30);
    expect(loaded?.mode).toBe("filtered");
  });
  it("clear removes it", () => {
    saveReviewReturnCache(cache());
    clearReviewReturnCache(ORG, REV);
    expect(loadReviewReturnCache(ORG, REV, NOW)).toBeNull();
  });
});

describe("isolation + safety (§18/§29)", () => {
  it("does not restore for a different org or reviewer", () => {
    saveReviewReturnCache(cache());
    expect(loadReviewReturnCache("org-2", REV, NOW)).toBeNull();
    expect(loadReviewReturnCache(ORG, "rev-2", NOW)).toBeNull();
  });
  it("rejects a wrong version", () => {
    expect(
      validateReviewReturnCache({ ...cache(), version: 9 }, { organizationId: ORG, reviewerUserId: REV, now: NOW }),
    ).toBeNull();
  });
  it("rejects a stale snapshot beyond the TTL", () => {
    saveReviewReturnCache(cache({ savedAt: NOW }));
    expect(loadReviewReturnCache(ORG, REV, NOW + REVIEW_RETURN_CACHE_TTL_MS + 1)).toBeNull();
  });
  it("ignores corrupt JSON", () => {
    sessionStorage.setItem(`pesowise:review-return-cache:v1:${ORG}:${REV}`, "{bad");
    expect(loadReviewReturnCache(ORG, REV, NOW)).toBeNull();
  });
});

describe("max-row guard (§11)", () => {
  it("does not persist an oversized list", () => {
    const rows = Array.from({ length: REVIEW_RETURN_CACHE_MAX_ROWS + 1 }, (_, i) => ({ id: `e${i}` }));
    saveReviewReturnCache(cache({ rows }));
    expect(loadReviewReturnCache(ORG, REV, NOW)).toBeNull();
  });
});

describe("reviewQueryKey", () => {
  it("is stable for the same semantic query and differs when the employee changes", () => {
    const base = {
      mode: "filtered" as const,
      employeeUserId: "u1",
      generalSearch: null,
      statusFilter: "all",
      timePeriod: "all",
      sortBy: "created_at",
      sortOrder: "desc",
    };
    expect(reviewQueryKey(base)).toBe(reviewQueryKey({ ...base }));
    expect(reviewQueryKey(base)).not.toBe(reviewQueryKey({ ...base, employeeUserId: "u2" }));
    // General search is normalized (trim + lowercase).
    expect(reviewQueryKey({ ...base, employeeUserId: null, generalSearch: " CCTV " })).toBe(
      reviewQueryKey({ ...base, employeeUserId: null, generalSearch: "cctv" }),
    );
  });

  it("distinct expense months never share identity, and an omitted month defaults to 'all' (§14)", () => {
    const base = {
      mode: "filtered" as const,
      employeeUserId: null,
      generalSearch: null,
      statusFilter: "all",
      timePeriod: "all",
      sortBy: "created_at",
      sortOrder: "desc",
    };
    expect(reviewQueryKey({ ...base, expenseMonth: "2026-08" })).not.toBe(
      reviewQueryKey({ ...base, expenseMonth: "2026-09" }),
    );
    expect(reviewQueryKey({ ...base, expenseMonth: "all" })).toBe(reviewQueryKey(base));
  });
});
