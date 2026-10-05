/**
 * DOC-087 — Employee Balance History page behaviour.
 *
 * Covers the flag gate, the balance source, credit rendering, legacy payment
 * modes, empty/error states and server pagination.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import EmployeeBalanceHistory from "../EmployeeBalanceHistory";
import { useAuth } from "@/contexts/AuthContext";

const rpcMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

vi.mock("@/hooks/useViewportMode", () => ({
  useViewportMode: () => ({ isMobile: false }),
}));

const refreshBalance = vi.fn();

function mockAuth({
  featureOn = true,
  userRole = "employee",
  userBalance = 18250,
}: {
  featureOn?: boolean;
  userRole?: string;
  userBalance?: number | null;
} = {}) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "emp-1" },
    userRole,
    organizationId: "org-1",
    userBalance,
    refreshBalance,
    hasOrganizationFeature: () => featureOn,
  } as unknown as ReturnType<typeof useAuth>);
}

function makeRow(over: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    amount: 10000,
    transferred_at: "2026-08-08T10:00:00Z",
    payment_mode: "bank_transfer",
    transfer_type: "admin_to_employee",
    credited_by_name: "Finance Admin",
    source_bank_name: "HDFC Bank",
    total_count: 1,
    ...over,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/balance-history"]}>
        <EmployeeBalanceHistory />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * The page's own get_my_balance_transfer_history query and the Balance
 * Ledger card's get_my_unified_balance_timeline_v3 query now both run
 * whenever the feature is on (previously only the former existed) -- both
 * go through this same rpcMock. Branching by RPC name here, rather than one
 * blanket mockResolvedValue, keeps every existing assertion about the
 * transfer-history RPC's shape correct without the two concurrent queries'
 * calls interfering with each other.
 */
function lastCallTo(name: string) {
  return [...rpcMock.mock.calls].reverse().find((call) => call[0] === name);
}

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockImplementation((fn: string) => {
    if (fn === "get_my_unified_balance_timeline_v3") {
      return Promise.resolve({ data: [], error: null });
    }
    return Promise.resolve({ data: [makeRow()], error: null });
  });
  mockAuth();
});

