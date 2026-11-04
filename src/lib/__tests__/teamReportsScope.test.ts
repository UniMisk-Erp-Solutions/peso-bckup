import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const getSession = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), auth: { getSession: () => getSession() } },
}));
const fetchMyTeamsOverview = vi.fn();
vi.mock("@/services/MyTeamsService", () => ({
  fetchMyTeamsOverview: (...a: unknown[]) => fetchMyTeamsOverview(...a),
}));

import { fetchTeamMemberUserIds, fetchTeamScopedExpenses } from "@/lib/teamReportsScope";

beforeEach(() => {
  rpc.mockReset();
  getSession.mockReset();
  fetchMyTeamsOverview.mockReset();
});

describe("fetchTeamMemberUserIds", () => {
  it("uses the server-derived scope, which always includes the caller", async () => {
    rpc.mockResolvedValue({ data: ["me"], error: null });
    const ids = await fetchTeamMemberUserIds("org-1");
    expect(rpc).toHaveBeenCalledWith("get_my_report_scope_v1", { p_organization_id: "org-1" });
    expect(ids).toEqual(["me"]);
  });

  it("a manager with zero team members still gets their own id (never empty)", async () => {
    rpc.mockResolvedValue({ data: ["me"], error: null });
    expect((await fetchTeamMemberUserIds("org-1")).length).toBe(1);
  });

  it("fails safe to self + My Teams when the scope RPC is not installed", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    getSession.mockResolvedValue({ data: { session: { user: { id: "me" } } } });
    fetchMyTeamsOverview.mockResolvedValue([{ members: [{ user_id: "a" }, { user_id: "b" }] }]);
    expect((await fetchTeamMemberUserIds("org-1")).sort()).toEqual(["a", "b", "me"]);
  });
});

describe("fetchTeamScopedExpenses", () => {
  it("does not short-circuit to an empty result for a manager with only themselves", async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: [{ id: "x", user_id: "me" }], error: null }) };
    const rows = await fetchTeamScopedExpenses({
      teamScoped: true,
      teamUserIds: ["me"],
      selectedEmployee: "all",
      buildQuery: () => {
        throw new Error("direct table path must not be used");
      },
      rpcOptions: { supabase: supabase as never, organizationId: "org-1" },
    });
    expect(rows).toHaveLength(1);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "get_team_expenses_for_members",
      expect.objectContaining({ p_user_ids: ["me"] }),
    );
  });

  it("does not request a user outside the provided scope", async () => {
    const supabase = { rpc: vi.fn() };
    const rows = await fetchTeamScopedExpenses({
      teamScoped: true,
      teamUserIds: ["me", "member"],
      selectedEmployee: "stranger",
      buildQuery: () => {
        throw new Error("unused");
      },
      rpcOptions: { supabase: supabase as never, organizationId: "org-1" },
    });
    expect(rows).toEqual([]);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
