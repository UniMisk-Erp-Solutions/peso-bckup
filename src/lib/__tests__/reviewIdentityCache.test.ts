import { describe, expect, it, vi } from "vitest";
import {
  ReviewIdentityStore,
  applyReviewRowIdentity,
  type IdentityProfile,
} from "@/lib/reviewIdentityCache";

// Mirrors the real resolver: profile employee_id wins, else parse synthetic email.
const resolveEmployeeId = (id: string | null | undefined, email: string | null | undefined) => {
  const fromProfile = id?.trim();
  if (fromProfile) return fromProfile;
  const m = (email ?? "").match(/^emp\.[^.]+\.([^.]+)\./i);
  return m?.[1]?.trim() ?? "";
};

const profile = (over: Partial<IdentityProfile> & { user_id: string }): IdentityProfile => ({
  name: null,
  email: null,
  employee_id: null,
  balance: null,
  ...over,
});

type Row = {
  id: string;
  user_id: string;
  user_name?: string;
  user_email?: string;
  user_employee_id?: string;
  user_balance?: number;
};
const row = (id: string, user_id: string): Row => ({ id, user_id, user_name: "", user_employee_id: undefined });

describe("ReviewIdentityStore.pending", () => {
  it("returns unique unresolved user_ids and excludes resolved / failed", async () => {
    const store = new ReviewIdentityStore();
    expect(store.pending(["a", "a", "b"])).toEqual(["a", "b"]);
    await store.resolve(["a"], async () => [profile({ user_id: "a", name: "A" })]);
    expect(store.pending(["a", "b"])).toEqual(["b"]);
  });
});

describe("ReviewIdentityStore.resolve — caches on success, keyed by user_id", () => {
  it("caches every returned profile and reports newlyResolved", async () => {
    const store = new ReviewIdentityStore();
    const out = await store.resolve(["a", "b"], async (ids) =>
      ids.map((id) => profile({ user_id: id, name: id.toUpperCase(), employee_id: `E-${id}` })),
    );
    expect(out.newlyResolved.sort()).toEqual(["a", "b"]);
    expect(store.get("a")?.name).toBe("A");
    expect(store.status("b")).toBe("resolved");
  });

  it("de-duplicates concurrent resolves so the fetcher runs once per user", async () => {
    const store = new ReviewIdentityStore();
    const fetcher = vi.fn(async (ids: string[]) => ids.map((id) => profile({ user_id: id, name: id })));
    await Promise.all([store.resolve(["a"], fetcher), store.resolve(["a"], fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// The load-bearing regression: the OLD effect discarded a whole run (including
// the fetched profiles) when a later render superseded it, and left the ids
// marked so they never retried. Here a later resolve happens WHILE user B/C are
// in flight; when they resolve they must still be cached and must patch rows.
describe("superseded run still resolves (screenshot 10585-10589 regression)", () => {
  it("a resolution that completes after a newer run still caches and patches every matching row", async () => {
    const store = new ReviewIdentityStore();

    // Run A: users B and C, deliberately slow.
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const runA = store.resolve(["B", "C"], async (ids) => {
      await gateA;
      return ids.map((id) =>
        profile({ user_id: id, name: id === "B" ? "Avesh Khan" : "Nirav Pandya", employee_id: id === "B" ? "6736" : "6697" }),
      );
    });

    // Run B supersedes with a different user that resolves immediately.
    await store.resolve(["A"], async () => [profile({ user_id: "A", name: "Sahil", employee_id: "6721" })]);

    // Now A completes — its profiles must NOT be discarded.
    releaseA();
    const outA = await runA;
    expect(outA.newlyResolved.sort()).toEqual(["B", "C"]);

    // Apply identity to the exact screenshot rows — all must populate, none "—".
    const rows: Row[] = [
      row("10589", "B"),
      row("10587", "B"),
      row("10586", "C"),
      row("10585", "C"),
    ].map((r) => applyReviewRowIdentity(r, store, resolveEmployeeId));

    expect(rows.map((r) => [r.user_name, r.user_employee_id])).toEqual([
      ["Avesh Khan", "6736"],
      ["Avesh Khan", "6736"],
      ["Nirav Pandya", "6697"],
      ["Nirav Pandya", "6697"],
    ]);
  });
});

describe("same-user batch consistency (§21)", () => {
  it("one lookup populates all rows sharing a user_id — never partial within a batch", async () => {
    const store = new ReviewIdentityStore();
    const fetcher = vi.fn(async (ids: string[]) => ids.map((id) => profile({ user_id: id, name: "Avesh Khan", employee_id: "6736" })));
    // Five batch rows, one user.
    const rows = ["r1", "r2", "r3", "r4", "r5"].map((id) => row(id, "B"));
    await store.resolve([...new Set(rows.map((r) => r.user_id))], fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(["B"]);
    const patched = rows.map((r) => applyReviewRowIdentity(r, store, resolveEmployeeId));
    for (const r of patched) {
      expect(r.user_name).toBe("Avesh Khan");
      expect(r.user_employee_id).toBe("6736");
    }
  });
});

describe("failure is retryable, never a permanent placeholder (§20)", () => {
  it("does not mark resolved on fetch error, does not auto-retry, and resolves after clearFailures", async () => {
    const store = new ReviewIdentityStore();
    const failing = vi.fn(async () => {
      throw new Error("network");
    });
    const first = await store.resolve(["B"], failing);
    expect(first.newlyResolved).toEqual([]);
    expect(first.failed).toEqual(["B"]);
    expect(store.status("B")).toBe("failed");

    // No auto-retry: a failed user is not "pending" until failures are cleared.
    expect(store.pending(["B"])).toEqual([]);

    // Explicit retry path.
    store.clearFailures();
    expect(store.pending(["B"])).toEqual(["B"]);
    const ok = vi.fn(async (ids: string[]) => ids.map((id) => profile({ user_id: id, name: "Avesh Khan", employee_id: "6736" })));
    const second = await store.resolve(["B"], ok);
    expect(second.newlyResolved).toEqual(["B"]);
    const r = applyReviewRowIdentity(row("10589", "B"), store, resolveEmployeeId);
    expect(r.user_name).toBe("Avesh Khan");
  });

  it("a user absent from an otherwise-successful response is retryable, and present users still resolve", async () => {
    const store = new ReviewIdentityStore();
    // Ask for B and C; the fetch only returns B.
    const out = await store.resolve(["B", "C"], async () => [profile({ user_id: "B", name: "Avesh Khan" })]);
    expect(out.newlyResolved).toEqual(["B"]);
    expect(out.failed).toEqual(["C"]);
    expect(store.get("B")?.name).toBe("Avesh Khan");
    expect(store.status("C")).toBe("failed");
  });
});

describe("applyReviewRowIdentity", () => {
  it("returns the same object reference when nothing changed (no needless re-render)", async () => {
    const store = new ReviewIdentityStore();
    await store.resolve(["B"], async () => [profile({ user_id: "B", name: "Avesh Khan", employee_id: "6736", balance: 10 })]);
    const first = applyReviewRowIdentity(row("10589", "B"), store, resolveEmployeeId);
    const second = applyReviewRowIdentity(first, store, resolveEmployeeId);
    expect(second).toBe(first);
  });

  it("leaves a row untouched when its user is unresolved", () => {
    const store = new ReviewIdentityStore();
    const r = row("10589", "B");
    expect(applyReviewRowIdentity(r, store, resolveEmployeeId)).toBe(r);
  });
});
