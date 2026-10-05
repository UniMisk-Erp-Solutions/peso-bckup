/**
 * useEmployeeBalanceLedger's own `enabled` contract, in isolation from
 * EmployeeBalanceHistory.tsx. This is the gate a real bug slipped through
 * once already: the hook originally only checked role/organizationId/user.id
 * and ignored the page's own Employee Balance History rollout flag, so an
 * employee whose organization has the feature switched off still triggered
 * a real network request for it (see EmployeeBalanceHistory.tsx's own
 * `if (!featureEnabled) return <Navigate .../>` -- that early return happens
 * AFTER every hook call, so only the hook's own `enabled` boolean can
 * actually prevent the request).
 */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEmployeeBalanceLedger } from "../useEmployeeBalanceLedger";
import { useAuth } from "@/contexts/AuthContext";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: vi.fn(),
}));

const rpcMock = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

function mockAuth(over: Partial<{ userRole: string; organizationId: string | null; userId: string | null }> = {}) {
  const { userRole = "employee", organizationId = "org-1", userId = "emp-1" } = over;
  vi.mocked(useAuth).mockReturnValue({
    userRole,
    organizationId,
    user: userId ? { id: userId } : null,
  } as unknown as ReturnType<typeof useAuth>);
}

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockResolvedValue({ data: [], error: null });
  mockAuth();
});

describe("useEmployeeBalanceLedger — enabled gate", () => {
  it("issues zero RPCs when featureEnabled is false, even for a valid employee", async () => {
    renderHook(() => useEmployeeBalanceLedger(1, 25, false), { wrapper });
    // Give any accidental async query a chance to fire before asserting.
    await new Promise((r) => setTimeout(r, 20));
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("issues the unified-ledger RPC when featureEnabled is true for a valid employee", async () => {
    renderHook(() => useEmployeeBalanceLedger(1, 25, true), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("get_my_unified_balance_timeline_v3", expect.any(Object)));
  });

  it("stays disabled for a non-employee role even when featureEnabled is true", async () => {
    mockAuth({ userRole: "admin" });
    renderHook(() => useEmployeeBalanceLedger(1, 25, true), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("stays disabled when organizationId is missing even when featureEnabled is true", async () => {
    mockAuth({ organizationId: null });
    renderHook(() => useEmployeeBalanceLedger(1, 25, true), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("stays disabled when the user id is missing even when featureEnabled is true", async () => {
    mockAuth({ userId: null });
    renderHook(() => useEmployeeBalanceLedger(1, 25, true), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