describe("EmployeeBalanceHistory — feature gate", () => {
  it("redirects to the dashboard and issues no RPC when the feature is off", async () => {
    mockAuth({ featureOn: false });
    renderPage();

    expect(await screen.findByText("Navigate to /dashboard")).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("renders the page and queries when the feature is on", async () => {
    renderPage();

    expect(await screen.findByText("Balance History")).toBeInTheDocument();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
  });

  it("redirects a non-employee role even if the flag is on", async () => {
    mockAuth({ userRole: "admin" });
    renderPage();

    expect(await screen.findByText("Navigate to /dashboard")).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("EmployeeBalanceHistory — current balance", () => {
  it("shows the AuthContext balance, not the sum of credits", async () => {
    // Two credits of 10,000 each; balance is deliberately different.
    rpcMock.mockResolvedValue({
      data: [
        makeRow({ id: "a", amount: 10000, total_count: 2 }),
        makeRow({ id: "b", amount: 10000, total_count: 2 }),
      ],
      error: null,
    });
    mockAuth({ userBalance: 18250 });
    renderPage();

    expect(await screen.findByText("₹18,250.00")).toBeInTheDocument();
    // 20,000 would be the (wrong) sum-of-credits figure.
    expect(screen.queryByText("₹20,000.00")).not.toBeInTheDocument();
  });

  it("renders the newest credit as Last Credit", async () => {
    rpcMock.mockResolvedValue({
      data: [
        makeRow({ id: "newest", amount: 10000, total_count: 2 }),
        makeRow({ id: "older", amount: 500, total_count: 2 }),
      ],
      error: null,
    });
    renderPage();
    await screen.findAllByTestId("credit-row");

    // The Last Credit card sits outside the row list and shows the newest amount.
    const lastCreditCard = screen.getByText("Last Credit").closest("div.rounded-lg");
    expect(lastCreditCard).not.toBeNull();
    expect(lastCreditCard!.textContent).toContain("+₹10,000.00");
    expect(lastCreditCard!.textContent).not.toContain("₹500.00");
  });

  it("says no credits recorded when history is empty", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    mockAuth({ userBalance: 500 });
    renderPage();

    expect(
      await screen.findByText("No balance credits recorded yet."),
    ).toBeInTheDocument();
    expect(screen.getByText("No recorded credits yet")).toBeInTheDocument();
    // Current balance stays visible on an empty history.
    expect(screen.getByText("₹500.00")).toBeInTheDocument();
  });
});

describe("EmployeeBalanceHistory — row rendering", () => {
  it("labels bank_transfer correctly", async () => {
    renderPage();
    expect(await screen.findByText("Bank transfer")).toBeInTheDocument();
  });

  it("labels cash correctly", async () => {
    rpcMock.mockResolvedValue({
      data: [makeRow({ payment_mode: "cash" })],
      error: null,
    });
    renderPage();
    expect(await screen.findByText("Cash")).toBeInTheDocument();
  });

  it("does not call a null payment mode Cash", async () => {
    rpcMock.mockResolvedValue({
      data: [makeRow({ payment_mode: null })],
      error: null,
    });
    renderPage();

    expect(await screen.findByText("Not recorded")).toBeInTheDocument();
    expect(screen.queryByText("Cash")).not.toBeInTheDocument();
  });

  it("falls back neutrally when credited-by name is missing", async () => {
    rpcMock.mockResolvedValue({
      data: [makeRow({ credited_by_name: null })],
      error: null,
    });
    renderPage();
    expect(await screen.findByText("PesoWise allocation")).toBeInTheDocument();
  });

  it("renders rows in the order the server returned them", async () => {
    rpcMock.mockResolvedValue({
      data: [
        makeRow({ id: "a", amount: 300, total_count: 3 }),
        makeRow({ id: "b", amount: 200, total_count: 3 }),
        makeRow({ id: "c", amount: 100, total_count: 3 }),
      ],
      error: null,
    });
    renderPage();

    const rows = await screen.findAllByTestId("credit-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("₹300.00"),
      expect.stringContaining("₹200.00"),
      expect.stringContaining("₹100.00"),
    ]);
  });

  it("never renders a source account number", async () => {
    rpcMock.mockResolvedValue({
      data: [makeRow()],
      error: null,
    });
    const { container } = renderPage();
    await screen.findByText("Bank transfer");

    // Masked or raw account numbers must not reach the employee surface.
    expect(container.textContent).not.toMatch(/\*{2,}\d/);
    expect(container.textContent).not.toContain("XXXX");
  });
});

describe("EmployeeBalanceHistory — error and refresh", () => {
  it("shows a neutral retry state when the RPC fails", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'permission denied for function get_my_balance_transfer_history' },
    });
    const { container } = renderPage();

    expect(
      await screen.findByText("We couldn't load your balance history. Please try again."),
    ).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
    // No raw Postgres text or internal function names leak to the user.
    expect(container.textContent).not.toContain("permission denied");
    expect(container.textContent).not.toContain("get_my_balance_transfer_history");
  });

  it("refresh refetches history and the authoritative balance", async () => {
    renderPage();
    await screen.findByText("Bank transfer");
    rpcMock.mockClear();

    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(refreshBalance).toHaveBeenCalled();
  });
});

