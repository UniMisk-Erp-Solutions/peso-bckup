/**
 * Dashboard Month filter -- behavioural tests through the real Dashboard page.
 *
 * The Radix Select is replaced with a native <select> (jsdom cannot drive the
 * Radix popper); everything else -- month state, the RPC calls, the stale
 * guard, org-switch reset, card wording -- is the real Dashboard code.
 */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import Dashboard from "../Dashboard";
import { useAuth } from "@/contexts/AuthContext";

const h = vi.hoisted(() => ({ rpc: vi.fn() }));

// Interpolating i18n over the REAL en/dashboard.json (the global test mock does
// not interpolate {{vars}}, which is exactly the text these tests assert on).
vi.mock("react-i18next", async () => {
  const en = (await import("@/locales/en/dashboard.json")).default as Record<string, unknown>;
  const t = (key: string, opts?: Record<string, unknown>) => {
    const found = key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), en);
    const raw = typeof found === "string" ? found : typeof opts?.defaultValue === "string" ? opts.defaultValue : key;
    return raw.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(opts?.[k] ?? ""));
  };
  return {
    useTranslation: () => ({ t, i18n: { language: "en", changeLanguage: vi.fn() } }),
    initReactI18next: { type: "3rdParty", init: vi.fn() },
    I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
    Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  };
});

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => vi.fn() };
});
vi.mock("@/hooks/useDashboardTheme", () => ({ useDashboardTheme: () => ["default", vi.fn()] }));
vi.mock("@/hooks/useDashboardBackendHealth", () => ({ useDashboardBackendHealth: () => ({ state: "healthy", checkedAt: null }) }));
vi.mock("@/hooks/useAllowCashierExpenseSubmission", () => ({ useAllowCashierExpenseSubmission: () => ({ allowCashierExpenseSubmission: null }) }));
vi.mock("@/components/DashboardPendingTransferOffers", () => ({ DashboardPendingTransferOffers: () => null }));

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

vi.mock("@/integrations/supabase/client", () => {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  Object.assign(builder, {
    select: chain, insert: chain, update: chain, delete: chain, eq: chain, neq: chain, in: chain,
    gte: chain, lte: chain, or: chain, order: chain, is: chain,
    limit: () => builder,
    single: () => Promise.resolve({ data: null, error: null }),
    maybeSingle: () => Promise.resolve({ data: { trip_start: "2026-06-10", balance: 0 }, error: null }),
    then: (res: (v: unknown) => unknown) => res({ data: [], error: null }),
  });
  return {
    supabase: {
      from: () => builder,
      rpc: (fn: string, args: Record<string, unknown>) => {
        const p = Promise.resolve(h.rpc(fn, args));
        const th: Record<string, unknown> = { then: (a: never, b: never) => p.then(a, b), abortSignal: () => th };
        return th;
      },
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

function payload(over: Record<string, unknown>) {
  return {
    data: {
      total_amount: 0, expense_count: 0, pending_amount: 0, approved_amount: 0,
      pending_approvals: 0, pending_approvals_amount: 0, pending_reviews: null, pending_reviews_amount: null,
      current_balance: 0, role_balance_totals: null,
      scope: { balance_basis: "live", balance_as_of: null },
      ...over,
    },
    error: null,
  };
}

const ALL = payload({ expense_count: 42, pending_amount: 700, current_balance: 18250 });
const AUG = payload({
  expense_count: 7, pending_amount: 120, current_balance: 9999,
  scope: { balance_basis: "month_end", balance_as_of: "2026-08-31" },
});
const SEP = payload({ expense_count: 3, pending_amount: 50, current_balance: 18250, scope: { balance_basis: "live", balance_as_of: null } });

function mockAuth(orgId = "org-1", userId = "emp-1") {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: userId }, userRole: "employee", organizationId: orgId, isAccountantCashier: false,
    userBalance: 18250, refreshBalance: vi.fn(), organizationFeatureFlags: {}, isTenantHost: false, tenantHostOrgId: null,
    hasOrganizationFeature: () => false,
  } as unknown as ReturnType<typeof useAuth>);
}

const renderDashboard = () => render(<MemoryRouter><Dashboard /></MemoryRouter>);
const select = () => screen.findByTestId("month-select") as Promise<HTMLSelectElement>;
const statsCalls = () => h.rpc.mock.calls.filter((c) => c[0] === "get_dashboard_stats_v2").map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-25T10:00:00Z"));
  h.rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
    if (fn !== "get_dashboard_stats_v2") return { data: null, error: null };
    if (!args.p_month_from) return ALL;
    return args.p_month_from === "2026-08-01" ? AUG : SEP;
  });
  mockAuth();
});
afterEach(() => vi.useRealTimers());

