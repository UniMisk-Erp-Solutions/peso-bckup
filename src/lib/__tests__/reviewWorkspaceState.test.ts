import { describe, expect, it, beforeEach } from "vitest";
import {
  REVIEW_WORKSPACE_TTL_MS,
  REVIEW_WORKSPACE_VERSION,
  type ReviewWorkspaceState,
  clampRestoredPage,
  clearReviewWorkspaceState,
  consumeReviewReturnPending,
  loadReviewWorkspaceState,
  markReviewReturnPending,
  saveReviewWorkspaceState,
  validateReviewWorkspaceState,
} from "@/lib/reviewWorkspaceState";

const ORG = "org-1";
const REV = "reviewer-1";
const NOW = 1_700_000_000_000;

const snapshot = (over: Partial<ReviewWorkspaceState> = {}): ReviewWorkspaceState => ({
  version: REVIEW_WORKSPACE_VERSION,
  organizationId: ORG,
  reviewerUserId: REV,
  reviewerRole: "engineer",
  query: {
    mode: "filtered",
    employee: { userId: "c76edc75", name: "Sanjaykumar Vinodbhai Katara", employeeId: "6174", email: null },
    searchDraft: "6174",
    submittedSearch: "6174",
    generalSearch: null,
    statusFilter: "all",
    timePeriod: "all",
    expenseMonth: "all",
    sortBy: "created_at",
    sortOrder: "desc",
    customFilters: { Vehicle: "Car" },
    showOnlyActionable: true,
    includeTeamLeaderReports: false,
    includeExecutiveReports: true,
  },
  pagination: { page: 2, pageSize: 25 },
  scroll: { y: 400, anchorExpenseId: "exp-9" },
  savedAt: NOW,
  ...over,
});

beforeEach(() => sessionStorage.clear());

describe("save / load round-trip", () => {
  it("restores the exact query, page, sort and scroll for the same org+reviewer", () => {
    saveReviewWorkspaceState(snapshot());
    const loaded = loadReviewWorkspaceState(ORG, REV, NOW + 1000);
    expect(loaded?.query.employee?.userId).toBe("c76edc75");
    expect(loaded?.query.employee?.employeeId).toBe("6174");
    expect(loaded?.pagination.page).toBe(2);
    expect(loaded?.scroll.anchorExpenseId).toBe("exp-9");
    // v2: custom filters + actionable + hierarchy toggles round-trip (§36/§37).
    expect(loaded?.query.customFilters).toEqual({ Vehicle: "Car" });
    expect(loaded?.query.showOnlyActionable).toBe(true);
    expect(loaded?.query.includeTeamLeaderReports).toBe(false);
    expect(loaded?.query.includeExecutiveReports).toBe(true);
  });

  it("v3: exact expense month round-trips", () => {
    saveReviewWorkspaceState(snapshot({ query: { ...snapshot().query, expenseMonth: "2026-08" } }));
    const loaded = loadReviewWorkspaceState(ORG, REV, NOW + 1000);
    expect(loaded?.query.expenseMonth).toBe("2026-08");
  });

  it("clear removes it", () => {
    saveReviewWorkspaceState(snapshot());
    clearReviewWorkspaceState(ORG, REV);
    expect(loadReviewWorkspaceState(ORG, REV, NOW)).toBeNull();
  });
});

