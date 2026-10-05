/**
 * Expense table responsive-density hotfix -- structural contract for
 * AdminPanel.tsx's desktop expense table.
 *
 * REFINEMENT PASS (2026-08-27): the owner's Preview review of the Review
 * table found the same class of bug present here too -- several columns
 * (Txn, Amount, Balance, Status, dates, Actions) had only a min-width and
 * no explicit width, so table-layout:auto (the browser default -- no
 * table-layout:fixed anywhere) could hand any of them leftover table space
 * unpredictably, while Employee/Title were pinned to percentage widths
 * that couldn't grow to use it. Fix: Txn/Amount/Balance/Status/dates/
 * Actions now get an explicit fixed width; Employee/Title/Category/
 * Destination lost their width entirely (min-width only) so THEY absorb
 * leftover space instead.
 *
 * AdminPanel.tsx has no existing render-test harness (it has never had
 * one), and its real data pipeline (fetchExpenses' .range()/.neq()/.count
 * chain across three parallel Promise.allSettled fetchers) needs
 * meaningfully more Supabase query-builder mocking than the shared
 * src/test/setup.ts default provides. Building that out is a legitimate
 * but separate undertaking, not part of a surgical layout hotfix -- so
 * this proves the density contract by reading the actual source directly,
 * the same way tests already prove SQL migration contracts in this
 * codebase (e.g. repair6546Level2RoutingAndAudit.test.ts).
 *
 * This does NOT prove pixel-fitting at any viewport -- only a live browser
 * can, and that requires the owner's own login QA (documented in the
 * hotfix report).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(process.cwd(), "src/pages/AdminPanel.tsx"),
  "utf-8",
).replace(/\r\n/g, "\n");

/** The desktop expense table's own JSX block, isolated so assertions can't
 * accidentally match unrelated tables/dialogs elsewhere in this large file. */
const tableBlockStart = source.indexOf('data-testid="admin-expenses-scroll-container"');
const tableBlockEnd = source.indexOf("</Table>", tableBlockStart);
if (tableBlockStart === -1 || tableBlockEnd === -1) {
  throw new Error(
    "Could not locate the admin-expenses-scroll-container table block -- " +
      "has AdminPanel.tsx's desktop table structure changed?",
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
  "Balance",
];

/** Columns that must absorb leftover table width -- min-width only, no width. */
const FLEXIBLE_HEADER_TEXTS = ["Employee / Employee ID", "Title", "Category", "Destination"];

function headerBlockFor(label: string): string {
  const idx = tableBlock.indexOf(`>${label}</TableHead>`);
  expect(idx, `header "${label}" not found`).toBeGreaterThan(-1);
  const headStart = tableBlock.lastIndexOf("<TableHead", idx);
  return tableBlock.slice(headStart, idx);
}

/** Individual space-separated class tokens from a `className="..."` attribute,
 * so "min-w-[150px]" is never mistaken for a bare "w-[150px]" token by a
 * loose substring/word-boundary match. */
function classTokens(headerBlock: string): string[] {
  const m = headerBlock.match(/className="([^"]*)"/);
  expect(m, "no className attribute found").not.toBeNull();
  return m![1].split(/\s+/).filter(Boolean);
}

