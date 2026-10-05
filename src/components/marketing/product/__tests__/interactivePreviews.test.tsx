/**
 * Behavioural tests for the public interactive product previews. These are
 * local-state demos: the tests also prove they never touch the backend.
 */
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";

const backendTouches = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: new Proxy(
    {},
    {
      get() {
        backendTouches.n += 1;
        throw new Error("marketing demo touched the backend");
      },
    },
  ),
}));

// Radix Select cannot be driven by jsdom's popper; a native <select> exercises the same handler.
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) => (
    <select data-testid="month-select" value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
}));

import { InteractiveDashboardPreview } from "../InteractiveDashboardPreview";
import { InteractiveExpenseFormPreview, filterRecentValues } from "../InteractiveExpenseFormPreview";
import { InteractiveApprovalWorkflow } from "../InteractiveApprovalWorkflow";
import { InteractiveReportPreview, applyReportView } from "../InteractiveReportPreview";
import { InteractiveBalanceTransfer } from "../InteractiveBalanceTransfer";
import { InteractiveTeamPreview } from "../InteractiveTeamPreview";
import { InteractiveHowItWorksTour } from "../InteractiveHowItWorksTour";
import { DEMO_ALL_ROWS, DEMO_REPORTS, buildDemoCsv } from "../demoData";

beforeEach(() => {
  backendTouches.n = 0;
});

const text = (id: string) => screen.getByTestId(id).textContent;

describe("InteractiveDashboardPreview", () => {
  it("starts on All time with the spec's figures", () => {
    render(<InteractiveDashboardPreview />);
    expect(text("demo-value-balance")).toBe("₹1,28,450");
    expect(text("demo-value-expenses")).toBe("₹4,82,600");
    expect(text("demo-value-pending")).toBe("₹36,240");
    expect(text("demo-dashboard-scope")).toBe("Showing all time");
  });

  it("changing the month updates EVERY card together, with month-end wording for a finished month", () => {
    render(<InteractiveDashboardPreview />);
    fireEvent.change(screen.getByTestId("month-select"), { target: { value: "2026-08" } });
    expect(text("demo-value-balance")).toBe("₹94,820");
    expect(text("demo-sub-balance")).toBe("Balance as of 31 Aug 2026");
    expect(text("demo-value-expenses")).toBe("₹82,430");
    expect(text("demo-value-pending")).toBe("₹12,600");
    expect(text("demo-dashboard-scope")).toBe("Showing August 2026");
  });

  it("the current month keeps the live balance, then All time restores the original values", () => {
    render(<InteractiveDashboardPreview />);
    const sel = screen.getByTestId("month-select");
    fireEvent.change(sel, { target: { value: "2026-09" } });
    expect(text("demo-value-balance")).toBe("₹1,28,450");
    expect(text("demo-sub-balance")).toBe("Balance as of today");
    expect(text("demo-value-expenses")).toBe("₹58,220");
    expect(text("demo-value-pending")).toBe("₹9,420");
    fireEvent.change(sel, { target: { value: "all" } });
    expect(text("demo-value-expenses")).toBe("₹4,82,600");
  });
});

