import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn() },
}));

import { supabase } from "@/integrations/supabase/client";
import {
  isEligibleBaseFieldForMemory,
  isEligibleCustomFieldType,
  memoryFieldKey,
  normalizeFieldValue,
  fetchRecentExpenseFieldValues,
  recordRecentExpenseFieldValues,
  getRecentValuesVersion,
} from "@/lib/expenseFieldMemory";

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

describe("isEligibleBaseFieldForMemory", () => {
  it("is eligible for title/destination/purpose with default or text input_type", () => {
    expect(isEligibleBaseFieldForMemory("title", "default")).toBe(true);
    expect(isEligibleBaseFieldForMemory("destination", "text")).toBe(true);
    expect(isEligibleBaseFieldForMemory("purpose", "default")).toBe(true);
  });

  it("is never eligible for category/expense_date/amount regardless of input_type", () => {
    expect(isEligibleBaseFieldForMemory("category", "default")).toBe(false);
    expect(isEligibleBaseFieldForMemory("category", "text")).toBe(false);
    expect(isEligibleBaseFieldForMemory("expense_date", "default")).toBe(false);
    expect(isEligibleBaseFieldForMemory("amount", "text")).toBe(false);
  });

  it("is not eligible for title/destination/purpose when overridden to dropdown or number", () => {
    expect(isEligibleBaseFieldForMemory("title", "dropdown")).toBe(false);
    expect(isEligibleBaseFieldForMemory("destination", "number")).toBe(false);
  });
});

describe("isEligibleCustomFieldType", () => {
  it("accepts text and textarea only", () => {
    expect(isEligibleCustomFieldType("text")).toBe(true);
    expect(isEligibleCustomFieldType("textarea")).toBe(true);
  });

  it("rejects select (DOC-003's turf), number, date, checkbox", () => {
    expect(isEligibleCustomFieldType("select")).toBe(false);
    expect(isEligibleCustomFieldType("number")).toBe(false);
    expect(isEligibleCustomFieldType("date")).toBe(false);
    expect(isEligibleCustomFieldType("checkbox")).toBe(false);
  });
});

describe("memoryFieldKey", () => {
  it("namespaces by kind so identical uuids across kinds never collide", () => {
    expect(memoryFieldKey("system", "title")).toBe("system:title");
    expect(memoryFieldKey("custom", "abc-123")).toBe("custom:abc-123");
    expect(memoryFieldKey("branch", "abc-123")).toBe("branch:abc-123");
    expect(memoryFieldKey("custom", "abc-123")).not.toBe(memoryFieldKey("branch", "abc-123"));
  });
});

describe("normalizeFieldValue", () => {
  it("trims, collapses internal whitespace, and casefolds", () => {
    expect(normalizeFieldValue("  Ahmedabad   Office  ")).toBe("ahmedabad office");
    expect(normalizeFieldValue("AHMEDABAD OFFICE")).toBe("ahmedabad office");
    expect(normalizeFieldValue("Ahmedabad Office")).toBe("ahmedabad office");
  });

  it("does not merge genuinely different values", () => {
    expect(normalizeFieldValue("Sanand GIDC")).not.toBe(normalizeFieldValue("Sanand G.I.D.C"));
  });
});

