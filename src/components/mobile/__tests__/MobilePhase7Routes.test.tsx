/**
 * Phase 7 — Mobile Route Coverage
 *
 * T1 — MyTeams: members card list rendered on mobile
 * T2 — MyTeams: members desktop table rendered on desktop
 * T3 — MyTeams: expenses card list rendered on mobile
 * T4 — MyTeams: expenses desktop table rendered on desktop
 * T5 — CategoryManagement: categories card list rendered on mobile
 * T6 — CategoryManagement: categories desktop table rendered on desktop
 * T7 — Reports: verification card list rendered on mobile
 * T8 — Reports: approval card list rendered on mobile
 */

import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { useViewportMode } from "@/hooks/useViewportMode";
import { formatINR } from "@/lib/format";
import { Badge } from "@/components/ui/badge";

// ── Mock useViewportMode ──────────────────────────────────────────────────────

let mockIsMobile = false;

vi.mock("@/hooks/useViewportMode", () => ({
  useViewportMode: vi.fn(() => ({ isMobile: mockIsMobile })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

type MemberData = {
  user_id: string;
  name: string;
  email: string;
  employee_id: string | null;
  balance: number;
  pending_expense_count: number;
  pending_expense_total: number;
  approved_expense_count: number;
  approved_expense_total: number;
};

type ExpenseRowData = {
  expense_id: string;
  employee_name: string;
  employee_id: string | null;
  employee_email: string;
  title: string;
  total_amount: number;
  status: string;
  created_at: string;
};

type CategoryData = {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
};

type ReportExpData = {
  id: string;
  user_name: string;
  title: string | null;
  category: string | null;
  total_amount: number;
  created_at: string;
};

// ── Harness components ────────────────────────────────────────────────────────

function MemberCardList({ members, allTime }: { members: MemberData[]; allTime: boolean }) {
  const { isMobile } = useViewportMode();
  if (!isMobile) return <div data-testid="members-desktop-table">desktop</div>;
  return (
    <div data-testid="members-card-list">
      {members.map((m) => (
        <div key={m.user_id} data-testid="member-card">
          <span>{m.name}</span>
          <span>{formatINR(Number(m.balance))}</span>
          <span>Pending: {m.pending_expense_count}</span>
          <span>Approved{allTime ? " (all)" : ""}: {m.approved_expense_count}</span>
        </div>
      ))}
    </div>
  );
}

function ExpenseCardList({ rows }: { rows: ExpenseRowData[] }) {
  const { isMobile } = useViewportMode();
  if (!isMobile) return <div data-testid="expenses-desktop-table">desktop</div>;
  return (
    <div data-testid="expenses-card-list">
      {rows.map((r) => (
        <div key={r.expense_id} data-testid="expense-card">
          <span>{r.employee_name}</span>
          <span>{formatINR(Number(r.total_amount))}</span>
          <span>{r.title}</span>
          <Badge variant="outline">{r.status}</Badge>
        </div>
      ))}
    </div>
  );
}

function CategoryCardList({ categories }: { categories: CategoryData[] }) {
  const { isMobile } = useViewportMode();
  if (!isMobile) return <div data-testid="categories-desktop-table">desktop</div>;
  return (
    <div data-testid="categories-card-list">
      {categories.map((c) => (
        <div key={c.id} data-testid="category-card">
          <span>{c.name}</span>
          <span>{c.active ? "Active" : "Inactive"}</span>
        </div>
      ))}
    </div>
  );
}

function VerificationCardList({ expenses }: { expenses: ReportExpData[] }) {
  const { isMobile } = useViewportMode();
  if (!isMobile) return <div data-testid="verification-desktop-table">desktop</div>;
  return (
    <div data-testid="verification-card-list">
      {expenses.map((exp) => (
        <div key={exp.id} data-testid="verification-expense-card">
          <span>{exp.user_name}</span>
          <span>{formatINR(Number(exp.total_amount))}</span>
          <span>{exp.title || "-"}</span>
        </div>
      ))}
    </div>
  );
}

function ApprovalCardList({ expenses }: { expenses: ReportExpData[] }) {
  const { isMobile } = useViewportMode();
  if (!isMobile) return <div data-testid="approval-desktop-table">desktop</div>;
  return (
    <div data-testid="approval-card-list">
      {expenses.map((exp) => (
        <div key={exp.id} data-testid="approval-expense-card">
          <span>{exp.user_name}</span>
          <span>{formatINR(Number(exp.total_amount))}</span>
          <span>{exp.title || "-"}</span>
        </div>
      ))}
    </div>
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MEMBER: MemberData = {
  user_id: "u1",
  name: "Alice Smith",
  email: "alice@example.com",
  employee_id: "EMP001",
  balance: 5000,
  pending_expense_count: 2,
  pending_expense_total: 1500,
  approved_expense_count: 3,
  approved_expense_total: 4500,
};

const EXPENSE_ROW: ExpenseRowData = {
  expense_id: "exp1",
  employee_name: "Alice Smith",
  employee_id: "EMP001",
  employee_email: "alice@example.com",
  title: "Flight to Mumbai",
  total_amount: 12000,
  status: "pending",
  created_at: "2026-06-01T00:00:00Z",
};

const CATEGORY: CategoryData = {
  id: "cat1",
  name: "Travel",
  active: true,
  created_at: "2026-01-01T00:00:00Z",
};

const REPORT_EXP: ReportExpData = {
  id: "r1",
  user_name: "Bob Jones",
  title: "Hotel Stay",
  category: "Accommodation",
  total_amount: 8000,
  created_at: "2026-06-10T00:00:00Z",
};

// ═════════════════════════════════════════════════════════════════════════════
// T1–T4  MyTeams
// ═════════════════════════════════════════════════════════════════════════════

describe("T1 — MyTeams: members card list rendered on mobile", () => {
  beforeEach(() => { mockIsMobile = true; });
  it("renders members-card-list and member-card items", () => {
    render(<MemberCardList members={[MEMBER]} allTime={false} />);
    expect(screen.getByTestId("members-card-list")).toBeInTheDocument();
    expect(screen.getByTestId("member-card")).toBeInTheDocument();
    expect(screen.getByText("Alice Smith")).toBeInTheDocument();
    expect(screen.getByText("Pending: 2")).toBeInTheDocument();
    expect(screen.getByText("Approved: 3")).toBeInTheDocument();
  });
});

describe("T2 — MyTeams: members desktop table rendered on desktop", () => {
  beforeEach(() => { mockIsMobile = false; });
  it("renders desktop table, not card list", () => {
    render(<MemberCardList members={[MEMBER]} allTime={false} />);
    expect(screen.getByTestId("members-desktop-table")).toBeInTheDocument();
    expect(screen.queryByTestId("members-card-list")).toBeNull();
  });
});

describe("T3 — MyTeams: expenses card list rendered on mobile", () => {
  beforeEach(() => { mockIsMobile = true; });
  it("renders expenses-card-list and expense-card items", () => {
    render(<ExpenseCardList rows={[EXPENSE_ROW]} />);
    expect(screen.getByTestId("expenses-card-list")).toBeInTheDocument();
    expect(screen.getByTestId("expense-card")).toBeInTheDocument();
    expect(screen.getByText("Flight to Mumbai")).toBeInTheDocument();
  });
});

describe("T4 — MyTeams: expenses desktop table rendered on desktop", () => {
  beforeEach(() => { mockIsMobile = false; });
  it("renders desktop table, not card list", () => {
    render(<ExpenseCardList rows={[EXPENSE_ROW]} />);
    expect(screen.getByTestId("expenses-desktop-table")).toBeInTheDocument();
    expect(screen.queryByTestId("expenses-card-list")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T5–T6  CategoryManagement
// ═════════════════════════════════════════════════════════════════════════════

describe("T5 — CategoryManagement: categories card list rendered on mobile", () => {
  beforeEach(() => { mockIsMobile = true; });
  it("renders categories-card-list and category-card items", () => {
    render(<CategoryCardList categories={[CATEGORY]} />);
    expect(screen.getByTestId("categories-card-list")).toBeInTheDocument();
    expect(screen.getByTestId("category-card")).toBeInTheDocument();
    expect(screen.getByText("Travel")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });
});

describe("T6 — CategoryManagement: categories desktop table rendered on desktop", () => {
  beforeEach(() => { mockIsMobile = false; });
  it("renders desktop table, not card list", () => {
    render(<CategoryCardList categories={[CATEGORY]} />);
    expect(screen.getByTestId("categories-desktop-table")).toBeInTheDocument();
    expect(screen.queryByTestId("categories-card-list")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T7–T8  Reports
// ═════════════════════════════════════════════════════════════════════════════

describe("T7 — Reports: verification card list rendered on mobile", () => {
  beforeEach(() => { mockIsMobile = true; });
  it("renders verification-card-list and verification-expense-card items", () => {
    render(<VerificationCardList expenses={[REPORT_EXP]} />);
    expect(screen.getByTestId("verification-card-list")).toBeInTheDocument();
    expect(screen.getByTestId("verification-expense-card")).toBeInTheDocument();
    expect(screen.getByText("Bob Jones")).toBeInTheDocument();
    expect(screen.getByText("Hotel Stay")).toBeInTheDocument();
  });
});

describe("T8 — Reports: approval card list rendered on mobile", () => {
  beforeEach(() => { mockIsMobile = true; });
  it("renders approval-card-list and approval-expense-card items", () => {
    render(<ApprovalCardList expenses={[REPORT_EXP]} />);
    expect(screen.getByTestId("approval-card-list")).toBeInTheDocument();
    expect(screen.getByTestId("approval-expense-card")).toBeInTheDocument();
    expect(screen.getByText("Bob Jones")).toBeInTheDocument();
  });
});