describe("Dashboard Month filter (real page)", () => {
  it("defaults to All time and asks the server for no month bounds", async () => {
    renderDashboard();
    const sel = await select();
    await waitFor(() => expect(statsCalls().length).toBeGreaterThan(0));
    expect(sel.value).toBe("all");
    expect(statsCalls()[0]).toMatchObject({ p_organization_id: "org-1", p_month_from: null, p_month_to_exclusive: null });
    expect(screen.getByTestId("dashboard-month-scope").textContent).toContain("Showing all time");
    // employee All time: live balance, existing wording
    expect(await screen.findByText("₹18,250.00")).toBeInTheDocument();
  });

  it("offers All time + months back to the earliest expense, newest first, friendly labels", async () => {
    renderDashboard();
    const sel = await select();
    await waitFor(() => expect(Array.from(sel.options).length).toBeGreaterThan(1));
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual([
      "All time", "September 2026", "August 2026", "July 2026", "June 2026",
    ]);
  });

  it("selecting August sends exact bounds and shows month-end balance, NOT the live balance", async () => {
    renderDashboard();
    const sel = await select();
    await waitFor(() => expect(Array.from(sel.options).length).toBeGreaterThan(1));
    fireEvent.change(sel, { target: { value: "2026-08" } });
    await waitFor(() => expect(statsCalls().some((c) => c.p_month_from === "2026-08-01")).toBe(true));
    expect(statsCalls().find((c) => c.p_month_from === "2026-08-01")).toMatchObject({ p_month_to_exclusive: "2026-09-01" });
    // month-end balance replaces the live auth-context balance (18,250)
    expect(await screen.findByText("₹9,999.00")).toBeInTheDocument();
    expect(screen.getByText("Balance as of 31 Aug 2026")).toBeInTheDocument();
    expect(screen.getByText("Pending in August 2026")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-month-scope").textContent).toContain("Showing August 2026");
    expect(screen.queryByText("₹18,250.00")).toBeNull();
  });

  it("the current month keeps the live balance, labelled as of today", async () => {
    renderDashboard();
    const sel = await select();
    await waitFor(() => expect(Array.from(sel.options).length).toBeGreaterThan(1));
    fireEvent.change(sel, { target: { value: "2026-09" } });
    expect(await screen.findByText("Balance as of today")).toBeInTheDocument();
    expect(screen.getByText("₹18,250.00")).toBeInTheDocument();
  });

  it("switching back to All time restores the original values", async () => {
    renderDashboard();
    const sel = await select();
    await waitFor(() => expect(Array.from(sel.options).length).toBeGreaterThan(1));
    fireEvent.change(sel, { target: { value: "2026-08" } });
    expect(await screen.findByText("₹9,999.00")).toBeInTheDocument();
    fireEvent.change(sel, { target: { value: "all" } });
    expect(await screen.findByText("₹18,250.00")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-month-scope").textContent).toContain("Showing all time");
  });

  it("a slow August response arriving after September was selected cannot overwrite September", async () => {
    let releaseAug!: () => void;
    const augGate = new Promise<void>((r) => { releaseAug = r; });
    h.rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn !== "get_dashboard_stats_v2") return { data: null, error: null };
      if (!args.p_month_from) return ALL;
      if (args.p_month_from === "2026-08-01") return augGate.then(() => AUG);
      return SEP;
    });
    renderDashboard();
    const sel = await select();
    await waitFor(() => expect(Array.from(sel.options).length).toBeGreaterThan(1));
    fireEvent.change(sel, { target: { value: "2026-08" } });
    fireEvent.change(sel, { target: { value: "2026-09" } });
    await screen.findByText("Balance as of today");
    await act(async () => { releaseAug(); await augGate; });
    expect(screen.getByTestId("dashboard-month-scope").textContent).toContain("Showing September 2026");
    expect(screen.queryByText("Balance as of 31 Aug 2026")).toBeNull();
    expect(screen.queryByText("₹9,999.00")).toBeNull();
  });

  it("a different organization starts at All time (no month carried over)", async () => {
    const { rerender } = renderDashboard();
    const sel = await select();
    await waitFor(() => expect(Array.from(sel.options).length).toBeGreaterThan(1));
    fireEvent.change(sel, { target: { value: "2026-08" } });
    await screen.findByText("Balance as of 31 Aug 2026");
    mockAuth("org-2", "emp-1");
    rerender(<MemoryRouter><Dashboard /></MemoryRouter>);
    await waitFor(() => expect(statsCalls().some((c) => c.p_organization_id === "org-2")).toBe(true));
    expect(statsCalls().filter((c) => c.p_organization_id === "org-2").every((c) => c.p_month_from === null)).toBe(true);
    expect((await select()).value).toBe("all");
  });

  it("a failed month load restores the previous period instead of lying about the month", async () => {
    h.rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn !== "get_dashboard_stats_v2") return { data: null, error: null };
      if (!args.p_month_from) return ALL;
      return { data: null, error: { message: "boom" } };
    });
    renderDashboard();
    const sel = await select();
    await waitFor(() => expect(Array.from(sel.options).length).toBeGreaterThan(1));
    fireEvent.change(sel, { target: { value: "2026-08" } });
    await waitFor(() => expect(sel.value).toBe("all"));
    expect(screen.getByTestId("dashboard-month-scope").textContent).toContain("Showing all time");
  });
});
