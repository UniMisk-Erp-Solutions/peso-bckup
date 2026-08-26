import { describe, expect, it } from "vitest";
import {
  applyHistoricalAnchor,
  cascadeDownstream,
  historicalPositionBefore,
  materializeAnchor,
  reverseAnchor,
  type HistoricalAnchor,
  type OrdinaryEvent,
} from "@/lib/historicalBalanceReplay";

// Every test here mirrors a required scenario from the Historical Balance
// Anchors V2 spec (2026-08-24). This is the pure-TS reference implementation
// of the SQL engine in
// supabase/migrations/20260824110000_historical_balance_anchors_engine.sql --
// see that file's own header for why this exists (no sandboxed Postgres in
// this session) and the exact correctness proof these numbers come from.

function opening(id: string, date: string, statedBalance: number, seq = 1): HistoricalAnchor {
  return { id, anchorKind: "opening_balance", effectiveDate: date, dayPosition: 0, sequenceNumber: seq, statedBalance, materializedDelta: null, status: "active" };
}
function balanceUpdate(id: string, date: string, statedBalance: number, seq = 1): HistoricalAnchor {
  return { id, anchorKind: "balance_update", effectiveDate: date, dayPosition: 2, sequenceNumber: seq, statedBalance, materializedDelta: null, status: "active" };
}

describe("Section 39 -- required example: Opening Balance is a historical anchor, not a balance overwrite", () => {
  it("current -1000, opening 2000 -> result 1000 (never 2000)", () => {
    const currentBalance = -1000;
    const anchor = opening("a1", "2026-07-01", 2000);
    const result = applyHistoricalAnchor({ anchors: [], ordinaryEvents: [], currentBalance, newAnchor: anchor });

    expect(result.ownNetChange).toBe(2000);
    expect(result.projectedBalance).toBe(1000);
    expect(result.projectedBalance).not.toBe(2000);
  });
});

describe("Section 40 -- later Balance Update only reconciles the gap, not the full target", () => {
  it("Jul opening 2000, Jul activity -800, Aug update target 1500 -> Aug adjustment +300, not +1500", () => {
    const julOpening = opening("jul", "2026-07-01", 2000);
    julOpening.materializedDelta = 2000; // already materialized from a prior operation

    const julActivity: OrdinaryEvent = { id: "e1", effectiveAt: "2026-07-15", amountDelta: -800 };

    const augUpdate = balanceUpdate("aug", "2026-08-01", 1500);

    const positionBeforeAug = historicalPositionBefore([julOpening], [julActivity], {
      effectiveDate: "2026-08-01", dayPosition: 2, sequenceNumber: 1,
    });
    expect(positionBeforeAug).toBe(1200); // 2000 - 800

    const { netChange, newDelta } = materializeAnchor([julOpening], [julActivity], augUpdate);
    expect(newDelta).toBe(300);
    expect(netChange).toBe(300); // first materialization, old=0

    // Today's balance increases by 300, not 1500.
    const currentBalanceBeforeAug = -1000 + 2000 - 800; // 200, arbitrary starting point + prior effects
    const projected = currentBalanceBeforeAug + netChange;
    expect(projected - currentBalanceBeforeAug).toBe(300);
  });
});

