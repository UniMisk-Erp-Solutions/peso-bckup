// Historical Balance Anchors V2 -- pure reference mirror of the replay
// algorithm implemented server-side in
// supabase/migrations/20260824110000_historical_balance_anchors_engine.sql
// (_balance_historical_position_before_v1 / _balance_materialize_anchor_v1 /
// _balance_cascade_downstream_anchors_v1).
//
// This module is NOT called at runtime by the app -- profiles.balance is
// server state and the real computation happens only inside the SQL engine,
// per the project's "current balance remains server state, never
// re-derived in the browser" rule. It exists so the accounting model itself
// (the formula, the same-day ordering, the downstream-cascade behavior) can
// be exhaustively unit-tested without a live Postgres instance, since this
// session has no sandboxed database to execute the SQL against. Keep this
// file's logic byte-for-byte equivalent to the SQL's if either changes.
//
// Core formula:
//   materialized_delta(anchor) = anchor.statedBalance
//                               - positionBefore(anchor's timeline slot)
//
// positionBefore sums, strictly before the slot:
//   * every OTHER active anchor's current materializedDelta, plus
//   * every ordinary (non-anchor) ledger delta.
//
// The account balance changes ONLY by the anchor's OWN net change
// (new materializedDelta minus old, old=0 the first time) -- never by
// "set balance = statedBalance". Editing/reversing an anchor cascades the
// same net-change calculation to every downstream active anchor, in
// ascending timeline order.

export type AnchorKind = "opening_balance" | "balance_update";

/** day_position: 0 = start of day (opening_balance), 2 = end of day (balance_update). */
export type DayPosition = 0 | 2;

export interface TimelineKey {
  effectiveDate: string; // YYYY-MM-DD
  dayPosition: DayPosition;
  sequenceNumber: number;
}

export interface HistoricalAnchor {
  id: string;
  anchorKind: AnchorKind;
  effectiveDate: string;
  dayPosition: DayPosition;
  sequenceNumber: number;
  statedBalance: number;
  materializedDelta: number | null;
  status: "active" | "superseded" | "reversed";
}

/** An ordinary (non-anchor) balance-affecting event: manual add/adjust,
 * cashier/bank transfer, allocation, expense deduction, etc. */
export interface OrdinaryEvent {
  id: string;
  /** ISO date (YYYY-MM-DD) or full timestamp; only the date portion is used
   * for the day-position(1) bucket, matching the SQL's `effective_at::date`. */
  effectiveAt: string;
  amountDelta: number;
}

function dayPositionRank(pos: DayPosition | 1): number {
  return pos;
}

