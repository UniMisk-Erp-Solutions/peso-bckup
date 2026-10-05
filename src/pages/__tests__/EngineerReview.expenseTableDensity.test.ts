/**
 * Expense table responsive-density hotfix -- structural contract for
 * EngineerReview.tsx's desktop review table (the canonical /review surface
 * for Engineer, Team Leader, and Executive reviewers -- ReviewExpenses.tsx
 * is a thin re-export of this same component, so there is no separate
 * per-role table to test).
 *
 * REFINEMENT PASS (2026-08-27): the owner's Preview review found the
 * Status/Actions column absorbing all leftover table width instead of the
 * text columns, plus its header/button visually misaligned. Root cause: it
 * was the only column with a min-width but no explicit width, so
 * table-layout:auto (the browser default here -- no table-layout:fixed
 * anywhere) handed it 100% of any space beyond the other columns' fixed
 * widths. Fix: Actions now gets an explicit width (w-[125px], bounded
 * min/max), and Employee/Title/Category/Destination lost their own fixed
 * widths (min-width only) so THEY absorb the leftover space instead. These
 * tests assert that semantic split directly, not just "some width exists".
 *
 * See AdminPanel.expenseTableDensity.test.ts for why this reads source
 * directly rather than rendering: EngineerReview.tsx has no existing
 * render-test harness and its data pipeline needs more Supabase
 * query-builder mocking than the shared test setup provides.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(process.cwd(), "src/pages/EngineerReview.tsx"),
  "utf-8",
).replace(/\r\n/g, "\n");

const tableBlockStart = source.indexOf('data-testid="engineer-review-scroll-container"');
const tableBlockEnd = source.indexOf("</Table>", tableBlockStart);
if (tableBlockStart === -1 || tableBlockEnd === -1) {
  throw new Error(
    "Could not locate the engineer-review-scroll-container table block -- " +
      "has EngineerReview.tsx's desktop table structure changed?",
  );
}
const tableBlock = source.slice(tableBlockStart, tableBlockEnd);

const STANDARD_COLUMN_LABELS = [
  "Txn #",
  "Employee / Employee ID",
  "Title",
  "Category",
  "Destination",
  "Amount",
  "Status",
];

/** Columns that must absorb leftover table width -- minWidth only, no width. */
const FLEXIBLE_COLUMNS = ["employee", "title", "category", "destination"];
/** Columns that must stay pinned to a fixed pixel size regardless of extra space. */
const FIXED_COLUMNS = ["txn", "amount", "balance", "status", "expense_date", "date_created"];

/** Extracts the <TableHead ...>...</TableHead> block for one resizable column,
 * identified by its resize key (the string passed to reviewStartResize). */
function headerBlockFor(col: string): string {
  const handleIdx = tableBlock.indexOf(`reviewStartResize("${col}", e)`);
  expect(handleIdx, `resize handle for "${col}" not found`).toBeGreaterThan(-1);
  const headStart = tableBlock.lastIndexOf("<TableHead", handleIdx);
  const headEnd = tableBlock.indexOf("</TableHead>", handleIdx);
  return tableBlock.slice(headStart, headEnd);
}

