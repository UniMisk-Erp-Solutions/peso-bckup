/**
 * Real-render coverage for the Month control on My Expenses mobile
 * (§43) -- MobileExpenseListFilters/MobileExpenseListView are plain,
 * presentational components with no data-fetching of their own, so unlike
 * Expenses.tsx itself they CAN be mounted directly with React Testing
 * Library (same reasoning as MobileReviewQueueView's real-render tests).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MobileExpenseListFilters } from "../MobileExpenseListFilters";
import { MobileExpenseListView } from "../MobileExpenseListView";
import type { MobileExpenseItem } from "../MobileExpenseCard";

const noop = () => {};

const MONTH_OPTIONS = [
  { value: "all" as const, label: "All months" },
  { value: "2026-08" as const, label: "August 2026" },
];

describe("MobileExpenseListFilters -- Month control", () => {
  it("renders the Month selector defaulting to 'All months'", () => {
    render(
      <MobileExpenseListFilters
        searchTerm=""
        onSearchChange={noop}
        statusFilter="all"
        onStatusFilterChange={noop}
      />,
    );
    expect(screen.getByLabelText("Month")).toBeInTheDocument();
    expect(screen.getByText("All months")).toBeInTheDocument();
  });

  it("selecting a month calls onExpenseMonthChange with the machine value", () => {
    const onExpenseMonthChange = vi.fn();
    render(
      <MobileExpenseListFilters
        searchTerm=""
        onSearchChange={noop}
        statusFilter="all"
        onStatusFilterChange={noop}
        expenseMonth="all"
        monthOptions={MONTH_OPTIONS}
        onExpenseMonthChange={onExpenseMonthChange}
      />,
    );
    fireEvent.click(screen.getByLabelText("Month"));
    fireEvent.click(screen.getByText("August 2026"));
    expect(onExpenseMonthChange).toHaveBeenCalledWith("2026-08");
  });
});

describe("MobileExpenseListView -- exact-month mode rendering", () => {
  const EXPENSES: MobileExpenseItem[] = [
    { id: "e1", title: "Fuel", destination: "Site A", trip_start: "2026-08-10", trip_end: "2026-08-10", status: "approved", total_amount: 500, created_at: "2026-08-10T00:00:00Z" } as MobileExpenseItem,
  ];

  it("shows the month-specific empty state, not the generic one, when a month has zero results", () => {
    render(
      <MemoryRouter>
        <MobileExpenseListView
          filteredExpenses={[]}
          loading={false}
          enrichingExpenses={false}
          searchTerm=""
          onSearchChange={noop}
          statusFilter="all"
          onStatusFilterChange={noop}
          totalExpenseCount={0}
          allExpensesLoaded={true}
          onLoadAll={noop}
          loadingAllExpenses={false}
          expenseMonth="2026-08"
          monthOptions={MONTH_OPTIONS}
          onExpenseMonthChange={noop}
          monthModeTotal={0}
          monthModePage={1}
          monthModeTotalPages={0}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("No expenses found for August 2026.")).toBeInTheDocument();
    expect(screen.queryByText("No expenses yet")).not.toBeInTheDocument();
  });

  it("shows a truthful error state with Retry instead of crashing on a fetch failure", () => {
    const onMonthPageChange = vi.fn();
    render(
      <MemoryRouter>
        <MobileExpenseListView
          filteredExpenses={[]}
          loading={false}
          enrichingExpenses={false}
          searchTerm=""
          onSearchChange={noop}
          statusFilter="all"
          onStatusFilterChange={noop}
          totalExpenseCount={0}
          allExpensesLoaded={true}
          onLoadAll={noop}
          loadingAllExpenses={false}
          expenseMonth="2026-08"
          monthOptions={MONTH_OPTIONS}
          onExpenseMonthChange={noop}
          monthModeTotal={0}
          monthModePage={1}
          monthModeTotalPages={0}
          monthModeError="Failed to load expenses for this month."
          onMonthPageChange={onMonthPageChange}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Failed to load expenses for this month.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onMonthPageChange).toHaveBeenCalledWith(1);
  });

  it("shows Previous/Page X of Y/Next pagination in month mode, and never the Load-all CTA", () => {
    const onMonthPageChange = vi.fn();
    render(
      <MemoryRouter>
        <MobileExpenseListView
          filteredExpenses={EXPENSES}
          loading={false}
          enrichingExpenses={false}
          searchTerm=""
          onSearchChange={noop}
          statusFilter="all"
          onStatusFilterChange={noop}
          totalExpenseCount={83}
          allExpensesLoaded={false}
          onLoadAll={noop}
          loadingAllExpenses={false}
          expenseMonth="2026-08"
          monthOptions={MONTH_OPTIONS}
          onExpenseMonthChange={noop}
          monthModeTotal={83}
          monthModePage={2}
          monthModeTotalPages={4}
          onMonthPageChange={onMonthPageChange}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("83 expenses in August 2026")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 4")).toBeInTheDocument();
    expect(screen.queryByText(/Load all/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onMonthPageChange).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(onMonthPageChange).toHaveBeenCalledWith(1);
  });

  it("All-months mode (default) is completely unaffected -- Load-all CTA still works as before", () => {
    render(
      <MemoryRouter>
        <MobileExpenseListView
          filteredExpenses={EXPENSES}
          loading={false}
          enrichingExpenses={false}
          searchTerm=""
          onSearchChange={noop}
          statusFilter="all"
          onStatusFilterChange={noop}
          totalExpenseCount={500}
          allExpensesLoaded={false}
          onLoadAll={noop}
          loadingAllExpenses={false}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Load all 500 expenses")).toBeInTheDocument();
    expect(screen.queryByText(/Page \d+ of \d+/)).not.toBeInTheDocument();
  });
});