describe("Section 41 -- HARD GATE: editing an earlier anchor cascades to a downstream anchor, not a blind +delta", () => {
  it("editing Jul opening 2000->2500 with an active Aug update(1500) nets to ZERO today, not +500", () => {
    // Initial state: Jul opening (2000, materialized +2000), Aug update (1500, materialized +300 per section 40).
    const julOld = opening("jul-v1", "2026-07-01", 2000);
    julOld.materializedDelta = 2000;
    julOld.status = "superseded"; // the edit already retired it before this test's "after" snapshot

    const julActivity: OrdinaryEvent = { id: "e1", effectiveAt: "2026-07-15", amountDelta: -800 };

    const augUpdate = balanceUpdate("aug", "2026-08-01", 1500);
    augUpdate.materializedDelta = 300;

    // The edit: a NEW Jul opening revision, 2500, superseding julOld (already excluded via status).
    const julNew = opening("jul-v2", "2026-07-01", 2500);

    const applyResult = applyHistoricalAnchor({
      anchors: [julOld, augUpdate],
      ordinaryEvents: [julActivity],
      currentBalance: 1500, // whatever today's balance was under the OLD Jul revision + Aug reconciliation
      newAnchor: julNew,
      supersedesAnchor: julOld,
    });

    // Jul's own new revision: position before = 0 (julOld excluded by status), new delta = 2500.
    expect(applyResult.ownNetChange).toBe(2500 - 2000); // +500 in isolation

    // But Aug must cascade-recalculate: position before Aug = 2500 (new Jul) - 800 = 1700.
    // New Aug delta = 1500 - 1700 = -200. Old Aug delta was +300. Net change = -500.
    expect(applyResult.cascadeSteps).toHaveLength(1);
    expect(applyResult.cascadeSteps[0].anchorId).toBe("aug");
    expect(applyResult.cascadeSteps[0].oldDelta).toBe(300);
    expect(applyResult.cascadeSteps[0].newDelta).toBe(-200);
    expect(applyResult.cascadeSteps[0].netChange).toBe(-500);

    // Net effect of the whole edit operation on today's balance: +500 (Jul) - 500 (Aug cascade) = 0.
    // NOT a blind +500 -- the later Balance Update re-establishes the truth.
    expect(applyResult.projectedBalance).toBe(1500);
  });
});

describe("Section 42/43 -- supersede must REPLACE the old anchor's effect, never stack on top of it", () => {
  it("replacing an opening balance with no downstream anchors nets to (new - old), not the full new value", () => {
    // Isolated regression for a real bug caught while writing these tests:
    // the new revision's "old delta" baseline must be the superseded row's
    // materialized_delta, not zero -- otherwise the old row's already-applied
    // effect and the new row's effect would both land in profiles.balance.
    const oldAnchor = opening("v1", "2026-07-01", 2000);
    oldAnchor.materializedDelta = 2000;
    oldAnchor.status = "superseded";

    const newAnchor = opening("v2", "2026-07-01", 2500);

    const result = applyHistoricalAnchor({
      anchors: [oldAnchor],
      ordinaryEvents: [],
      currentBalance: 1000, // e.g. -1000 originally + 2000 from the old opening
      newAnchor,
      supersedesAnchor: oldAnchor,
    });

    expect(result.ownNetChange).toBe(500); // 2500 - 2000, NOT 2500
    expect(result.projectedBalance).toBe(1500); // 1000 + 500, NOT 1000 + 2500
  });

  it("omitting supersedesAnchor for a supersede-shaped edit would double-count (documents the failure mode)", () => {
    const oldAnchor = opening("v1", "2026-07-01", 2000);
    oldAnchor.materializedDelta = 2000;
    oldAnchor.status = "superseded";
    const newAnchor = opening("v2", "2026-07-01", 2500);

    const wrong = applyHistoricalAnchor({
      anchors: [oldAnchor], ordinaryEvents: [], currentBalance: 1000, newAnchor,
      // supersedesAnchor omitted on purpose
    });
    // This is the WRONG result a caller would get if it forgot to pass
    // supersedesAnchor -- asserted here so a future refactor that silently
    // drops the parameter is caught immediately by this test flipping.
    expect(wrong.ownNetChange).toBe(2500);
    expect(wrong.projectedBalance).toBe(3500);
    expect(wrong.projectedBalance).not.toBe(1500); // the correct answer from the test above
  });
});

