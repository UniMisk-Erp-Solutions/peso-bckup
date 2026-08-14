import { describe, it, expect } from "vitest";
import { reportKeys } from "@/lib/reportQueryKeys";

describe("reportQueryKeys", () => {
  const ORG = "org-abc";
  const SCOPE_ORG = "org";
  const SCOPE_TEAM = "team:user-1,user-2,user-3";

  // ── reportKeys.all ──────────────────────────────────────────────────────────

  describe("all", () => {
    it("returns two-element array prefixed with 'reports'", () => {
      expect(reportKeys.all(ORG)).toEqual(["reports", ORG]);
    });

    it("is a prefix of every other key shape", () => {
      const allKey = reportKeys.all(ORG);
      const vKey = reportKeys.verification(ORG, SCOPE_ORG, "all", "all", "all");
      expect(vKey.slice(0, allKey.length)).toEqual(allKey);
    });

    it("differs between orgs", () => {
      expect(reportKeys.all("org-1")).not.toEqual(reportKeys.all("org-2"));
    });
  });

  // ── reportKeys.verification ─────────────────────────────────────────────────

  describe("verification", () => {
    const base = () =>
      reportKeys.verification(ORG, SCOPE_ORG, "all", "all", "pending");

    it("includes 'verification' segment", () => {
      expect(base()).toContain("verification");
    });

    it("org isolation: different orgId → different key", () => {
      const a = reportKeys.verification("org-1", SCOPE_ORG, "all", "all", "pending");
      const b = reportKeys.verification("org-2", SCOPE_ORG, "all", "all", "pending");
      expect(a).not.toEqual(b);
    });

    it("scope isolation: 'org' vs team scope → different key", () => {
      const a = reportKeys.verification(ORG, SCOPE_ORG, "all", "all", "pending");
      const b = reportKeys.verification(ORG, SCOPE_TEAM, "all", "all", "pending");
      expect(a).not.toEqual(b);
    });

    it("employee filter changes key", () => {
      const a = reportKeys.verification(ORG, SCOPE_ORG, "user-1", "all", "pending");
      const b = reportKeys.verification(ORG, SCOPE_ORG, "all", "all", "pending");
      expect(a).not.toEqual(b);
    });

    it("category filter changes key", () => {
      const a = reportKeys.verification(ORG, SCOPE_ORG, "all", "travel", "pending");
      const b = reportKeys.verification(ORG, SCOPE_ORG, "all", "all", "pending");
      expect(a).not.toEqual(b);
    });

    it("engineerStatus filter changes key", () => {
      const a = reportKeys.verification(ORG, SCOPE_ORG, "all", "all", "pending");
      const b = reportKeys.verification(ORG, SCOPE_ORG, "all", "all", "approved");
      expect(a).not.toEqual(b);
    });

    it("same params → same key (deterministic)", () => {
      expect(base()).toEqual(base());
    });

    it("does NOT share prefix with approval key", () => {
      const v = reportKeys.verification(ORG, SCOPE_ORG, "all", "all", "pending");
      const a = reportKeys.approval(ORG, SCOPE_ORG, "all", "all", "pending");
      expect(v).not.toEqual(a);
    });
  });

  // ── reportKeys.approval ─────────────────────────────────────────────────────

  describe("approval", () => {
    const base = () =>
      reportKeys.approval(ORG, SCOPE_ORG, "all", "all", "pending");

    it("includes 'approval' segment", () => {
      expect(base()).toContain("approval");
    });

    it("deterministic for same inputs", () => {
      expect(base()).toEqual(base());
    });

    it("scope isolation works", () => {
      const a = reportKeys.approval(ORG, "org", "all", "all", "pending");
      const b = reportKeys.approval(ORG, "team:u1,u2", "all", "all", "pending");
      expect(a).not.toEqual(b);
    });
  });

  // ── reportKeys.detailed ─────────────────────────────────────────────────────

  describe("detailed", () => {
    const base = () =>
      reportKeys.detailed(ORG, SCOPE_ORG, "user-1", "all", "2026", "07", "all");

    it("includes 'detailed' segment", () => {
      expect(base()).toContain("detailed");
    });

    it("deterministic for same inputs", () => {
      expect(base()).toEqual(base());
    });

    it("year changes key", () => {
      const a = reportKeys.detailed(ORG, SCOPE_ORG, "user-1", "all", "2025", "07", "all");
      const b = reportKeys.detailed(ORG, SCOPE_ORG, "user-1", "all", "2026", "07", "all");
      expect(a).not.toEqual(b);
    });

    it("month changes key", () => {
      const a = reportKeys.detailed(ORG, SCOPE_ORG, "user-1", "all", "2026", "06", "all");
      const b = reportKeys.detailed(ORG, SCOPE_ORG, "user-1", "all", "2026", "07", "all");
      expect(a).not.toEqual(b);
    });

    it("week changes key", () => {
      const a = reportKeys.detailed(ORG, SCOPE_ORG, "user-1", "all", "2026", "07", "1");
      const b = reportKeys.detailed(ORG, SCOPE_ORG, "user-1", "all", "2026", "07", "2");
      expect(a).not.toEqual(b);
    });

    it("employee changes key", () => {
      const a = reportKeys.detailed(ORG, SCOPE_ORG, "user-A", "all", "2026", "07", "all");
      const b = reportKeys.detailed(ORG, SCOPE_ORG, "user-B", "all", "2026", "07", "all");
      expect(a).not.toEqual(b);
    });
  });

  // ── reportKeys.daily ────────────────────────────────────────────────────────

  describe("daily", () => {
    const base = () =>
      reportKeys.daily(ORG, SCOPE_ORG, "all", "range", "2026-07-01", "2026-07-14", '{"sig":1}');

    it("includes 'daily' segment", () => {
      expect(base()).toContain("daily");
    });

    it("deterministic for same inputs", () => {
      expect(base()).toEqual(base());
    });

    it("periodMode=all_time vs range → different key", () => {
      const a = reportKeys.daily(ORG, SCOPE_ORG, "all", "all_time", "", "", "none");
      const b = reportKeys.daily(ORG, SCOPE_ORG, "all", "range", "2026-07-01", "2026-07-14", '{}');
      expect(a).not.toEqual(b);
    });

    it("dateFrom changes key", () => {
      const a = reportKeys.daily(ORG, SCOPE_ORG, "all", "range", "2026-07-01", "2026-07-14", "sig");
      const b = reportKeys.daily(ORG, SCOPE_ORG, "all", "range", "2026-06-01", "2026-07-14", "sig");
      expect(a).not.toEqual(b);
    });

    it("dateTo changes key", () => {
      const a = reportKeys.daily(ORG, SCOPE_ORG, "all", "range", "2026-07-01", "2026-07-14", "sig");
      const b = reportKeys.daily(ORG, SCOPE_ORG, "all", "range", "2026-07-01", "2026-07-31", "sig");
      expect(a).not.toEqual(b);
    });

    it("configSignature changes key", () => {
      const a = reportKeys.daily(ORG, SCOPE_ORG, "all", "all_time", "", "", '{"a":1}');
      const b = reportKeys.daily(ORG, SCOPE_ORG, "all", "all_time", "", "", '{"a":2}');
      expect(a).not.toEqual(b);
    });

    it("'none' configSignature for all_time period differs from config present", () => {
      const a = reportKeys.daily(ORG, SCOPE_ORG, "all", "all_time", "", "", "none");
      const b = reportKeys.daily(ORG, SCOPE_ORG, "all", "all_time", "", "", '{"projectField":"project_id"}');
      expect(a).not.toEqual(b);
    });
  });

  // ── cross-type uniqueness ────────────────────────────────────────────────────

  describe("cross-type uniqueness", () => {
    it("verification, approval, detailed, daily keys are all unique for same base params", () => {
      const v = reportKeys.verification(ORG, SCOPE_ORG, "all", "all", "all");
      const a = reportKeys.approval(ORG, SCOPE_ORG, "all", "all", "all");
      const d = reportKeys.detailed(ORG, SCOPE_ORG, "all", "all", "2026", "07", "all");
      const dy = reportKeys.daily(ORG, SCOPE_ORG, "all", "all_time", "", "", "none");
      const keys = [JSON.stringify(v), JSON.stringify(a), JSON.stringify(d), JSON.stringify(dy)];
      expect(new Set(keys).size).toBe(4);
    });

    it("all() key is a prefix of each specific key", () => {
      const allKey = reportKeys.all(ORG);
      const specifics = [
        reportKeys.verification(ORG, SCOPE_ORG, "all", "all", "all"),
        reportKeys.approval(ORG, SCOPE_ORG, "all", "all", "all"),
        reportKeys.detailed(ORG, SCOPE_ORG, "all", "all", "2026", "07", "all"),
        reportKeys.daily(ORG, SCOPE_ORG, "all", "all_time", "", "", "none"),
      ];
      for (const key of specifics) {
        expect(key.slice(0, allKey.length)).toEqual(allKey);
      }
    });
  });

  // ── scopeKey helpers ─────────────────────────────────────────────────────────

  describe("scopeKey isolation", () => {
    it("team scope with sorted IDs produces deterministic key regardless of order", () => {
      // Simulate sorted: "team:id-1,id-2,id-3"
      const sorted1 = ["id-1", "id-2", "id-3"].sort().join(",");
      const sorted2 = ["id-3", "id-1", "id-2"].sort().join(",");
      const scope1 = `team:${sorted1}`;
      const scope2 = `team:${sorted2}`;
      expect(scope1).toBe(scope2);
      const k1 = reportKeys.verification(ORG, scope1, "all", "all", "all");
      const k2 = reportKeys.verification(ORG, scope2, "all", "all", "all");
      expect(k1).toEqual(k2);
    });

    it("different team memberships produce different scope keys", () => {
      const k1 = reportKeys.verification(ORG, "team:u1,u2", "all", "all", "all");
      const k2 = reportKeys.verification(ORG, "team:u1,u2,u3", "all", "all", "all");
      expect(k1).not.toEqual(k2);
    });
  });
});