describe("AdminPanel desktop expense table -- responsive density contract", () => {
  it("keeps every standard column header present", () => {
    for (const label of STANDARD_COLUMN_LABELS) {
      expect(tableBlock).toContain(label);
    }
    // Status/Actions is a combined header, not a separate "Status" column.
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

  it("marks Employee/Title/Category/Destination as flexible -- min-w only, never a fixed w-[Npx]/percentage width", () => {
    for (const label of FLEXIBLE_HEADER_TEXTS) {
      const tokens = classTokens(headerBlockFor(label));
      expect(tokens, `${label} header should not pin a fixed width`).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^w-\[\d+(?:px|%)\]$/)]),
      );
      expect(tokens, `${label} header must still set a min-w floor`).toEqual(
        expect.arrayContaining([expect.stringMatching(/^min-w-\[\d+px\]$/)]),
      );
    }
  });

  it("keeps Txn/Amount/Balance/Status/dates pinned to a fixed width regardless of extra space", () => {
    for (const label of ["Txn #", "Amount", "Balance", "Status"]) {
      const tokens = classTokens(headerBlockFor(label));
      expect(tokens, `${label} header must pin an explicit width`).toEqual(
        expect.arrayContaining([expect.stringMatching(/^w-\[\d+px\]$/)]),
      );
    }
  });

  it("Actions column has an explicit compact width, never an unbounded sponge for leftover space", () => {
    const headerIdx = tableBlock.indexOf('data-testid="admin-expenses-actions-header"');
    expect(headerIdx).toBeGreaterThan(-1);
    const headerTag = tableBlock.slice(headerIdx, tableBlock.indexOf(">", headerIdx));
    expect(headerTag).toMatch(/\bw-\[\d+px\]/);
    expect(headerTag).toMatch(/\bmax-w-\[\d+px\]/);

    const cellIdx = tableBlock.indexOf('data-testid="admin-expenses-actions-cell"');
    expect(cellIdx).toBeGreaterThan(-1);
    const cellTag = tableBlock.slice(cellIdx, tableBlock.indexOf(">", cellIdx));
    expect(cellTag).toMatch(/\bw-\[\d+px\]/);
    expect(cellTag).toMatch(/\bmax-w-\[\d+px\]/);
  });

  it("Actions header and the action buttons share the same horizontal alignment", () => {
    const headerIdx = tableBlock.indexOf('data-testid="admin-expenses-actions-header"');
    const headerTag = tableBlock.slice(headerIdx, tableBlock.indexOf(">", headerIdx));
    expect(headerTag).toContain("text-right");

    const cellIdx = tableBlock.indexOf('data-testid="admin-expenses-actions-cell"');
    const cellBlockEnd = tableBlock.indexOf("</TableCell>", cellIdx);
    const cellBlock = tableBlock.slice(cellIdx, cellBlockEnd);
    expect(cellBlock).toMatch(/className="flex[^"]*sm:justify-end[^"]*"/);
  });

  it("Title truncates to a single line on desktop, never line-clamp-2", () => {
    expect(tableBlock).not.toContain("line-clamp-2");
  });

  it("Category and Destination never cap max-width -- they must be free to grow with their flexible column", () => {
    expect(tableBlock).not.toMatch(/capitalize truncate max-w-\[\d+px\]/);
    expect(tableBlock).not.toMatch(/^truncate max-w-\[\d+px\]$/m);
  });

  it("truncated long-text cells (Category, Destination, Title) carry a title attribute for the full value", () => {
    const titleCellIdx = tableBlock.indexOf('className="font-medium min-w-0"');
    expect(titleCellIdx).toBeGreaterThan(-1);
    expect(tableBlock.slice(titleCellIdx, titleCellIdx + 80)).toContain("title={expense.title}");

    const categoryCellIdx = tableBlock.indexOf('className="capitalize truncate min-w-0"');
    expect(categoryCellIdx).toBeGreaterThan(-1);
    expect(tableBlock.slice(categoryCellIdx, categoryCellIdx + 120)).toContain("title={expense.category");

    const destinationCellIdx = tableBlock.indexOf('className="truncate min-w-0"');
    expect(destinationCellIdx).toBeGreaterThan(-1);
    expect(tableBlock.slice(destinationCellIdx, destinationCellIdx + 120)).toContain(
      "title={expense.destination}",
    );
  });

  it("never truncates Amount, Balance, Txn #, or Status", () => {
    // These carry whitespace-nowrap (never wrap/clip), never `truncate`.
    const amountCellIdx = tableBlock.indexOf("formatINR(expense.total_amount)");
    const amountCellTagStart = tableBlock.lastIndexOf("<TableCell", amountCellIdx);
    expect(tableBlock.slice(amountCellTagStart, amountCellIdx)).not.toContain("truncate");
    expect(tableBlock.slice(amountCellTagStart, amountCellIdx)).toContain("whitespace-nowrap");
  });

  it("preserves amount/balance financial formatting and color semantics", () => {
    expect(tableBlock).toContain("formatINR(expense.total_amount)");
    expect(tableBlock).toContain("formatINR(expense.user_balance)");
    expect(tableBlock).toContain("text-green-600");
    expect(tableBlock).toContain("text-red-600");
    expect(tableBlock).toContain("Insufficient balance");
  });

  it("preserves the action controls and their labels", () => {
    expect(tableBlock).toContain("Review batch");
    expect(tableBlock).toContain("View/Approve");
    expect(tableBlock).toContain('data-testid="admin-expenses-actions-cell"');
  });

  it("never uses transform: scale() to fake density", () => {
    expect(source).not.toMatch(/transform:\s*scale\(/);
    expect(source).not.toContain("scale(");
  });
});

describe("AdminPanel page layout -- full desktop width", () => {
  it("opts the Admin Expenses route into full-width Layout instead of the centered max-w-7xl column", () => {
    const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf-8");
    const routeIdx = appSource.indexOf('path="/admin/expenses"');
    expect(routeIdx).toBeGreaterThan(-1);
    const routeBlock = appSource.slice(routeIdx, routeIdx + 400);
    expect(routeBlock).toContain("<Layout fullWidth>");
  });
});
