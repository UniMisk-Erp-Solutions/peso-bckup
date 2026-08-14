/**
 * Phase 6B tests — Mobile Cashier Operations + Notifications
 * T1–T3:  MobileNotificationsView
 * T4–T6:  MobileTransferOffersView
 * T7–T9:  MobileAccountantExpensesView
 * T10–T12: MobileCashierTransactionsView
 * T13–T15: MobileCashTransferHistoryView
 * T16–T18: MobileBalancesView
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";

// ── Shared mocks ─────────────────────────────────────────────────────────────

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => Promise.resolve({ data: [], error: null })),
          in: vi.fn(() => Promise.resolve({ data: [], error: null })),
        })),
      })),
    })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    })),
  },
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    userRole: "cashier",
    organizationId: "org1",
    organizationFeatureFlags: {},
    hasOrganizationFeature: () => false,
    isAccountantCashier: false,
  }),
}));

vi.mock("@/i18n", () => ({
  useTranslation: (_ns?: string | string[]) => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
    i18n: { language: "en" },
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: (_ns?: string | string[]) => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
    i18n: { language: "en" },
  }),
}));

vi.mock("@/components/TransferOfferActions", () => ({
  TransferOfferActions: ({ offer }: { offer: { id: string } }) => (
    <div data-testid={`transfer-offer-actions-${offer.id}`}>Actions</div>
  ),
}));

vi.mock("@/components/TransferOfferStatusBadge", () => ({
  TransferOfferStatusBadge: ({ status }: { status: string }) => (
    <span data-testid="offer-status-badge">{status}</span>
  ),
  transferOfferStatusLabel: (s: string) => s,
}));

vi.mock("@/components/TransferSentOffersPanel", () => ({
  TransferSentOffersPanel: () => <div data-testid="transfer-sent-offers-panel" />,
}));

vi.mock("@/components/ExpenseStatusWithCorrectionBadge", () => ({
  ExpenseStatusWithCorrectionBadge: ({ status }: { status: string }) => (
    <span data-testid="status-badge">{status}</span>
  ),
}));

vi.mock("@/components/ExpenseCustomFieldFilters", () => ({
  ExpenseCustomFieldFilters: () => null,
}));

// ============================================================
// GROUP 1 — MobileNotificationsView
// ============================================================

import { MobileNotificationsView } from "../MobileNotificationsView";
import type { MobileNotification } from "../MobileNotificationsView";

function makeNotification(overrides: Partial<MobileNotification> = {}): MobileNotification {
  return {
    id: "n1",
    type: "expense_approved",
    title: "Expense Approved",
    message: "Your expense was approved.",
    expense_id: "exp-1",
    created_at: "2026-07-01T10:00:00Z",
    read: false,
    ...overrides,
  };
}

const mockIcon = () => <span data-testid="notif-icon">icon</span>;

describe("MobileNotificationsView", () => {
  it("T1: renders notification title", () => {
    render(
      <MobileNotificationsView
        notifications={[makeNotification()]}
        loading={false}
        unreadCount={1}
        onMarkAsRead={vi.fn()}
        onMarkAllAsRead={vi.fn()}
        onNotificationClick={vi.fn()}
        getNotificationIcon={() => <span />}
        getNotificationBadgeVariant={() => "default"}
      />,
    );
    expect(screen.getByText("Expense Approved")).toBeInTheDocument();
  });

  it("T2: shows empty state when no notifications", () => {
    render(
      <MobileNotificationsView
        notifications={[]}
        loading={false}
        unreadCount={0}
        onMarkAsRead={vi.fn()}
        onMarkAllAsRead={vi.fn()}
        onNotificationClick={vi.fn()}
        getNotificationIcon={() => <span />}
        getNotificationBadgeVariant={() => "default"}
      />,
    );
    expect(screen.getByTestId("notifications-empty")).toBeInTheDocument();
  });

  it("T3: calls onMarkAllAsRead when Mark all read is clicked", () => {
    const onMarkAllAsRead = vi.fn();
    render(
      <MobileNotificationsView
        notifications={[makeNotification()]}
        loading={false}
        unreadCount={1}
        onMarkAsRead={vi.fn()}
        onMarkAllAsRead={onMarkAllAsRead}
        onNotificationClick={vi.fn()}
        getNotificationIcon={mockIcon}
        getNotificationBadgeVariant={() => "default"}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /mark all read/i }));
    expect(onMarkAllAsRead).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// GROUP 2 — MobileTransferOffersView
// ============================================================

import { MobileTransferOffersView } from "../MobileTransferOffersView";
import type { BalanceTransferOffer } from "@/services/BalanceTransferOfferService";

function makeOffer(overrides: Partial<BalanceTransferOffer> = {}): BalanceTransferOffer {
  return {
    id: "offer-1",
    organizationId: "org1",
    recipientId: "u1",
    transferrerId: "u2",
    amount: 2500,
    status: "pending",
    paymentMode: "cash",
    note: null,
    proposed_at: "2026-07-01T10:00:00Z",
    responded_at: null,
    transferrer_name: "Bob Patel",
    recipient_name: "Alice Sharma",
    rejection_reason: null,
    ...overrides,
  } as BalanceTransferOffer;
}

describe("MobileTransferOffersView", () => {
  it("T4: renders pending offer amount", () => {
    render(
      <MemoryRouter>
        <MobileTransferOffersView
          pending={[makeOffer()]}
          history={[]}
          loading={false}
          onLoad={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/2,500/)).toBeInTheDocument();
  });

  it("T5: shows empty state when no pending offers", () => {
    render(
      <MemoryRouter>
        <MobileTransferOffersView
          pending={[]}
          history={[]}
          loading={false}
          onLoad={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("transfer-offers-pending-empty")).toBeInTheDocument();
  });

  it("T6: renders history tab trigger", () => {
    render(
      <MemoryRouter>
        <MobileTransferOffersView
          pending={[]}
          history={[makeOffer({ id: "offer-hist", status: "accepted" })]}
          loading={false}
          onLoad={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("tab", { name: /history/i })).toBeInTheDocument();
  });
});

// ============================================================
// GROUP 3 — MobileAccountantExpensesView
// ============================================================

import { MobileAccountantExpensesView } from "../MobileAccountantExpensesView";

type ApprovedExpense = Parameters<typeof MobileAccountantExpensesView>[0]["expenses"][0];

function makeApprovedExpense(overrides: Partial<ApprovedExpense> = {}): ApprovedExpense {
  return {
    id: "ae-1",
    title: "Conference Trip",
    destination: "Bangalore",
    trip_start: "2026-07-01",
    status: "approved",
    total_amount: 12000,
    created_at: "2026-07-01T08:00:00Z",
    user_id: "u2",
    user_name: "Ravi Kumar",
    user_email: "ravi@example.com",
    user_balance: 20000,
    category: "travel",
    transaction_number: "TXN-002",
    wasReviewerCorrected: false,
    batch_id: null,
    custom_fields: {},
    ...overrides,
  };
}

describe("MobileAccountantExpensesView", () => {
  it("T7: renders expense user name", () => {
    render(
      <MemoryRouter>
        <MobileAccountantExpensesView
          expenses={[makeApprovedExpense()]}
          loading={false}
          searchTerm=""
          setSearchTerm={vi.fn()}
          expenseSort="newest"
          setExpenseSort={vi.fn()}
          totalAmount={12000}
          approvedCount={1}
          onViewExpense={vi.fn()}
          filterableCustomFields={[]}
          customFieldFilters={{}}
          setCustomFieldFilters={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Ravi Kumar")).toBeInTheDocument();
  });

  it("T8: shows empty state when no expenses", () => {
    render(
      <MemoryRouter>
        <MobileAccountantExpensesView
          expenses={[]}
          loading={false}
          searchTerm=""
          setSearchTerm={vi.fn()}
          expenseSort="newest"
          setExpenseSort={vi.fn()}
          totalAmount={0}
          approvedCount={0}
          onViewExpense={vi.fn()}
          filterableCustomFields={[]}
          customFieldFilters={{}}
          setCustomFieldFilters={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("accountant-expenses-empty")).toBeInTheDocument();
  });

  it("T9: calls onViewExpense when card is clicked", () => {
    const onViewExpense = vi.fn();
    const expense = makeApprovedExpense();
    render(
      <MemoryRouter>
        <MobileAccountantExpensesView
          expenses={[expense]}
          loading={false}
          searchTerm=""
          setSearchTerm={vi.fn()}
          expenseSort="newest"
          setExpenseSort={vi.fn()}
          totalAmount={12000}
          approvedCount={1}
          onViewExpense={onViewExpense}
          filterableCustomFields={[]}
          customFieldFilters={{}}
          setCustomFieldFilters={vi.fn()}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("accountant-expense-card"));
    expect(onViewExpense).toHaveBeenCalledWith("ae-1");
  });
});

// ============================================================
// GROUP 4 — MobileCashierTransactionsView
// ============================================================

import { MobileCashierTransactionsView } from "../MobileCashierTransactionsView";

describe("MobileCashierTransactionsView", () => {
  it("T10: renders assignment recipient name", () => {
    render(
      <MobileCashierTransactionsView
        moneyAssignments={[
          {
            id: "ma-1",
            recipient_id: "u2",
            recipient_name: "Priya Singh",
            amount: 5000,
            assigned_at: "2026-07-01T09:00:00Z",
            is_returned: false,
          },
        ]}
        returnRequests={[]}
        loading={false}
        activeTab="assignments"
        setActiveTab={vi.fn()}
      />,
    );
    expect(screen.getByText("Priya Singh")).toBeInTheDocument();
  });

  it("T11: shows empty state when no assignments", () => {
    render(
      <MobileCashierTransactionsView
        moneyAssignments={[]}
        returnRequests={[]}
        loading={false}
        activeTab="assignments"
        setActiveTab={vi.fn()}
      />,
    );
    expect(screen.getByTestId("assignments-empty")).toBeInTheDocument();
  });

  it("T12: renders returns tab trigger", () => {
    render(
      <MobileCashierTransactionsView
        moneyAssignments={[]}
        returnRequests={[]}
        loading={false}
        activeTab="assignments"
        setActiveTab={vi.fn()}
      />,
    );
    expect(screen.getByRole("tab", { name: /returns/i })).toBeInTheDocument();
  });
});

// ============================================================
// GROUP 5 — MobileCashTransferHistoryView
// ============================================================

import { MobileCashTransferHistoryView } from "../MobileCashTransferHistoryView";

type CashTransfer = Parameters<typeof MobileCashTransferHistoryView>[0]["filteredTransfers"][0];

function makeTransfer(overrides: Partial<CashTransfer> = {}): CashTransfer {
  return {
    id: "tr-1",
    transferrer_id: "u2",
    transferrer_name: "Admin User",
    transferrer_role: "admin",
    recipient_id: "u3",
    recipient_name: "Cashier One",
    recipient_role: "cashier",
    amount: 10000,
    transfer_type: "admin_to_cashier",
    payment_mode: "cash",
    transferred_at: "2026-07-01T10:00:00Z",
    notes: "Monthly allocation",
    ...overrides,
  };
}

describe("MobileCashTransferHistoryView", () => {
  it("T13: renders transfer amount", () => {
    render(
      <MobileCashTransferHistoryView
        filteredTransfers={[makeTransfer()]}
        loading={false}
        searchTerm=""
        setSearchTerm={vi.fn()}
        isAccountantCashier={false}
        getTransferTypeLabel={(t) => t}
      />,
    );
    expect(screen.getByText(/10,000/)).toBeInTheDocument();
  });

  it("T14: shows empty state when no transfers", () => {
    render(
      <MobileCashTransferHistoryView
        filteredTransfers={[]}
        loading={false}
        searchTerm=""
        setSearchTerm={vi.fn()}
        isAccountantCashier={false}
        getTransferTypeLabel={(t) => t}
      />,
    );
    expect(screen.getByTestId("transfer-history-empty")).toBeInTheDocument();
  });

  it("T15: calls setSearchTerm when search input changes", () => {
    const setSearchTerm = vi.fn();
    render(
      <MobileCashTransferHistoryView
        filteredTransfers={[]}
        loading={false}
        searchTerm=""
        setSearchTerm={setSearchTerm}
        isAccountantCashier={false}
        getTransferTypeLabel={(t) => t}
      />,
    );
    fireEvent.change(screen.getByTestId("transfer-history-search"), {
      target: { value: "Admin" },
    });
    expect(setSearchTerm).toHaveBeenCalledWith("Admin");
  });
});

// ============================================================
// GROUP 6 — MobileBalancesView
// ============================================================

import { MobileBalancesView } from "../MobileBalancesView";

type ProfileRow = Parameters<typeof MobileBalancesView>[0]["rows"][0];

function makeProfileRow(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    user_id: "u3",
    name: "Nilesh Varma",
    email: "nilesh@example.com",
    balance: 8000,
    role: "employee",
    ...overrides,
  };
}

const baseBalancesProps = {
  activeTab: "balances" as const,
  setActiveTab: vi.fn(),
  transferAcceptanceEnabled: false,
  userRole: "cashier",
  cashierBalance: 50000,
  loading: false,
  searchTerm: "",
  setSearchTerm: vi.fn(),
  addAmounts: {},
  setAddAmounts: vi.fn(),
  addNotes: {},
  setAddNotes: vi.fn(),
  allocationMode: "cash" as const,
  setAllocationMode: vi.fn(),
  bankAccounts: [],
  selectedBankAccountByUser: {},
  setSelectedBankAccountByUser: vi.fn(),
  savingId: null,
  onAddToUser: vi.fn().mockResolvedValue(undefined),
  filteredTransfers: [],
  transferHistoryLoading: false,
  transferSearchTerm: "",
  setTransferSearchTerm: vi.fn(),
  getTransferTypeLabel: (t: string) => t,
};

describe("MobileBalancesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("T16: renders user name in balances tab", () => {
    render(
      <MobileBalancesView
        {...baseBalancesProps}
        rows={[makeProfileRow()]}
      />,
    );
    expect(screen.getByText("Nilesh Varma")).toBeInTheDocument();
  });

  it("T17: shows empty state when no rows", () => {
    render(
      <MobileBalancesView
        {...baseBalancesProps}
        rows={[]}
      />,
    );
    expect(screen.getByTestId("balances-empty")).toBeInTheDocument();
  });

  it("T18: shows history empty state when history tab is active", () => {
    render(
      <MobileBalancesView
        {...baseBalancesProps}
        rows={[]}
        activeTab="history"
        filteredTransfers={[]}
      />,
    );
    expect(screen.getByTestId("balances-history-empty")).toBeInTheDocument();
  });
});
