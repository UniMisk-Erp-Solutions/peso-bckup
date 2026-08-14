/**
 * Structural tests: verify the sticky-right Actions column and single-scroll-owner
 * architecture in all review-expense table components.
 *
 * Phase 2/3 tests: CSS class presence (source-text).
 * Phase 4 tests: single scroll owner — noScrollWrapper on Table + data-testid attributes.
 *
 * Root cause that Phase 4 fixes: the shared Table component wraps <table> in
 * <div className="relative w-full overflow-auto">, creating a nested scroll container
 * that intercepts sticky positioning. noScrollWrapper bypasses that inner wrapper so
 * the outer overflow-x-auto div is the sole scroll container sticky cells anchor to.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();
const read = (p: string) => readFileSync(resolve(cwd, p), "utf-8");

// ---------------------------------------------------------------------------
// EngineerReview.tsx (Phase 2 + Phase 4)
// ---------------------------------------------------------------------------
describe("EngineerReview — sticky Actions column", () => {
  const src = read("src/pages/EngineerReview.tsx");

  it("scroll container has overflow-x-auto", () => {
    expect(src).toContain("overflow-x-auto");
  });

  it("actions TableHead has sticky right-0 z-30", () => {
    expect(src).toContain("sticky right-0 z-30");
  });

  it("actions TableCell has sticky right-0 z-20", () => {
    expect(src).toContain("sticky right-0 z-20");
  });

  // Phase 4: single scroll owner
  it("Table uses noScrollWrapper (prevents inner overflow-auto from stealing sticky anchor)", () => {
    expect(src).toContain("noScrollWrapper");
  });

  it("no inline-block middle wrapper (would create competing scroll layer)", () => {
    expect(src).not.toContain("inline-block min-w-full align-middle");
  });

  it("scroll container has data-testid for DOM verification", () => {
    expect(src).toContain('data-testid="engineer-review-scroll-container"');
  });

  it("actions header has data-testid", () => {
    expect(src).toContain('data-testid="engineer-review-actions-header"');
  });

  it("actions cell has data-testid", () => {
    expect(src).toContain('data-testid="engineer-review-actions-cell"');
  });
});

// ---------------------------------------------------------------------------
// BatchExpenseReviewPanel.tsx (Phase 2 + Phase 4)
// ---------------------------------------------------------------------------
describe("BatchExpenseReviewPanel — sticky Actions column", () => {
  const src = read("src/components/BatchExpenseReviewPanel.tsx");

  it("scroll container has overflow-x-auto", () => {
    expect(src).toContain("overflow-x-auto");
  });

  it("actions TableHead has sticky right-0 z-30", () => {
    expect(src).toContain("sticky right-0 z-30");
  });

  it("actions TableCell has sticky right-0 z-20", () => {
    expect(src).toContain("sticky right-0 z-20");
  });

  // Phase 4: single scroll owner
  it("Table uses noScrollWrapper", () => {
    expect(src).toContain("noScrollWrapper");
  });

  it("scroll container has data-testid for DOM verification", () => {
    expect(src).toContain('data-testid="batch-review-scroll-container"');
  });

  it("actions header has data-testid", () => {
    expect(src).toContain('data-testid="batch-review-actions-header"');
  });

  it("actions cell has data-testid", () => {
    expect(src).toContain('data-testid="batch-review-actions-cell"');
  });
});

// ---------------------------------------------------------------------------
// AdminPanel.tsx (/admin/expenses) — Phase 3 + Phase 4
// ---------------------------------------------------------------------------
describe("AdminPanel — sticky Actions column", () => {
  const src = read("src/pages/AdminPanel.tsx");

  it("scroll container has overflow-x-auto", () => {
    expect(src).toContain("overflow-x-auto");
  });

  it("actions TableHead has sticky right-0 z-30", () => {
    expect(src).toContain("sticky right-0 z-30");
  });

  it("actions TableHead has border-l and bg-background", () => {
    expect(src).toContain("border-l bg-background");
  });

  it("actions TableHead has left-side shadow", () => {
    expect(src).toContain("shadow-[-4px_0_8px_-6px_rgba(0,0,0,0.25)]");
  });

  it("TableRow has group class for hover propagation", () => {
    expect(src).toMatch(/TableRow[^>]*className="group"/);
  });

  it("actions TableCell has sticky right-0 z-20", () => {
    expect(src).toContain("sticky right-0 z-20");
  });

  it("actions TableCell has group-hover:bg-muted (solid — prevents transparent bleed-through on hover)", () => {
    expect(src).toContain("group-hover:bg-muted");
    expect(src).not.toContain("group-hover:bg-muted/50");
  });

  it("actions TableCell has border-l and bg-background", () => {
    const matches = src.match(/sticky right-0 z-20[^"]*border-l bg-background/);
    expect(matches).not.toBeNull();
  });

  // Phase 4: single scroll owner
  it("Table uses noScrollWrapper (prevents inner overflow-auto from stealing sticky anchor)", () => {
    expect(src).toContain("noScrollWrapper");
  });

  it("no inline-block middle wrapper (would create competing scroll layer)", () => {
    expect(src).not.toContain("inline-block min-w-full align-middle");
  });

  it("scroll container has data-testid for DOM verification", () => {
    expect(src).toContain('data-testid="admin-expenses-scroll-container"');
  });

  it("actions header has data-testid", () => {
    expect(src).toContain('data-testid="admin-expenses-actions-header"');
  });

  it("actions cell has data-testid", () => {
    expect(src).toContain('data-testid="admin-expenses-actions-cell"');
  });
});

// ---------------------------------------------------------------------------
// AccountantApprovedExpenses.tsx — Phase 3 + Phase 4
// ---------------------------------------------------------------------------
describe("AccountantApprovedExpenses — sticky Actions column", () => {
  const src = read("src/pages/AccountantApprovedExpenses.tsx");

  it("scroll container has overflow-x-auto", () => {
    expect(src).toContain("overflow-x-auto");
  });

  it("actions TableHead has sticky right-0 z-30", () => {
    expect(src).toContain("sticky right-0 z-30");
  });

  it("actions TableCell has sticky right-0 z-20", () => {
    expect(src).toContain("sticky right-0 z-20");
  });

  it("TableRow has group class for hover propagation", () => {
    expect(src).toMatch(/TableRow[^>]*className="group"/);
  });

  // Phase 4: single scroll owner
  it("Table uses noScrollWrapper", () => {
    expect(src).toContain("noScrollWrapper");
  });

  it("no inline-block middle wrapper (would create competing scroll layer)", () => {
    expect(src).not.toContain("inline-block min-w-full align-middle");
  });

  it("scroll container has data-testid for DOM verification", () => {
    expect(src).toContain('data-testid="accountant-approved-scroll-container"');
  });

  it("actions header has data-testid", () => {
    expect(src).toContain('data-testid="accountant-approved-actions-header"');
  });

  it("actions cell has data-testid", () => {
    expect(src).toContain('data-testid="accountant-approved-actions-cell"');
  });
});

// ---------------------------------------------------------------------------
// table.tsx — Phase 4: noScrollWrapper prop exists
// ---------------------------------------------------------------------------
describe("Table component — noScrollWrapper opt-in prop", () => {
  const src = read("src/components/ui/table.tsx");

  it("exports Table with noScrollWrapper prop support", () => {
    expect(src).toContain("noScrollWrapper");
  });

  it("default (noScrollWrapper absent) still wraps in overflow-auto div", () => {
    expect(src).toContain("overflow-auto");
  });

  it("noScrollWrapper bypasses the overflow-auto wrapper", () => {
    expect(src).toMatch(/noScrollWrapper.*overflow-auto|overflow-auto.*noScrollWrapper/s);
  });
});
