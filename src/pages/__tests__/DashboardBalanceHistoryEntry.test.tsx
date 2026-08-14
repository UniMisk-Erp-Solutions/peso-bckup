/**
 * DOC-087 — Dashboard Current Balance card entry point.
 *
 * With the feature on, an employee's Current Balance card becomes a link into
 * /balance-history. With it off, the card must stay inert. The displayed balance
 * value is unchanged in both cases.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import Dashboard from "../Dashboard";
import { useAuth } from "@/contexts/AuthContext";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";

const navigateMock = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("@/hooks/useDashboardTheme", () => ({
  useDashboardTheme: () => ["default", vi.fn()],
}));
vi.mock("@/hooks/useDashboardBackendHealth", () => ({
  useDashboardBackendHealth: () => ({ status: "ok", lastCheckedAt: null }),
}));
vi.mock("@/hooks/useAllowCashierExpenseSubmission", () => ({
  useAllowCashierExpenseSubmission: () => ({ allowCashierExpenseSubmission: null }),
}));
vi.mock("@/components/DashboardPendingTransferOffers", () => ({
  DashboardPendingTransferOffers: () => null,
}));

// The Dashboard fans out to several tables/RPCs on mount. None of them feed the
// Current Balance card (that value comes from AuthContext), so they are stubbed
// to resolve empty rather than throw and mask the assertion under test.
vi.mock("@/integrations/supabase/client", () => {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  Object.assign(builder, {
    select: chain,
    insert: chain,
    update: chain,
    delete: chain,
    eq: chain,
    neq: chain,
    in: chain,
    gte: chain,
    lte: chain,
    or: chain,
    order: chain,
    limit: () => Promise.resolve({ data: [], error: null }),
    single: () => Promise.resolve({ data: null, error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (res: (v: unknown) => unknown) => res({ data: [], error: null }),
  });
  return {
    supabase: {
      from: () => builder,
      rpc: () => Promise.resolve({ data: null, error: null }),
      getChannels: () => [],
      channel: () => {
        const ch: Record<string, unknown> = {};
        Object.assign(ch, { on: () => ch, subscribe: () => ch });
        return ch;
      },
      removeChannel: () => {},
    },
  };
});

function mockAuth(featureOn: boolean) {
  const flags = featureOn
    ? { [ORGANIZATION_FEATURE_KEYS.employee_transfer_history]: true }
    : {};
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "emp-1" },
    userRole: "employee",
    organizationId: "org-1",
    isAccountantCashier: false,
    userBalance: 18250,
    refreshBalance: vi.fn(),
    organizationFeatureFlags: flags,
    isTenantHost: false,
    tenantHostOrgId: null,
    hasOrganizationFeature: (key: string) => flags[key] === true,
  } as unknown as ReturnType<typeof useAuth>);
}

const renderDashboard = () =>
  render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );

/** The Card element wrapping the Current Balance figure. */
async function currentBalanceCard() {
  const value = await screen.findByText("₹18,250.00");
  const card = value.closest("div.rounded-lg");
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Dashboard Current Balance card", () => {
  it("is not clickable when the feature is off", async () => {
    mockAuth(false);
    renderDashboard();

    const card = await currentBalanceCard();
    expect(card.className).not.toContain("cursor-pointer");

    fireEvent.click(card);
    expect(navigateMock).not.toHaveBeenCalledWith("/balance-history");
  });

  it("navigates to /balance-history when the feature is on", async () => {
    mockAuth(true);
    renderDashboard();

    const card = await currentBalanceCard();
    expect(card.className).toContain("cursor-pointer");

    fireEvent.click(card);
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/balance-history"),
    );
  });

  it("keeps the balance value unchanged when the feature is on", async () => {
    mockAuth(true);
    renderDashboard();
    // Same authoritative value as with the feature off — only the affordance changed.
    expect(await screen.findByText("₹18,250.00")).toBeInTheDocument();
  });
});