/** Row-style lexicographic comparison, matching SQL's `ROW(...) < ROW(...)`. */
function keyLessThan(a: [string, number, number], b: [string, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

function ordinaryEventKey(e: OrdinaryEvent): [string, number, number] {
  const date = e.effectiveAt.slice(0, 10);
  // Sub-tiebreak among same-day ordinary events: their own timestamp,
  // matching the SQL's epoch-seconds tiebreak. A plain ISO string sorts
  // correctly here since same-day events share the date prefix.
  const seconds = Date.parse(e.effectiveAt.length > 10 ? e.effectiveAt : `${e.effectiveAt}T00:00:00Z`) / 1000;
  return [date, dayPositionRank(1), Math.floor(seconds)];
}

function anchorKey(a: Pick<HistoricalAnchor, "effectiveDate" | "dayPosition" | "sequenceNumber">): [string, number, number] {
  return [a.effectiveDate, dayPositionRank(a.dayPosition), a.sequenceNumber];
}

/**
 * Reconstructed balance strictly before a timeline position, given the
 * current state of every OTHER active anchor and every ordinary event for
 * one employee. Mirrors _balance_historical_position_before_v1.
 */
export function historicalPositionBefore(
  anchors: HistoricalAnchor[],
  ordinaryEvents: OrdinaryEvent[],
  target: TimelineKey,
  excludeAnchorId: string | null = null,
): number {
  const targetKey: [string, number, number] = [target.effectiveDate, target.dayPosition, target.sequenceNumber];

  let sum = 0;
  for (const a of anchors) {
    if (a.status !== "active") continue;
    if (excludeAnchorId !== null && a.id === excludeAnchorId) continue;
    if (keyLessThan(anchorKey(a), targetKey)) {
      sum += a.materializedDelta ?? 0;
    }
  }
  for (const e of ordinaryEvents) {
    if (keyLessThan(ordinaryEventKey(e), targetKey)) {
      sum += e.amountDelta;
    }
  }
  return round2(sum);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface MaterializeResult {
  netChange: number;
  newDelta: number;
}

/**
 * Computes (does not mutate) what materializing one anchor would produce:
 * its new materializedDelta and the net change that would be applied to the
 * account balance. Mirrors _balance_materialize_anchor_v1's arithmetic
 * (mode='initial'|'recalculate'); mode='reverse' is modeled by
 * reverseAnchor() below.
 */
export function materializeAnchor(
  anchors: HistoricalAnchor[],
  ordinaryEvents: OrdinaryEvent[],
  anchor: HistoricalAnchor,
): MaterializeResult {
  const oldDelta = anchor.materializedDelta ?? 0;
  const positionBefore = historicalPositionBefore(
    anchors,
    ordinaryEvents,
    { effectiveDate: anchor.effectiveDate, dayPosition: anchor.dayPosition, sequenceNumber: anchor.sequenceNumber },
    anchor.id,
  );
  const newDelta = round2(anchor.statedBalance - positionBefore);
  return { netChange: round2(newDelta - oldDelta), newDelta };
}

export function reverseAnchor(anchor: HistoricalAnchor): MaterializeResult {
  const oldDelta = anchor.materializedDelta ?? 0;
  return { netChange: round2(0 - oldDelta), newDelta: 0 };
}

export interface CascadeStep {
  anchorId: string;
  oldDelta: number;
  newDelta: number;
  netChange: number;
}

/**
 * Recalculates every ACTIVE anchor strictly after a timeline position, in
 * ascending order, mutating a working copy of the anchors array so each
 * step sees the previous step's result -- mirrors
 * _balance_cascade_downstream_anchors_v1 processing anchors one at a time
 * against the live table.
 */
export function cascadeDownstream(
  anchors: HistoricalAnchor[],
  ordinaryEvents: OrdinaryEvent[],
  from: TimelineKey,
): { anchors: HistoricalAnchor[]; steps: CascadeStep[]; totalNetChange: number } {
  const working = anchors.map((a) => ({ ...a }));
  const fromKey: [string, number, number] = [from.effectiveDate, from.dayPosition, from.sequenceNumber];

  const downstream = working
    .filter((a) => a.status === "active" && keyLessThan(fromKey, anchorKey(a)))
    .sort((a, b) => {
      const ak = anchorKey(a);
      const bk = anchorKey(b);
      if (ak[0] !== bk[0]) return ak[0] < bk[0] ? -1 : 1;
      if (ak[1] !== bk[1]) return ak[1] - bk[1];
      return ak[2] - bk[2];
    });

  const steps: CascadeStep[] = [];
  let totalNetChange = 0;

  for (const anchor of downstream) {
    const current = working.find((a) => a.id === anchor.id)!;
    const { netChange, newDelta } = materializeAnchor(working, ordinaryEvents, current);
    const oldDelta = current.materializedDelta ?? 0;
    current.materializedDelta = newDelta;
    if (netChange !== 0) {
      steps.push({ anchorId: current.id, oldDelta, newDelta, netChange });
      totalNetChange = round2(totalNetChange + netChange);
    }
  }

  return { anchors: working, steps, totalNetChange };
}

/**
 * Full end-to-end simulation: create or supersede one anchor, materialize
 * it, cascade downstream, and report the total effect on the account
 * balance. Pure function -- returns new state, does not mutate inputs.
 * Mirrors _balance_apply_historical_anchor_core_v1's net-effect contract.
 */
export function applyHistoricalAnchor(params: {
  anchors: HistoricalAnchor[];
  ordinaryEvents: OrdinaryEvent[];
  currentBalance: number;
  newAnchor: HistoricalAnchor; // status must be 'active'
  /**
   * When this operation supersedes an existing anchor, pass its (already
   * 'superseded'-status, still present in `anchors`) record here. The new
   * anchor's starting materializedDelta is seeded from this anchor's
   * CURRENT materializedDelta (its already-applied effect), not from zero
   * -- mirrors the SQL engine's supersede path exactly. Omitting this for a
   * supersede would double-count: the old anchor's historical effect is
   * still present in the account balance and has not been reversed by
   * marking it 'superseded' alone.
   */
  supersedesAnchor?: HistoricalAnchor;
}): {
  anchors: HistoricalAnchor[];
  projectedBalance: number;
  ownNetChange: number;
  cascadeSteps: CascadeStep[];
} {
  const working = params.anchors.map((a) => ({ ...a }));
  const seeded: HistoricalAnchor = {
    ...params.newAnchor,
    materializedDelta: params.supersedesAnchor ? (params.supersedesAnchor.materializedDelta ?? 0) : params.newAnchor.materializedDelta,
  };
  working.push(seeded);

  const target = working.find((a) => a.id === params.newAnchor.id)!;
  const { netChange, newDelta } = materializeAnchor(working, params.ordinaryEvents, target);
  target.materializedDelta = newDelta;

  const cascade = cascadeDownstream(working, params.ordinaryEvents, {
    effectiveDate: target.effectiveDate,
    dayPosition: target.dayPosition,
    sequenceNumber: target.sequenceNumber,
  });

  const projectedBalance = round2(params.currentBalance + netChange + cascade.totalNetChange);

  return {
    anchors: cascade.anchors,
    projectedBalance,
    ownNetChange: netChange,
    cascadeSteps: cascade.steps,
  };
}