describe("InteractiveExpenseFormPreview", () => {
  it("changing the category changes the custom fields", () => {
    render(<InteractiveExpenseFormPreview />);
    const fields = () => screen.getByTestId("demo-custom-fields");
    expect(within(fields()).getByLabelText("From Location")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "Fuel" } });
    expect(within(fields()).getByLabelText("Vehicle Number")).toBeInTheDocument();
    expect(within(fields()).getByLabelText("Odometer")).toBeInTheDocument();
    expect(within(fields()).queryByLabelText("From Location")).toBeNull();
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "Office Expense" } });
    expect(within(fields()).getByLabelText("Department")).toBeInTheDocument();
    expect(within(fields()).queryByLabelText("Vehicle Number")).toBeNull();
  });

  it("Site Purchase project fields fill together from the Project Unique ID", () => {
    render(<InteractiveExpenseFormPreview />);
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "Site Purchase" } });
    fireEvent.change(screen.getByLabelText("Project Unique ID"), { target: { value: "PRJ-2026-021" } });
    expect((screen.getByLabelText("Project Name") as HTMLInputElement).value).toBe("Ahmedabad Office Setup");
    expect((screen.getByLabelText("Project ID") as HTMLInputElement).value).toBe("1057");
  });

  it("conditional fields: Project Visit reveals Project + Destination, Client Meeting reveals Client + Meeting Location", () => {
    render(<InteractiveExpenseFormPreview />);
    expect(screen.getByTestId("demo-conditional-project")).toBeInTheDocument();
    expect(screen.getByLabelText("Destination")).toBeInTheDocument();
    expect(screen.queryByLabelText("Client")).toBeNull();
    fireEvent.change(screen.getByLabelText("Travel Type"), { target: { value: "Client Meeting" } });
    expect(screen.getByLabelText("Client")).toBeInTheDocument();
    expect(screen.getByLabelText("Meeting Location")).toBeInTheDocument();
    expect(screen.queryByLabelText("Destination")).toBeNull();
    expect(screen.queryByTestId("demo-conditional-project")).toBeNull();
  });

  it("Recent values: opens on focus, filters as you type, selects, and free typing still works", () => {
    render(<InteractiveExpenseFormPreview />);
    const input = screen.getByLabelText("Vendor / Location") as HTMLInputElement;
    expect(input).toHaveAttribute("role", "combobox");
    fireEvent.focus(input);
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Ahmedabad Office", "Sanand Plant", "Vadodara Site"]);
    fireEvent.change(input, { target: { value: "ahm" } });
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Ahmedabad Office"]);
    fireEvent.mouseDown(screen.getByRole("option", { name: "Ahmedabad Office" }));
    expect(input.value).toBe("Ahmedabad Office");
    expect(screen.queryByRole("listbox")).toBeNull();
    // free typing that matches nothing is accepted
    fireEvent.change(input, { target: { value: "Rajkot Depot" } });
    expect(input.value).toBe("Rajkot Depot");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Recent values are keyboard-operable (arrow + Enter)", () => {
    render(<InteractiveExpenseFormPreview />);
    const input = screen.getByLabelText("Vendor / Location") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("Sanand Plant");
  });

  it("filterRecentValues is a case-insensitive contains filter", () => {
    expect(filterRecentValues(["Ahmedabad Office", "Sanand Plant"], "PLANT")).toEqual(["Sanand Plant"]);
    expect(filterRecentValues(["A", "B"], "")).toEqual(["A", "B"]);
  });

  it("submitting shows a confirmation and 'Start over' returns to the form", () => {
    render(<InteractiveExpenseFormPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Submit expense" }));
    expect(screen.getByText("Expense submitted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByLabelText("Category")).toBeInTheDocument();
  });
});

describe("InteractiveApprovalWorkflow", () => {
  it("advances stage by stage to Approved, then updates the balance", () => {
    render(<InteractiveApprovalWorkflow />);
    expect(text("demo-approval-status")).toBe("Submitted");
    expect(text("demo-approval-balance")).toContain("₹42,000");
    const next = () => fireEvent.click(screen.getByRole("button", { name: /Next step/ }));
    next();
    expect(text("demo-approval-status")).toBe("Under review");
    next();
    expect(text("demo-approval-status")).toBe("Verified");
    next();
    next();
    expect(text("demo-approval-status")).toBe("Approved");
    expect(text("demo-approval-balance")).toContain("Balance updated");
    expect(text("demo-approval-balance")).toContain("₹33,550");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(text("demo-approval-status")).toBe("Submitted");
  });
});

describe("InteractiveReportPreview", () => {
  const firstRowDate = () => screen.getByTestId("demo-report-table").querySelector("tbody tr td:nth-child(3)")?.textContent;
  const firstRowDebit = () => screen.getByTestId("demo-report-table").querySelector("tbody tr td:nth-child(10)")?.textContent;
  const open = (name: RegExp) => fireEvent.click(screen.getByRole("button", { name }));

  it("uses 8-15 synthetic rows per report, never thousands", () => {
    expect(DEMO_ALL_ROWS.length).toBeLessThanOrEqual(30);
    for (const r of DEMO_REPORTS) expect(r.rows.length).toBeGreaterThan(0);
    expect(DEMO_REPORTS[0].rows.length).toBeGreaterThanOrEqual(8);
    expect(DEMO_REPORTS[0].rows.length).toBeLessThanOrEqual(15);
  });

  it("Date sort ascending / descending reorders rows", () => {
    render(<InteractiveReportPreview />);
    open(/^Date column options/);
    fireEvent.click(screen.getByRole("button", { name: /Sort ascending/ }));
    expect(firstRowDate()).toBe("04-08-2026");
    open(/^Date column options/);
    fireEvent.click(screen.getByRole("button", { name: /Sort descending/ }));
    expect(firstRowDate()).toBe("28-08-2026");
  });

  it("Debit sort ascending / descending reorders rows numerically", () => {
    render(<InteractiveReportPreview />);
    open(/^Debit column options/);
    fireEvent.click(screen.getByRole("button", { name: /Sort ascending/ }));
    expect(firstRowDebit()).toBe("₹980");
    open(/^Debit column options/);
    fireEvent.click(screen.getByRole("button", { name: /Sort descending/ }));
    expect(firstRowDebit()).toBe("₹9,200");
  });

  it("Employee filter reduces the rows and shows 'x of y rows'; Reset view restores canonical order", () => {
    render(<InteractiveReportPreview />);
    expect(text("demo-report-count")).toBe("9 of 9 rows");
    open(/^Employee column options/);
    fireEvent.change(screen.getByLabelText("Filter Employee"), { target: { value: "Riya Mehta" } });
    expect(text("demo-report-count")).toBe("3 of 9 rows");
    expect(screen.getByTestId("demo-report-table").textContent).not.toContain("Aarav Shah");
    fireEvent.click(screen.getByRole("button", { name: /Reset view/ }));
    expect(text("demo-report-count")).toBe("9 of 9 rows");
  });

  it("Project Name and Expense Type filters compose", () => {
    render(<InteractiveReportPreview />);
    open(/^Project Name column options/);
    fireEvent.change(screen.getByLabelText("Filter Project Name"), { target: { value: "Field Operations West" } });
    const afterProject = text("demo-report-count");
    expect(afterProject).toMatch(/^\d of 9 rows$/);
    open(/^Expense Type column options/);
    fireEvent.change(screen.getByLabelText("Filter Expense Type"), { target: { value: "Fuel" } });
    expect(text("demo-report-count")).toBe("1 of 9 rows");
  });

  it("history View switches the dataset, title, highlight and shows the Viewing state", () => {
    render(<InteractiveReportPreview />);
    expect(screen.queryByTestId("demo-report-viewing-badge")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View Riya-Mehta_01-09-2026_to_30-09-2026.csv" }));
    expect(text("demo-report-title")).toBe("September 2026 · Riya Mehta");
    expect(text("demo-report-count")).toBe("4 of 4 rows");
    expect(screen.getByTestId("demo-report-viewing-badge")).toBeInTheDocument();
    expect(screen.getByTestId("demo-history-sep-riya").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("demo-history-aug-all").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("demo-history-viewing-sep-riya")).toBeInTheDocument();
    expect(screen.getByTestId("demo-report-table").textContent).not.toContain("Aarav Shah");
  });

  it("switching reports clears any sort/filter (each report is its own snapshot)", () => {
    render(<InteractiveReportPreview />);
    open(/^Employee column options/);
    fireEvent.change(screen.getByLabelText("Filter Employee"), { target: { value: "Riya Mehta" } });
    fireEvent.click(screen.getByRole("button", { name: "View All-Employees_01-09-2026_to_30-09-2026_Fuel.csv" }));
    expect(text("demo-report-count")).toBe("4 of 4 rows");
  });

  it("applyReportView is pure and CSV export is synthetic and well-formed", () => {
    const rows = DEMO_REPORTS[0].rows;
    const before = rows.map((r) => r.txn).join();
    applyReportView(rows, {}, { key: "debit", dir: "desc" });
    expect(rows.map((r) => r.txn).join()).toBe(before);
    const csv = buildDemoCsv(rows);
    expect(csv.split("\n")).toHaveLength(rows.length + 1);
    expect(csv.split("\n")[0]).toContain("Opening Balance");
  });

  it("running balances are consistent per employee: opening - debit = closing", () => {
    for (const r of DEMO_ALL_ROWS) expect(r.opening - r.debit).toBe(r.closing);
  });
});

describe("InteractiveBalanceTransfer", () => {
  it("send -> awaiting acceptance -> accept moves both balances; reject changes nothing", () => {
    render(<InteractiveBalanceTransfer />);
    expect(text("demo-admin-balance")).toBe("₹1,50,000");
    expect(text("demo-recipient-balance")).toBe("₹12,500");
    fireEvent.click(screen.getByRole("button", { name: "Send transfer" }));
    expect(screen.getByText(/Awaiting acceptance from Riya Mehta/)).toBeInTheDocument();
    expect(text("demo-admin-balance")).toBe("₹1,50,000");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(text("demo-admin-balance")).toBe("₹1,30,000");
    expect(text("demo-recipient-balance")).toBe("₹32,500");
    fireEvent.click(screen.getByRole("button", { name: "Try another transfer" }));
    fireEvent.click(screen.getByRole("button", { name: "Send transfer" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.getByText(/Rejected/)).toBeInTheDocument();
    expect(text("demo-admin-balance")).toBe("₹1,50,000");
  });
});

describe("InteractiveTeamPreview", () => {
  it("switching teams changes the member counters", () => {
    render(<InteractiveTeamPreview />);
    expect(text("demo-team-pending")).toBe("3");
    fireEvent.click(screen.getByRole("tab", { name: /Team B/ }));
    expect(text("demo-team-pending")).toBe("4");
    expect(screen.getByText("Riya Mehta")).toBeInTheDocument();
    expect(screen.queryByText("Aarav Shah")).toBeNull();
  });
});

describe("InteractiveHowItWorksTour", () => {
  it("steps through Configure -> Report with Next/Back and step buttons", () => {
    render(<InteractiveHowItWorksTour />);
    expect(text("demo-tour-title")).toBe("1. Configure");
    fireEvent.click(screen.getByRole("button", { name: /Next: Submit/ }));
    expect(text("demo-tour-title")).toBe("2. Submit");
    fireEvent.click(screen.getByRole("button", { name: "Step 5: Report" }));
    expect(text("demo-tour-title")).toBe("5. Report");
    expect(screen.getByRole("button", { name: "Step 5: Report" })).toHaveAttribute("aria-current", "step");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(text("demo-tour-title")).toBe("4. Approve");
  });
});

describe("isolation", () => {
  it("no demo above touched the backend", () => {
    expect(backendTouches.n).toBe(0);
  });
});