describe("fetchRecentExpenseFieldValues", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("returns {} without calling the RPC when org/user/identities are missing", async () => {
    expect(await fetchRecentExpenseFieldValues(null, "u1", ["system:title"])).toEqual({});
    expect(await fetchRecentExpenseFieldValues("o1", null, ["system:title"])).toEqual({});
    expect(await fetchRecentExpenseFieldValues("o1", "u1", [])).toEqual({});
    expect(rpc).not.toHaveBeenCalled();
  });

  it("groups rows by field_identity", async () => {
    rpc.mockResolvedValue({
      data: [
        { field_identity: "system:destination", display_value: "Ahmedabad", normalized_value: "ahmedabad", last_used_at: "2026-01-01", usage_count: 3 },
        { field_identity: "system:destination", display_value: "Surat", normalized_value: "surat", last_used_at: "2026-01-02", usage_count: 1 },
        { field_identity: "system:title", display_value: "Fuel", normalized_value: "fuel", last_used_at: "2026-01-01", usage_count: 2 },
      ],
      error: null,
    });
    const result = await fetchRecentExpenseFieldValues("o1", "u1", ["system:destination", "system:title"]);
    expect(result["system:destination"]).toEqual(["Ahmedabad", "Surat"]);
    expect(result["system:title"]).toEqual(["Fuel"]);
  });

  it("degrades to {} on RPC error rather than throwing", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    // Distinct org/user from other tests -- the module caches successful
    // results per (org,user) for 60s, so reusing "o1"/"u1" here would return
    // the previous test's cached data instead of exercising this mock.
    await expect(fetchRecentExpenseFieldValues("o2", "u2", ["system:title"])).resolves.toEqual({});
  });

  it("degrades to {} when the RPC call itself rejects", async () => {
    rpc.mockRejectedValue(new Error("network down"));
    await expect(fetchRecentExpenseFieldValues("o3", "u3", ["system:title"])).resolves.toEqual({});
  });

  describe("cache identity isolation (owner memory-provenance audit, 2026-09-23)", () => {
    // The owner's audit required proving -- not just asserting by reading the
    // source -- that switching the authenticated user or organization can
    // never serve a previous identity's cached memory rows. The cache key is
    // `${organizationId}:${userId}` (see _cacheKey); these tests exercise the
    // PUBLIC fetch path end-to-end rather than reaching into the private map.

    /** Mirrors expenseFieldMemory.ts's private RecentRow shape -- not exported. */
    type TestRecentRow = {
      field_identity: string;
      display_value: string;
      normalized_value: string;
      last_used_at: string;
      usage_count: number;
    };

    /** Row a given (org, user) "owns" for these isolation tests, name-dispatched
     *  so bootstrap's own extra RPC call (fired once per never-seen-before
     *  pair) never displaces the read RPC's intended response. */
    function mockServerRowsByIdentity(rowsByKey: Record<string, TestRecentRow[]>) {
      rpc.mockImplementation((name: string, params: { p_organization_id: string }) => {
        if (name === "bootstrap_my_expense_field_memory_v1") {
          return Promise.resolve({ data: null, error: null });
        }
        // get_recent_expense_field_values_v1 only receives p_organization_id
        // (the user comes from auth.uid() server-side) -- these tests key
        // purely on organization_id, which is enough to prove no cross-org
        // leakage; the cross-user case below keys on the same org and
        // relies on call ORDER instead, since two different users would
        // both pass identical params here in real life too.
        return Promise.resolve({ data: rowsByKey[params.p_organization_id] ?? [], error: null });
      });
    }

    it("a different user in the SAME org never receives the first user's cached rows, and re-fetches from the server", async () => {
      let currentUserRows: TestRecentRow[] = [
        { field_identity: "system:purpose", display_value: "User A's purpose", normalized_value: "user a's purpose", last_used_at: "2026-01-01", usage_count: 1 },
      ];
      rpc.mockImplementation((name: string) => {
        if (name === "bootstrap_my_expense_field_memory_v1") return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: currentUserRows, error: null });
      });

      const userA = await fetchRecentExpenseFieldValues("cache-iso-org", "cache-iso-user-a", ["system:purpose"]);
      expect(userA["system:purpose"]).toEqual(["User A's purpose"]);

      const readCallsAfterA = rpc.mock.calls.filter((c) => c[0] === "get_recent_expense_field_values_v1").length;

      currentUserRows = [
        { field_identity: "system:purpose", display_value: "User B's purpose", normalized_value: "user b's purpose", last_used_at: "2026-01-01", usage_count: 1 },
      ];
      const userB = await fetchRecentExpenseFieldValues("cache-iso-org", "cache-iso-user-b", ["system:purpose"]);

      // A genuinely fresh read RPC call was made for user B -- the cache did
      // NOT short-circuit to user A's cached entry (different cache key:
      // same organization_id but a different userId).
      const readCallsAfterB = rpc.mock.calls.filter((c) => c[0] === "get_recent_expense_field_values_v1").length;
      expect(readCallsAfterB).toBe(readCallsAfterA + 1);

      expect(userB["system:purpose"]).toEqual(["User B's purpose"]);
      expect(userB["system:purpose"]).not.toEqual(userA["system:purpose"]);
    });

    it("the SAME user switching organizations never receives the previous org's cached rows", async () => {
      mockServerRowsByIdentity({
        "cache-iso-org-1": [{ field_identity: "system:destination", display_value: "Org One Site", normalized_value: "org one site", last_used_at: "2026-01-01", usage_count: 1 }],
        "cache-iso-org-2": [{ field_identity: "system:destination", display_value: "Org Two Site", normalized_value: "org two site", last_used_at: "2026-01-01", usage_count: 1 }],
      });

      const orgOne = await fetchRecentExpenseFieldValues("cache-iso-org-1", "cache-iso-shared-user", ["system:destination"]);
      expect(orgOne["system:destination"]).toEqual(["Org One Site"]);

      const orgTwo = await fetchRecentExpenseFieldValues("cache-iso-org-2", "cache-iso-shared-user", ["system:destination"]);
      expect(orgTwo["system:destination"]).toEqual(["Org Two Site"]);
      expect(orgTwo["system:destination"]).not.toEqual(orgOne["system:destination"]);

      // Switching back must not have been corrupted by the intervening
      // org-two fetch either -- still isolated per (org, user).
      const orgOneAgain = await fetchRecentExpenseFieldValues("cache-iso-org-1", "cache-iso-shared-user", ["system:destination"]);
      expect(orgOneAgain["system:destination"]).toEqual(["Org One Site"]);
    });

    it("re-fetching the SAME (org, user) within the TTL is served from cache -- no redundant read RPC", async () => {
      mockServerRowsByIdentity({
        "cache-iso-hit-org": [{ field_identity: "system:title", display_value: "Cached Title", normalized_value: "cached title", last_used_at: "2026-01-01", usage_count: 1 }],
      });

      await fetchRecentExpenseFieldValues("cache-iso-hit-org", "cache-iso-hit-user", ["system:title"]);
      const readCallsAfterFirst = rpc.mock.calls.filter((c) => c[0] === "get_recent_expense_field_values_v1").length;

      const second = await fetchRecentExpenseFieldValues("cache-iso-hit-org", "cache-iso-hit-user", ["system:title"]);
      const readCallsAfterSecond = rpc.mock.calls.filter((c) => c[0] === "get_recent_expense_field_values_v1").length;

      expect(readCallsAfterSecond).toBe(readCallsAfterFirst);
      expect(second["system:title"]).toEqual(["Cached Title"]);
    });
  });

  describe("self-bootstrap (owner QA fix pass -- an enabled feature with real history should not stay empty forever)", () => {
    it("calls bootstrap_my_expense_field_memory_v1 before the read RPC on the first read for a (org, user)", async () => {
      rpc.mockResolvedValue({ data: [], error: null });
      await fetchRecentExpenseFieldValues("o-bootstrap-1", "u-bootstrap-1", ["system:destination"]);
      const calledNames = rpc.mock.calls.map((c) => c[0]);
      expect(calledNames).toContain("bootstrap_my_expense_field_memory_v1");
      expect(calledNames).toContain("get_recent_expense_field_values_v1");
      expect(calledNames.indexOf("bootstrap_my_expense_field_memory_v1"))
        .toBeLessThan(calledNames.indexOf("get_recent_expense_field_values_v1"));
      const bootstrapCall = rpc.mock.calls.find((c) => c[0] === "bootstrap_my_expense_field_memory_v1");
      expect(bootstrapCall?.[1]).toEqual({ p_organization_id: "o-bootstrap-1" });
    });

    it("does not repeat the bootstrap RPC on a second read for the same (org, user) within the same tab session", async () => {
      rpc.mockResolvedValue({ data: [], error: null });
      await fetchRecentExpenseFieldValues("o-bootstrap-2", "u-bootstrap-2", ["system:title"]);
      rpc.mockClear();
      await fetchRecentExpenseFieldValues("o-bootstrap-2", "u-bootstrap-2", ["system:title"]);
      const calledNames = rpc.mock.calls.map((c) => c[0]);
      expect(calledNames).not.toContain("bootstrap_my_expense_field_memory_v1");
    });

    it("a bootstrap RPC failure never blocks or throws from the read path", async () => {
      rpc.mockImplementation((name: string) => {
        if (name === "bootstrap_my_expense_field_memory_v1") {
          return Promise.resolve({ data: null, error: { message: "boom" } });
        }
        return Promise.resolve({
          data: [{ field_identity: "system:title", display_value: "Fuel", normalized_value: "fuel", last_used_at: "2026-01-01", usage_count: 1 }],
          error: null,
        });
      });
      const result = await fetchRecentExpenseFieldValues("o-bootstrap-3", "u-bootstrap-3", ["system:title"]);
      expect(result["system:title"]).toEqual(["Fuel"]);
    });
  });
});

