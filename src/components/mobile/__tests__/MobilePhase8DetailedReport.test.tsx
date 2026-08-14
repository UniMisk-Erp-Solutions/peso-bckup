/**
 * Phase 8 — Detailed Expense Report mobile view
 *
 * T1 — all-employees mode: detailed-card-list rendered with expense cards
 * T2 — all-employees mode: employee name and title visible in card
 * T3 — all-employees mode: empty state message when no rows
 * T4 — single-employee mode: opening-balance-banner rendered
 * T5 — single-employee mode: detailed-balance-card items rendered
 * T6 — single-employee mode: empty state when no balance rows
 * T7 — loading state: shows loading message, not card list
 * T8 — mobile output: no overflow-x-auto (not a horizontal-scroll table)
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import React from "react";
import { MobileDetailedExpenseReportView } from "@/components/mobile/MobileDetailedExpenseReportView";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ALL_EMP_ROW = {
  id: "exp1",
  user_name: "Alice Smith",
  trip_start: "2026-06-01T00:00:00Z",
  title: "Flight to Mumbai",
  category: "Travel",
  total_amount: 12000,
};

const BALANCE_ROW = {
  id: "alloc-1",
  date: "2026-06-01T00:00:00Z",
  type: "allocation" as const,
  credit: 5000,
  debit: 0,
  notes: "Account credited by Admin",
  category: "Account Credited",
  title: "",
  closingBalance: 5000,
};

const ZERO_BALANCE = { opening: 0 };
const BALANCE_INFO = { opening: 3000 };

// ═════════════════════════════════════════════════════════════════════════════
// T1–T3  All-employees mode
// ═════════════════════════════════════════════════════════════════════════════

describe("T1 — all-employees: detailed-card-list rendered with expense cards", () => {
  it("renders detailed-card-list and detailed-expense-card", () => {
    render(
      <MobileDetailedExpenseReportView
        showDetailedBalanceColumns={false}
        loading={false}
        detailedCustomFilterHasNoData={false}
        balanceInfo={ZERO_BALANCE}
        detailedListWithBalances={[]}
        detailedAllEmployeesRows={[ALL_EMP_ROW]}
      />,
    );
    expect(screen.getByTestId("detailed-card-list")).toBeInTheDocument();
    expect(screen.getByTestId("detailed-expense-card")).toBeInTheDocument();
  });
});

describe("T2 — all-employees: employee name and title visible in card", () => {
  it("shows user_name and title fields", () => {
    render(
      <MobileDetailedExpenseReportView
        showDetailedBalanceColumns={false}
        loading={false}
        detailedCustomFilterHasNoData={false}
        balanceInfo={ZERO_BALANCE}
        detailedListWithBalances={[]}
        detailedAllEmployeesRows={[ALL_EMP_ROW]}
      />,
    );
    expect(screen.getByText("Alice Smith")).toBeInTheDocument();
    expect(screen.getByText("Flight to Mumbai")).toBeInTheDocument();
  });
});

describe("T3 — all-employees: empty state message when no rows", () => {
  it("shows filter hint when detailedAllEmployeesRows is empty", () => {
    render(
      <MobileDetailedExpenseReportView
        showDetailedBalanceColumns={false}
        loading={false}
        detailedCustomFilterHasNoData={false}
        balanceInfo={ZERO_BALANCE}
        detailedListWithBalances={[]}
        detailedAllEmployeesRows={[]}
      />,
    );
    expect(screen.getByText(/No approved expenses match your filters/)).toBeInTheDocument();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T4–T6  Single-employee mode
// ═════════════════════════════════════════════════════════════════════════════

describe("T4 — single-employee: opening-balance-banner rendered", () => {
  it("shows opening-balance-banner with balanceInfo.opening", () => {
    render(
      <MobileDetailedExpenseReportView
        showDetailedBalanceColumns={true}
        loading={false}
        detailedCustomFilterHasNoData={false}
        balanceInfo={BALANCE_INFO}
        detailedListWithBalances={[BALANCE_ROW]}
        detailedAllEmployeesRows={[]}
      />,
    );
    expect(screen.getByTestId("opening-balance-banner")).toBeInTheDocument();
    expect(screen.getByText(/Opening Balance/)).toBeInTheDocument();
  });
});

describe("T5 — single-employee: detailed-balance-card items rendered", () => {
  it("shows detailed-balance-card and closing balance line", () => {
    render(
      <MobileDetailedExpenseReportView
        showDetailedBalanceColumns={true}
        loading={false}
        detailedCustomFilterHasNoData={false}
        balanceInfo={BALANCE_INFO}
        detailedListWithBalances={[BALANCE_ROW]}
        detailedAllEmployeesRows={[]}
      />,
    );
    expect(screen.getByTestId("detailed-balance-card")).toBeInTheDocument();
    expect(screen.getByText(/Closing:/)).toBeInTheDocument();
  });
});

describe("T6 — single-employee: empty state when no balance rows", () => {
  it("shows period-empty message when detailedListWithBalances is empty", () => {
    render(
      <MobileDetailedExpenseReportView
        showDetailedBalanceColumns={true}
        loading={false}
        detailedCustomFilterHasNoData={false}
        balanceInfo={ZERO_BALANCE}
        detailedListWithBalances={[]}
        detailedAllEmployeesRows={[]}
      />,
    );
    expect(screen.getByText(/No allocations or expenses in this period/)).toBeInTheDocument();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T7–T8  Loading + no overflow
// ═════════════════════════════════════════════════════════════════════════════

describe("T7 — loading state: shows loading message, not card list", () => {
  it("renders loading text and suppresses card list when loading=true", () => {
    render(
      <MobileDetailedExpenseReportView
        showDetailedBalanceColumns={false}
        loading={true}
        detailedCustomFilterHasNoData={false}
        balanceInfo={ZERO_BALANCE}
        detailedListWithBalances={[]}
        detailedAllEmployeesRows={[ALL_EMP_ROW]}
      />,
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByTestId("detailed-card-list")).toBeNull();
  });
});

describe("T8 — no overflow-x-auto in mobile card output", () => {
  it("the rendered DOM has no overflow-x-auto element", () => {
    const { container } = render(
      <MobileDetailedExpenseReportView
        showDetailedBalanceColumns={false}
        loading={false}
        detailedCustomFilterHasNoData={false}
        balanceInfo={ZERO_BALANCE}
        detailedListWithBalances={[]}
        detailedAllEmployeesRows={[ALL_EMP_ROW]}
      />,
    );
    expect(container.querySelector(".overflow-x-auto")).toBeNull();
  });
});