describe("EngineerReview desktop table -- responsive density contract", () => {
  it("keeps every standard column header present (shared by Engineer, Team Leader, and Executive)", () => {
    for (const label of STANDARD_COLUMN_LABELS) {
      expect(tableBlock).toContain(label);
    }
    expect(tableBlock).toContain("Status / Actions");
  });

  it("never applies a responsive hidden class to a standard column", () => {
    expect(tableBlock).not.toMatch(/hidden\s+sm:table-cell/);
    expect(tableBlock).not.toMatch(/hidden\s+md:table-cell/);
  });

  it("does not force the table wider than its container via min-w-max", () => {
    expect(tableBlock).not.toContain("min-w-max");
  });

  it("wraps the table in the shared expense-table-dense scoped density class", () => {
    const wrapperDivStart = source.lastIndexOf("<div", tableBlockStart);
    const wrapperTag = source.slice(wrapperDivStart, source.indexOf(">", tableBlockStart));
    expect(wrapperTag).toContain("expense-table-dense");
  });

  it("keeps an overflow-x-auto wrapper as the emergency fallback for pathological cases", () => {
    const wrapperDivStart = source.lastIndexOf("<div", tableBlockStart);
    const wrapperTag = source.slice(wrapperDivStart, source.indexOf(">", tableBlockStart));
    expect(wrapperTag).toContain("overflow-x-auto");
  });

  it("manual column resizing is still wired up on every resizable column", () => {
    const resizableColumns = [...FIXED_COLUMNS, ...FLEXIBLE_COLUMNS];
    expect(resizableColumns.length).toBe(10);
    for (const col of resizableColumns) {
      expect(tableBlock).toContain(`reviewStartResize("${col}", e)`);
      expect(tableBlock).toContain(`reviewColWidth("${col}")`);
    }
    // The handle itself must still render inside each resizable header.
    expect(tableBlock).toContain("resizeHandleClass");
  });

  it("marks Employee/Title/Category/Destination as flexible -- minWidth only, no fixed width", () => {
    for (const col of FLEXIBLE_COLUMNS) {
      const headerBlock = headerBlockFor(col);
      expect(headerBlock, `${col} header should not pin an explicit width`).not.toMatch(
        /style=\{\{[^}]*\bwidth:/,
      );
      expect(headerBlock, `${col} header must still set minWidth`).toMatch(
        /style=\{\{\s*minWidth:\s*reviewColWidth/,
      );
    }
  });

  it("keeps Txn/Amount/Balance/Status/dates pinned to a fixed width regardless of extra space", () => {
    for (const col of FIXED_COLUMNS) {
      const headerBlock = headerBlockFor(col);
      expect(headerBlock, `${col} header must pin an explicit width`).toMatch(
        /style=\{\{\s*width:\s*reviewColWidth\(/,
      );
    }
  });

  it("default column-width budget: fixed columns + compact Actions leave real room for flexible text columns", () => {
    const defaultsIdx = source.indexOf('useResizableColumns(\n    "pw_engineer_review_cols"');
    expect(defaultsIdx).toBeGreaterThan(-1);
    const defaultsBlock = source.slice(defaultsIdx, source.indexOf(");", defaultsIdx));
    const widthOf = (col: string) => {
      const m = defaultsBlock.match(new RegExp(`${col}:\\s*(\\d+),`));
      expect(m, `no default width found for "${col}"`).not.toBeNull();
      return Number(m![1]);
    };
    const fixedTotal = FIXED_COLUMNS.reduce((sum, col) => sum + widthOf(col), 0);
    const flexMinTotal = FLEXIBLE_COLUMNS.reduce((sum, col) => sum + widthOf(col), 0);
    const checkboxWidth = 40;
    const actionsWidth = 125;
    // This is the DEFAULT/no-extra-space floor -- it must clear a 1366px
    // laptop with the checkbox and compact Actions column included, same as
    // the first hotfix pass. It does not (and cannot) prove how flexible
    // columns actually grow in a live browser -- see the file header.
    expect(checkboxWidth + fixedTotal + flexMinTotal + actionsWidth).toBeLessThan(1280);
  });

  it("Actions column has an explicit compact width, never an unbounded sponge for leftover space", () => {
    const headerIdx = tableBlock.indexOf('data-testid="engineer-review-actions-header"');
    expect(headerIdx).toBeGreaterThan(-1);
    const headerTagEnd = tableBlock.indexOf(">", headerIdx);
    const headerTag = tableBlock.slice(headerIdx, headerTagEnd);
    expect(headerTag).toMatch(/\bw-\[\d+px\]/);
    expect(headerTag).toMatch(/\bmax-w-\[\d+px\]/);

    const cellIdx = tableBlock.indexOf('data-testid="engineer-review-actions-cell"');
    expect(cellIdx).toBeGreaterThan(-1);
    const cellTagEnd = tableBlock.indexOf(">", cellIdx);
    const cellTag = tableBlock.slice(cellIdx, cellTagEnd);
    expect(cellTag).toMatch(/\bw-\[\d+px\]/);
    expect(cellTag).toMatch(/\bmax-w-\[\d+px\]/);
  });

  it("Actions header and the action buttons share the same horizontal alignment", () => {
    const headerIdx = tableBlock.indexOf('data-testid="engineer-review-actions-header"');
    const headerTag = tableBlock.slice(headerIdx, tableBlock.indexOf(">", headerIdx));
    expect(headerTag).toContain("text-right");

    const cellIdx = tableBlock.indexOf('data-testid="engineer-review-actions-cell"');
    const cellBlockEnd = tableBlock.indexOf("</TableCell>", cellIdx);
    const cellBlock = tableBlock.slice(cellIdx, cellBlockEnd);
    // The actual fix: the flex container wrapping the action button(s) must
    // right-justify on desktop to match the header's text-right, not rely on
    // an inner single-child div's justify-end (which has no visible effect).
    expect(cellBlock).toMatch(/className="flex[^"]*sm:justify-end[^"]*"/);
  });

  it("Title truncates to a single line on desktop, never line-clamp-2", () => {
    expect(tableBlock).not.toContain("line-clamp-2");
    const titleCellIdx = tableBlock.search(/<TableCell className="font-medium min-w-0"/);
    expect(titleCellIdx).toBeGreaterThan(-1);
    const titleCellEnd = tableBlock.indexOf("</TableCell>", titleCellIdx);
    const titleCellBlock = tableBlock.slice(titleCellIdx, titleCellEnd);
    expect(titleCellBlock).toContain("truncate");
    expect(titleCellBlock).toContain("title={expense.title}");
  });

  it("Category and Destination never cap max-width -- they must be free to grow with their flexible column", () => {
    expect(tableBlock).not.toMatch(/capitalize truncate max-w-\[\d+px\]/);
    expect(tableBlock).not.toMatch(/(?<!capitalize )truncate max-w-\[\d+px\]"[^>]*title=\{expense\.destination\}/);
  });

  it("truncated long-text cells (Category, Destination) still carry a title attribute for the full value", () => {
    const categoryCellIdx = tableBlock.indexOf('className="capitalize truncate min-w-0"');
    expect(categoryCellIdx).toBeGreaterThan(-1);
    expect(tableBlock.slice(categoryCellIdx, categoryCellIdx + 120)).toContain("title={expense.category");
    const destinationCellIdx = tableBlock.indexOf('className="truncate min-w-0"');
    expect(destinationCellIdx).toBeGreaterThan(-1);
    expect(tableBlock.slice(destinationCellIdx, destinationCellIdx + 120)).toContain(
      "title={expense.destination}",
    );
  });

  it("preserves amount/balance financial formatting and color semantics", () => {
    expect(tableBlock).toContain("formatINR(expense.total_amount)");
    expect(tableBlock).toContain("formatINR(expense.user_balance)");
    expect(tableBlock).toContain("text-green-600");
    expect(tableBlock).toContain("text-red-600");
  });

  it("preserves the review action controls (batch and singular review buttons)", () => {
    expect(tableBlock).toContain("Review batch");
    expect(tableBlock).toContain("getExpenseReviewButtonLabel(expense)");
    expect(tableBlock).toContain('data-testid="engineer-review-actions-cell"');
  });

  it("never uses transform: scale() to fake density", () => {
    expect(source).not.toMatch(/transform:\s*scale\(/);
  });
});

describe("EngineerReview page layout -- full desktop width", () => {
  it("opts the /review route into full-width Layout instead of the centered max-w-7xl column", () => {
    const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf-8");
    const routeIdx = appSource.indexOf('path="/review"');
    expect(routeIdx).toBeGreaterThan(-1);
    const routeBlock = appSource.slice(routeIdx, routeIdx + 400);
    expect(routeBlock).toContain("<Layout fullWidth>");
  });

  it("EXPENSE_REVIEW_ROLES (Executive, Manager/Team Leader, Engineer) all render through this same table -- no per-role table exists", () => {
    const routeAccessSource = readFileSync(
      resolve(process.cwd(), "src/lib/routeAccess.ts"),
      "utf-8",
    );
    expect(routeAccessSource).toContain('"engineer"');
    expect(routeAccessSource).toContain('"team_leader"');
    expect(routeAccessSource).toContain('"executive"');

    const reviewExpensesSource = readFileSync(
      resolve(process.cwd(), "src/pages/ReviewExpenses.tsx"),
      "utf-8",
    );
    // ReviewExpenses.tsx must stay a thin re-export -- if it ever grows its
    // own table JSX, this density fix and its tests would silently stop
    // covering what actually renders at /review.
    expect(reviewExpensesSource).not.toMatch(/<Table\b/);
    expect(reviewExpensesSource).toContain("EngineerReview");
  });
});