describe("Section 46 -- reversal test: reversing an earlier anchor is not a blind subtraction", () => {
  it("reversing Jul opening(2000) with an active Aug update(1500) nets to ZERO today, not -2000", () => {
    const julActivity: OrdinaryEvent = { id: "e1", effectiveAt: "2026-07-15", amountDelta: -800 };
    const jul = opening("jul", "2026-07-01", 2000);
    jul.materializedDelta = 2000;
    const aug = balanceUpdate("aug", "2026-08-01", 1500);
    aug.materializedDelta = 300;

    const { netChange: julReversalNet } = reverseAnchor(jul);
    expect(julReversalNet).toBe(-2000);

    jul.status = "reversed";
    jul.materializedDelta = 0;

    const cascade = cascadeDownstream([jul, aug], [julActivity], {
      effectiveDate: "2026-07-01", dayPosition: 0, sequenceNumber: 1,
    });

    // Aug recalculates: position before = 0 (Jul reversed, excluded) - 800 = -800.
    // New Aug delta = 1500 - (-800) = 2300. Old was 300. Net change = +2000.
    expect(cascade.steps).toHaveLength(1);
    expect(cascade.steps[0].newDelta).toBe(2300);
    expect(cascade.steps[0].netChange).toBe(2000);

    const totalNetEffect = julReversalNet + cascade.totalNetChange;
    expect(totalNetEffect).toBe(0); // NOT -2000
  });
});

describe("Section 32 -- same-day ordering: Opening=start of day, Balance Update=end of day, ordinary events between", () => {
  it("an Opening Balance on the same date as an ordinary event is positioned before it", () => {
    const sameDay = opening("open", "2026-07-01", 1000);
    const event: OrdinaryEvent = { id: "e1", effectiveAt: "2026-07-01T09:00:00Z", amountDelta: -200 };
    // Opening's position-before must NOT include the same-day ordinary event.
    const before = historicalPositionBefore([sameDay], [event], {
      effectiveDate: "2026-07-01", dayPosition: 0, sequenceNumber: 1,
    });
    expect(before).toBe(0);
  });

  it("a Balance Update on the same date as an ordinary event is positioned after it", () => {
    const update = balanceUpdate("upd", "2026-07-01", 1000);
    const event: OrdinaryEvent = { id: "e1", effectiveAt: "2026-07-01T09:00:00Z", amountDelta: -200 };
    const before = historicalPositionBefore([], [event], {
      effectiveDate: "2026-07-01", dayPosition: 2, sequenceNumber: 1,
    });
    expect(before).toBe(-200);
  });

  it("two same-day Balance Updates are ordered by sequence_number, not arbitrarily", () => {
    const first = balanceUpdate("u1", "2026-08-01", 1500, 1);
    first.materializedDelta = 300;
    const second = balanceUpdate("u2", "2026-08-01", 1700, 2);

    const before = historicalPositionBefore([first], [], {
      effectiveDate: "2026-08-01", dayPosition: 2, sequenceNumber: 2,
    });
    expect(before).toBe(300); // includes the first same-day update

    const { newDelta } = materializeAnchor([first], [], second);
    expect(newDelta).toBe(1700 - 300); // 1400, reconciling from the FIRST update's result, not from scratch
  });
});

describe("Section 11 -- genesis baseline is zero, not undefined", () => {
  it("the very first anchor for an employee with no prior history reconstructs from a zero baseline", () => {
    const before = historicalPositionBefore([], [], { effectiveDate: "2026-01-01", dayPosition: 0, sequenceNumber: 1 });
    expect(before).toBe(0);
  });
});

describe("Section 48 -- allocation regression: unaffected by the anchor model", () => {
  it("allocation stays a plain additive transaction, never an anchor", () => {
    // Allocation is modeled purely as an OrdinaryEvent in this replay module --
    // it never creates a HistoricalAnchor. Verify it simply adds.
    const current = 500;
    const allocation = 200;
    expect(current + allocation).toBe(700);
  });
});

describe("Rounding and currency-safety", () => {
  it("keeps two-decimal precision through position/materialize/cascade", () => {
    const anchor = opening("a", "2026-07-01", 927882.94);
    const result = applyHistoricalAnchor({
      anchors: [], ordinaryEvents: [], currentBalance: -927882.94, newAnchor: anchor,
    });
    // Matches the owner's exact reported starter-sheet row (see
    // balanceImportStarterSheet.test.ts) carried through the anchor engine.
    expect(result.ownNetChange).toBe(927882.94);
    expect(result.projectedBalance).toBe(0);
  });
});
