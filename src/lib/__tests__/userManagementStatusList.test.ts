import { beforeEach, describe, expect, it, vi } from "vitest";

// Patidar Travels (Production, read-only audit): 17 active + 2 deactivated memberships. The Deactivated tab
// was empty because the list was filtered through an ACTIVE-ONLY role map. These tests pin the contract.
type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};

function builder(table: string) {
  let rows = [...(tables[table] ?? [])];
  const q: Record<string, unknown> = {};
  const api = {
    select: () => api,
    eq: (col: string, val: unknown) => { rows = rows.filter((r) => r[col] === val); return api; },
    in: (col: string, vals: unknown[]) => { rows = rows.filter((r) => vals.includes(r[col])); return api; },
    order: () => api,
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
  };
  void q;
  return api;
}
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: (t: string) => builder(t) } }));
vi.mock("@/lib/supabaseInQuery", () => ({
  fetchProfilesByUserIds: async (_c: unknown, org: string, ids: string[]) =>
    (tables.profiles ?? []).filter((p) => p.organization_id === org && ids.includes(p.user_id as string)),
}));

import { fetchUserManagementList, matchesUserStatus } from "@/lib/orgUsers";

const ORG = "org-patidar";
const OTHER = "org-other";
const profile = (id: string, extra: Row = {}) => ({
  user_id: id, organization_id: ORG, name: `U-${id}`, email: `${id}@x.test`, employee_id: null, balance: 0,
  is_active: true, deactivated_at: null, reporting_engineer_id: null, cashier_assigned_engineer_id: null,
  cashier_assigned_location_id: null, assigned_cashier_id: null, ...extra,
});

beforeEach(() => {
  tables = {
    profiles: [
      profile("a1"),
      profile("a2"),
      profile("d1", { is_active: false, deactivated_at: "2026-10-01" }), // deactivated, no supervisor / team
      profile("d2", { is_active: false, deactivated_at: "2026-10-03", balance: 14717 }),
      profile("gone"), // profile exists but the membership was removed
      profile("x1", { organization_id: OTHER }),
    ],
    organization_memberships: [
      { organization_id: ORG, user_id: "a1", role: "engineer", is_active: true },
      { organization_id: ORG, user_id: "a2", role: "admin", is_active: true },
      { organization_id: ORG, user_id: "d1", role: "engineer", is_active: false },
      { organization_id: ORG, user_id: "d2", role: "engineer", is_active: false },
      { organization_id: OTHER, user_id: "x1", role: "employee", is_active: true },
    ],
    team_members: [], teams: [], locations: [],
  };
});

describe("User Management list: active vs deactivated (Patidar Travels regression)", () => {
  it("returns deactivated members (they were dropped by the active-only role map)", async () => {
    const rows = await fetchUserManagementList(ORG);
    expect(rows.map((r) => r.user_id).sort()).toEqual(["a1", "a2", "d1", "d2"]);
  });

  it("Active tab: active only; Deactivated tab: inactive only; All: both", async () => {
    const rows = await fetchUserManagementList(ORG);
    expect(rows.filter((r) => matchesUserStatus(r, "active")).map((r) => r.user_id).sort()).toEqual(["a1", "a2"]);
    expect(rows.filter((r) => matchesUserStatus(r, "deactivated")).map((r) => r.user_id).sort()).toEqual(["d1", "d2"]);
    expect(rows.filter((r) => matchesUserStatus(r, "all"))).toHaveLength(4);
  });

  it("a removed user (no membership row) is hidden in every tab", async () => {
    const rows = await fetchUserManagementList(ORG);
    expect(rows.find((r) => r.user_id === "gone")).toBeUndefined();
  });

  it("another organisation's users never appear", async () => {
    const rows = await fetchUserManagementList(ORG);
    expect(rows.find((r) => r.user_id === "x1")).toBeUndefined();
  });

  it("a deactivated user with no team and no supervisor still renders with role and balance", async () => {
    const d2 = (await fetchUserManagementList(ORG)).find((r) => r.user_id === "d2")!;
    expect(d2.is_active).toBe(false);
    expect(d2.role).toBe("engineer");
    expect(d2.balance).toBe(14717);
    expect(d2.team_name).toBeUndefined();
    expect(d2.assigned_engineer_name).toBeUndefined();
  });

  it("no duplicates", async () => {
    const ids = (await fetchUserManagementList(ORG)).map((r) => r.user_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a membership/profile disagreement is shown as deactivated, never as active", async () => {
    tables.profiles[0] = profile("a1", { is_active: false });
    const a1 = (await fetchUserManagementList(ORG)).find((r) => r.user_id === "a1")!;
    expect(a1.is_active).toBe(false);
  });

  it("reactivation keeps the same membership row identity (state flips, user_id and role unchanged)", async () => {
    const before = (await fetchUserManagementList(ORG)).find((r) => r.user_id === "d1")!;
    tables.organization_memberships.find((m) => m.user_id === "d1")!.is_active = true;
    tables.profiles.find((p) => p.user_id === "d1")!.is_active = true;
    const after = (await fetchUserManagementList(ORG)).find((r) => r.user_id === "d1")!;
    expect(after.is_active).toBe(true);
    expect(after.role).toBe(before.role);
    expect((await fetchUserManagementList(ORG)).filter((r) => r.user_id === "d1")).toHaveLength(1);
  });
});