describe("EmployeeBalanceHistory — pagination", () => {
  it("requests the default page size with a zero offset", async () => {
    renderPage();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    expect(rpcMock).toHaveBeenCalledWith("get_my_balance_transfer_history", {
      p_organization_id: "org-1",
      p_limit: 25,
      p_offset: 0,
    });
  });

  it("sends the correct offset when moving to page 2", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "get_my_unified_balance_timeline_v3") {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: [makeRow({ total_count: 60 })], error: null });
    });
    renderPage();
    await screen.findByText("Bank transfer");

    fireEvent.click(screen.getByLabelText("Next page"));

    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith("get_my_balance_transfer_history", {
        p_organization_id: "org-1",
        p_limit: 25,
        p_offset: 25,
      }),
    );
  });

  it("clamps back to page 1 when the server reports fewer records than the current page needs", async () => {
    // Page 1 looks like a 60-record list, but by the time page 2 is requested
    // only one record remains — the view must not strand the user on page 2.
    rpcMock.mockImplementation((fn: string, args: { p_offset: number }) => {
      if (fn === "get_my_unified_balance_timeline_v3") {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({
        data:
          args.p_offset === 0
            ? [makeRow({ total_count: 60 })]
            : [makeRow({ id: "shrunk", total_count: 1 })],
        error: null,
      });
    });
    renderPage();
    await screen.findByText("Bank transfer");

    fireEvent.click(screen.getByLabelText("Next page"));
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith(
        "get_my_balance_transfer_history",
        expect.objectContaining({ p_offset: 25 }),
      ),
    );

    // The shrunken total forces a clamp, which re-requests offset 0. Checked
    // against this RPC's own last call specifically -- the unified-ledger
    // query (get_my_unified_balance_timeline_v3) also runs concurrently and
    // may legitimately be the mock's overall last call.
    await waitFor(() =>
      expect(lastCallTo("get_my_balance_transfer_history")).toEqual([
        "get_my_balance_transfer_history",
        expect.objectContaining({ p_offset: 0 }),
      ]),
    );
  });
});

describe("EmployeeBalanceHistory — organization scoping", () => {
  it("keys the query by organization so a switch does not show the old org's rows", async () => {
    // One shared cache across both renders — this is what would leak if the
    // query key omitted organizationId.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // A fresh element each time — React bails out of re-rendering an identical
    // element reference, which would silently make this assertion meaningless.
    const ui = () => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/balance-history"]}>
          <EmployeeBalanceHistory />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(ui());
    await screen.findByText("Finance Admin");

    // Switch organisation; org-2's query has not resolved yet.
    rpcMock.mockReturnValue(new Promise(() => {}));
    vi.mocked(useAuth).mockReturnValue({
      user: { id: "emp-1" },
      userRole: "employee",
      organizationId: "org-2",
      userBalance: 0,
      refreshBalance,
      hasOrganizationFeature: () => true,
    } as unknown as ReturnType<typeof useAuth>);
    rerender(ui());

    // org-1's credit must not still be on screen while org-2 loads.
    await waitFor(() =>
      expect(screen.queryByText("Finance Admin")).not.toBeInTheDocument(),
    );
    expect(lastCallTo("get_my_balance_transfer_history")).toEqual([
      "get_my_balance_transfer_history",
      expect.objectContaining({ p_organization_id: "org-2" }),
    ]);
  });

  it("passes the current organization id to the RPC", async () => {
    renderPage();
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith(
        "get_my_balance_transfer_history",
        expect.objectContaining({ p_organization_id: "org-1" }),
      ),
    );
  });

  it("sends no user id — the RPC derives the recipient from auth.uid()", async () => {
    renderPage();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    const args = rpcMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(args)).toEqual(["p_organization_id", "p_limit", "p_offset"]);
    expect(JSON.stringify(args)).not.toContain("emp-1");
  });
});

describe("EmployeeBalanceHistory — stale cache on feature switch-off", () => {
  it("stops rendering cached rows once the feature is disabled", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = () => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/balance-history"]}>
          <EmployeeBalanceHistory />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(ui());
    await screen.findByText("Finance Admin");

    mockAuth({ featureOn: false });
    rerender(ui());

    await waitFor(() =>
      expect(screen.queryByText("Finance Admin")).not.toBeInTheDocument(),
    );
  });
});