describe("isolation (§44 H/I)", () => {
  it("does NOT restore for a different organization", () => {
    saveReviewWorkspaceState(snapshot());
    expect(loadReviewWorkspaceState("org-2", REV, NOW)).toBeNull();
  });
  it("does NOT restore for a different reviewer", () => {
    saveReviewWorkspaceState(snapshot());
    expect(loadReviewWorkspaceState(ORG, "reviewer-2", NOW)).toBeNull();
  });
  it("validate rejects a snapshot whose stored org/reviewer differ from the caller", () => {
    expect(
      validateReviewWorkspaceState(snapshot({ organizationId: "other" }), {
        organizationId: ORG,
        reviewerUserId: REV,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("version + TTL + corrupt (§23/§24/§25/§44 J)", () => {
  it("rejects a wrong version", () => {
    expect(
      validateReviewWorkspaceState({ ...snapshot(), version: 99 }, { organizationId: ORG, reviewerUserId: REV, now: NOW }),
    ).toBeNull();
  });
  it("rejects a stale snapshot beyond the TTL", () => {
    saveReviewWorkspaceState(snapshot({ savedAt: NOW }));
    expect(loadReviewWorkspaceState(ORG, REV, NOW + REVIEW_WORKSPACE_TTL_MS + 1)).toBeNull();
  });
  it("rejects a snapshot from the future (clock/corruption)", () => {
    expect(
      validateReviewWorkspaceState(snapshot({ savedAt: NOW + 10_000 }), { organizationId: ORG, reviewerUserId: REV, now: NOW }),
    ).toBeNull();
  });
  it("ignores corrupt JSON safely", () => {
    sessionStorage.setItem(`pesowise:review-workspace:v1:${ORG}:${REV}`, "{not json");
    expect(loadReviewWorkspaceState(ORG, REV, NOW)).toBeNull();
  });
  it("rejects a non-object / missing query", () => {
    expect(validateReviewWorkspaceState(null, { organizationId: ORG, reviewerUserId: REV, now: NOW })).toBeNull();
    expect(
      validateReviewWorkspaceState({ ...snapshot(), query: 5 }, { organizationId: ORG, reviewerUserId: REV, now: NOW }),
    ).toBeNull();
  });
  it("rejects an employee object without a userId", () => {
    const bad = snapshot();
    (bad.query.employee as unknown) = { name: "x" };
    expect(validateReviewWorkspaceState(bad, { organizationId: ORG, reviewerUserId: REV, now: NOW })).toBeNull();
  });

  it("§16: an old v2 payload (pre-month-filter, no expenseMonth field) is rejected wholesale by the version bump, never crashes", () => {
    const v2Payload = { ...snapshot(), version: 2 };
    expect(
      validateReviewWorkspaceState(v2Payload, { organizationId: ORG, reviewerUserId: REV, now: NOW }),
    ).toBeNull();
  });

  it("§16: a same-version payload missing/corrupt expenseMonth falls back to 'all', not a crash", () => {
    const withoutMonth = snapshot();
    (withoutMonth.query as { expenseMonth?: unknown }).expenseMonth = undefined;
    const result = validateReviewWorkspaceState(withoutMonth, { organizationId: ORG, reviewerUserId: REV, now: NOW });
    expect(result?.query.expenseMonth).toBe("all");

    const corrupt = snapshot({ query: { ...snapshot().query, expenseMonth: "not-a-month" as never } });
    const result2 = validateReviewWorkspaceState(corrupt, { organizationId: ORG, reviewerUserId: REV, now: NOW });
    expect(result2?.query.expenseMonth).toBe("all");
  });
});

describe("return-intent one-shot (§22/§41)", () => {
  it("consume returns true once then false", () => {
    markReviewReturnPending();
    expect(consumeReviewReturnPending()).toBe(true);
    expect(consumeReviewReturnPending()).toBe(false);
  });
  it("false when never marked (a fresh sidebar visit)", () => {
    expect(consumeReviewReturnPending()).toBe(false);
  });
});

describe("clampRestoredPage (§16/§31)", () => {
  it("keeps a valid page", () => {
    expect(clampRestoredPage(4, 10)).toBe(4);
  });
  it("clamps a page past the new end", () => {
    expect(clampRestoredPage(4, 3)).toBe(3);
  });
  it("floors to 1 for degenerate input", () => {
    expect(clampRestoredPage(0, 5)).toBe(1);
    expect(clampRestoredPage(3, 0)).toBe(1);
  });
});
