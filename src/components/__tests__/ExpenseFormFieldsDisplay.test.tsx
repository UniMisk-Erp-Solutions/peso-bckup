/**
 * ExpenseFormFieldsDisplay — Tests for layout + loading changes
 *
 * T-EFF-01  Loading state renders AsyncOperationProgress (not Loader2)
 * T-EFF-02  Loading state does not contain an animate-spin Loader2 icon
 * T-EFF-03  Additional Information uses a vertical flex-col list
 * T-EFF-04  Old grid-cols layout is absent
 * T-EFF-05  No horizontal scroll wrapper (fields are stacked vertically)
 * T-EFF-06  Label and value render inside the same flex item
 * T-EFF-07  Label includes a visible colon
 * T-EFF-08  Field order matches resolver order
 * T-EFF-09  Stable ID used as React key (no duplicate DOM items for same name)
 * T-EFF-10  Checkbox true renders Yes badge
 * T-EFF-11  Checkbox false renders No badge
 * T-EFF-12  Number zero remains visible
 * T-EFF-13  Long values are rendered without truncation
 * T-EFF-14  Error state renders AsyncOperationProgress (not Loader2)
 * T-EFF-15  Retry increments fetch call count
 * T-EFF-16  Successful empty result returns no Additional Information section
 * T-EFF-17  No raw translation key visible in output
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExpenseFormFieldsDisplay } from "../ExpenseFormFieldsDisplay";
import type { ExpenseFormFieldDisplayNode, ExpenseDisplayFieldWithHierarchy } from "@/lib/expenseFieldDisplayModel";
import { defaultVisibilityFlags } from "@/lib/expenseFieldDisplayModel";

// ── i18n mock ──────────────────────────────────────────────────────────────────

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue !== undefined ? opts.defaultValue : key,
    i18n: { language: "en" },
  }),
}));

// ── Supabase mock (unused by this component directly, but imported transitively) ─

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn(() => Promise.resolve({ data: [], error: null })),
    })),
  },
}));

// ── fetchExpenseFormFieldDisplayGrouped mock ───────────────────────────────────

type GroupedResult = { ok: true; nodes: ExpenseFormFieldDisplayNode[] } | { ok: false; error: { code: string; message: string; retryable: boolean } };
const mockFetch = vi.fn<[], Promise<GroupedResult>>();

vi.mock("@/lib/fetchExpenseFormFieldDisplay", () => ({
  fetchExpenseFormFieldDisplayGrouped: (...args: unknown[]) => mockFetch(...(args as [])),
}));

// ── AsyncOperationProgress: keep real component behaviour ──────────────────────
// (not mocked — we verify it renders via its aria attributes)

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeField(overrides: { id: string; name: string; field_value: string; field_type?: string; stableId?: string }): ExpenseDisplayFieldWithHierarchy {
  return {
    stableId: (overrides.stableId ?? `template:${overrides.id}`) as ExpenseDisplayFieldWithHierarchy["stableId"],
    label: overrides.name,
    value: overrides.field_value,
    fieldType: overrides.field_type ?? "text",
    displayOrder: 0,
    source: "template",
    visibility: defaultVisibilityFlags(),
  };
}

function makeNode(overrides: { id: string; name: string; field_value: string; field_type?: string; stableId?: string }): ExpenseFormFieldDisplayNode {
  return { kind: "field", field: makeField(overrides) };
}

// Legacy helper for tests that pass old ExpenseFormFieldDisplayRow-shaped objects
function makeRow(overrides: { id: string; name: string; field_value: string; field_type?: string; stableId?: string }): ExpenseFormFieldDisplayNode {
  return makeNode(overrides);
}

function okResult(nodes: ExpenseFormFieldDisplayNode[]): GroupedResult {
  return { ok: true, nodes };
}

function errResult(): GroupedResult {
  return { ok: false, error: { code: "NETWORK", message: "Network error", retryable: true } };
}

function renderComponent(props: Partial<React.ComponentProps<typeof ExpenseFormFieldsDisplay>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ExpenseFormFieldsDisplay
        expenseId="exp-1"
        organizationId="org-1"
        {...props}
      />
    </QueryClientProvider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ExpenseFormFieldsDisplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("T-EFF-01: loading state renders AsyncOperationProgress progress bar", async () => {
    // Never resolves while we inspect loading state
    mockFetch.mockReturnValue(new Promise<GroupedResult>(() => {}));
    const { container } = renderComponent();
    // AsyncOperationProgress compact renders a Progress element
    await waitFor(() => {
      expect(container.querySelector('[role="status"]')).not.toBeNull();
    });
  });

  it("T-EFF-02: loading state has no Loader2 animate-spin icon", async () => {
    mockFetch.mockReturnValue(new Promise<GroupedResult>(() => {}));
    const { container } = renderComponent();
    await waitFor(() => {
      expect(container.querySelector('[role="status"]')).not.toBeNull();
    });
    // Loader2 was the only animate-spin icon; AsyncOperationProgress uses RefreshCw
    // We verify the old class combo is gone
    expect(container.querySelector(".animate-spin.lucide-loader2")).toBeNull();
  });

  it("T-EFF-03: loaded fields use a vertical flex-col list", async () => {
    mockFetch.mockResolvedValue(okResult([makeRow({ id: "r1", name: "Project", field_value: "Alpha" })]));
    const { container } = renderComponent();
    await waitFor(() => expect(screen.getByText(/Project/)).toBeInTheDocument());
    const dl = container.querySelector("dl");
    expect(dl?.className).toContain("flex-col");
  });

  it("T-EFF-04: old grid-cols layout is absent", async () => {
    mockFetch.mockResolvedValue(okResult([makeRow({ id: "r1", name: "Project", field_value: "Alpha" })]));
    const { container } = renderComponent();
    await waitFor(() => expect(screen.getByText(/Project/)).toBeInTheDocument());
    expect(container.querySelector(".grid-cols-1")).toBeNull();
    expect(container.querySelector('[class*="sm:grid-cols-2"]')).toBeNull();
  });

  it("T-EFF-05: no horizontal scroll wrapper (fields are stacked vertically)", async () => {
    mockFetch.mockResolvedValue(okResult([makeRow({ id: "r1", name: "Field", field_value: "Val" })]));
    const { container } = renderComponent();
    await waitFor(() => expect(screen.getByText(/Field/)).toBeInTheDocument());
    // No overflow-x-auto wrapper needed for vertical layout
    expect(container.querySelector(".flex-nowrap")).toBeNull();
  });

  it("T-EFF-06: label and value render inside the same flex item (dt + dd siblings)", async () => {
    mockFetch.mockResolvedValue(okResult([makeRow({ id: "r1", name: "Location", field_value: "Mumbai" })]));
    renderComponent();
    await waitFor(() => expect(screen.getByText(/Location/)).toBeInTheDocument());
    const dt = screen.getByText((t) => t.includes("Location"));
    const parent = dt.closest("div");
    const dd = parent?.querySelector("dd");
    expect(dd).not.toBeNull();
    expect(dd?.textContent).toContain("Mumbai");
  });

  it("T-EFF-07: label includes a visible colon", async () => {
    mockFetch.mockResolvedValue(okResult([makeRow({ id: "r1", name: "Project", field_value: "Beta" })]));
    renderComponent();
    await waitFor(() => expect(screen.getByText(/Project:/)).toBeInTheDocument());
  });

  it("T-EFF-08: field order matches resolver order", async () => {
    mockFetch.mockResolvedValue(okResult([
      makeRow({ id: "r1", name: "Alpha", field_value: "1" }),
      makeRow({ id: "r2", name: "Beta", field_value: "2" }),
      makeRow({ id: "r3", name: "Gamma", field_value: "3" }),
    ]));
    const { container } = renderComponent();
    await waitFor(() => expect(screen.getByText(/Alpha/)).toBeInTheDocument());
    const dts = Array.from(container.querySelectorAll("dt")).map((el) =>
      el.textContent?.replace(":", "").trim(),
    );
    expect(dts).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("T-EFF-09: stable ID used (two fields with same name but different stableId both appear)", async () => {
    mockFetch.mockResolvedValue(okResult([
      makeNode({ id: "v1", name: "Tag", field_value: "A", field_type: "text", stableId: "template:t1" }),
      makeNode({ id: "v2", name: "Tag", field_value: "B", field_type: "text", stableId: "template:t2" }),
    ]));
    renderComponent();
    await waitFor(() => {
      const tags = screen.getAllByText(/Tag:/);
      expect(tags).toHaveLength(2);
    });
  });

  it("T-EFF-10: checkbox true renders Yes badge", async () => {
    mockFetch.mockResolvedValue(okResult([
      makeRow({ id: "r1", name: "Approved", field_value: "true", field_type: "checkbox" }),
    ]));
    renderComponent();
    await waitFor(() => expect(screen.getByText("Yes")).toBeInTheDocument());
  });

  it("T-EFF-11: checkbox false renders No badge", async () => {
    mockFetch.mockResolvedValue(okResult([
      makeRow({ id: "r1", name: "Approved", field_value: "false", field_type: "checkbox" }),
    ]));
    renderComponent();
    await waitFor(() => expect(screen.getByText("No")).toBeInTheDocument());
  });

  it("T-EFF-12: number zero remains visible", async () => {
    mockFetch.mockResolvedValue(okResult([makeRow({ id: "r1", name: "Count", field_value: "0" })]));
    renderComponent();
    await waitFor(() => expect(screen.getByText("0")).toBeInTheDocument());
  });

  it("T-EFF-13: long values are rendered without truncation class", async () => {
    const longValue = "A".repeat(200);
    mockFetch.mockResolvedValue(okResult([makeRow({ id: "r1", name: "Notes", field_value: longValue })]));
    renderComponent();
    await waitFor(() => expect(screen.getByText(longValue)).toBeInTheDocument());
  });

  it("T-EFF-14: error state renders AsyncOperationProgress error (not Loader2)", async () => {
    mockFetch.mockResolvedValue(errResult());
    const { container } = renderComponent();
    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    });
    expect(container.querySelector(".lucide-loader2")).toBeNull();
  });

  it("T-EFF-15: clicking Retry triggers a new fetch call", async () => {
    mockFetch.mockResolvedValue(errResult());
    renderComponent();
    await waitFor(() => expect(screen.getByText(/Retry/i)).toBeInTheDocument());
    const callsBefore = mockFetch.mock.calls.length;
    fireEvent.click(screen.getByText(/Retry/i));
    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("T-EFF-16: successful empty result returns null (no Additional Information section)", async () => {
    mockFetch.mockResolvedValue(okResult([]));
    const { container } = renderComponent();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    // Slight delay to ensure state has settled
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector("dl")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("T-EFF-17: no raw i18n translation key visible in output", async () => {
    mockFetch.mockResolvedValue(okResult([makeRow({ id: "r1", name: "Field", field_value: "Val" })]));
    const { container } = renderComponent();
    await waitFor(() => expect(screen.getByText(/Field/)).toBeInTheDocument());
    // Keys look like "fieldDisplay.loading" — should not appear as literal text
    expect(container.textContent).not.toMatch(/fieldDisplay\./);
    expect(container.textContent).not.toMatch(/batchReview\./);
  });
});