describe("recordRecentExpenseFieldValues", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("never throws even when the RPC call rejects", async () => {
    rpc.mockRejectedValue(new Error("network down"));
    await expect(recordRecentExpenseFieldValues("o1", "u1", "e1")).resolves.toBeUndefined();
  });

  it("never throws even when the RPC returns an error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "not permitted" } });
    await expect(recordRecentExpenseFieldValues("o1", "u1", "e1")).resolves.toBeUndefined();
  });

  it("calls the RPC with the expense id", async () => {
    rpc.mockResolvedValue({ data: { ok: true, recorded: 2 }, error: null });
    await recordRecentExpenseFieldValues("o1", "u1", "e1");
    expect(rpc).toHaveBeenCalledWith("record_recent_expense_field_values_v1", { p_expense_id: "e1" });
  });

  it("bumps this (org, user)'s version on a successful record -- lets useRecentExpenseFieldValues refetch on the next render even without a component remount", async () => {
    const before = getRecentValuesVersion("o-version-test", "u-version-test");
    rpc.mockResolvedValue({ data: { ok: true, recorded: 1 }, error: null });
    await recordRecentExpenseFieldValues("o-version-test", "u-version-test", "e1");
    expect(getRecentValuesVersion("o-version-test", "u-version-test")).toBe(before + 1);
  });

  it("does not bump the version when the RPC call fails -- nothing was actually invalidated", async () => {
    const before = getRecentValuesVersion("o-version-fail", "u-version-fail");
    rpc.mockResolvedValue({ data: null, error: { message: "not permitted" } });
    await recordRecentExpenseFieldValues("o-version-fail", "u-version-fail", "e1");
    expect(getRecentValuesVersion("o-version-fail", "u-version-fail")).toBe(before);
  });
});

describe("getRecentValuesVersion", () => {
  it("returns 0 for an org/user with no org or user id", () => {
    expect(getRecentValuesVersion(null, "u1")).toBe(0);
    expect(getRecentValuesVersion("o1", null)).toBe(0);
    expect(getRecentValuesVersion(undefined, undefined)).toBe(0);
  });
});
