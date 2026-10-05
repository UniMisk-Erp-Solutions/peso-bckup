/**
 * Batch-aware selection + pre-approval classification for Review Expenses
 * (DOC-080 §24/§25). Pure and framework-free so the exact selection and
 * warning semantics are unit-testable.
 *
 * Selection is KEYED, not id-based:
 *   - a singular row  → `expense:<id>`
 *   - a batch child   → `batch:<batch_id>`  (one logical selection for the whole
 *                        batch — every child reflects the same checked state)
 * Terminal (completed) rows are never selectable and never acted on.
 */

import type { ReviewRowState } from "./reviewStatePresentation";

export type SelectableRow = {
  id: string;
  batch_id?: string | null;
  /** Shared 3-state: ready (blue) / waiting (amber) / completed (grey). */
  state: ReviewRowState;
};

/** Logical selection key. A batch is one selection across all its child rows. */
export function selectionKey(row: { id: string; batch_id?: string | null }): string {
  return row.batch_id ? `batch:${row.batch_id}` : `expense:${row.id}`;
}

/** Selectable unless completed/terminal (ready and waiting are both selectable). */
export function isRowSelectable(row: SelectableRow): boolean {
  return row.state !== "completed";
}

/** Unique selection keys for the selectable rows on a page (batch keys deduped). */
export function pageSelectableKeys(rows: SelectableRow[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!isRowSelectable(r)) continue;
    const key = selectionKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** Header select-all tri-state for the current page. */
export function selectAllState(
  selectedKeys: ReadonlySet<string>,
  pageRows: SelectableRow[],
): "none" | "some" | "all" {
  const keys = pageSelectableKeys(pageRows);
  if (keys.length === 0) return "none";
  const selected = keys.filter((k) => selectedKeys.has(k)).length;
  if (selected === 0) return "none";
  return selected === keys.length ? "all" : "some";
}

/**
 * Split selected keys into batch ids and singular expense ids (DOC-098 §4A).
 * Used by Bulk Verify to decide, per selection, whether to call the
 * server-authoritative atomic batch RPC (one call per batch id, never
 * expanded over browser-held rows) or the existing per-expense path.
 */
export function splitSelectedKeys(
  selectedKeys: ReadonlySet<string>,
): { batchIds: string[]; singularIds: string[] } {
  const batchIds: string[] = [];
  const singularIds: string[] = [];
  for (const key of selectedKeys) {
    if (key.startsWith("batch:")) batchIds.push(key.slice(6));
    else if (key.startsWith("expense:")) singularIds.push(key.slice(8));
  }
  return { batchIds, singularIds };
}

/**
 * Remove only selections whose concrete rows are now terminal. A batch key is
 * cleared only when every freshly-resolved child behind that selection settled;
 * partial failures remain selected and retryable.
 */
export function retainUnsettledSelectionKeys(
  selectedKeys: ReadonlySet<string>,
  targets: Array<{ id: string; batch_id?: string | null }>,
  settledExpenseIds: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selectedKeys);
  const batchTargets = new Map<string, string[]>();

  for (const target of targets) {
    if (target.batch_id) {
      const ids = batchTargets.get(target.batch_id) ?? [];
      ids.push(target.id);
      batchTargets.set(target.batch_id, ids);
    } else if (settledExpenseIds.has(target.id)) {
      next.delete(`expense:${target.id}`);
    }
  }

  for (const [batchId, ids] of batchTargets) {
    if (ids.length > 0 && ids.every((id) => settledExpenseIds.has(id))) {
      next.delete(`batch:${batchId}`);
    }
  }
  return next;
}

/** A replay after a successful approval is terminal reconciliation, not failure. */
export function isAlreadyApprovedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\balready approved\b/i.test(message);
}

/**
 * Expand selected keys to the concrete expense ids to act on, over all held
 * rows (a batch key expands to every one of its non-terminal children). Terminal
 * rows are never included even if their key were somehow selected.
 */
export function expandSelectionToExpenseIds(
  selectedKeys: ReadonlySet<string>,
  allRows: SelectableRow[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const r of allRows) {
    if (!isRowSelectable(r)) continue;
    if (!selectedKeys.has(selectionKey(r))) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    ids.push(r.id);
  }
  return ids;
}

/* ----------------------------------------------------------------------- *
 * Pre-approval classification (§25)
 * ----------------------------------------------------------------------- */

export type ApprovalRow = {
  id: string;
  /** Actionable by THIS reviewer right now (server-authoritative sense). */
  isReadyNow: boolean;
  /** Already terminal (approved/rejected/paid). */
  isTerminal: boolean;
  amount: number;
};

export type ApprovalClassification = {
  /** Ready now AND within the reviewer's approval limit — safe to approve. */
  readyNow: string[];
  /** Ready now but the amount exceeds the reviewer's limit — skipped, not approved. */
  overLimit: string[];
  /** Visible but not yet at this reviewer's stage — needs an override to approve. */
  waiting: string[];
  /** Already completed — should never be selected; defensive. */
  terminal: string[];
};

export function classifyForApproval(rows: ApprovalRow[], approvalLimit: number): ApprovalClassification {
  const readyNow: string[] = [];
  const overLimit: string[] = [];
  const waiting: string[] = [];
  const terminal: string[] = [];
  for (const r of rows) {
    if (r.isTerminal) {
      // Already finished — never approvable.
      terminal.push(r.id);
    } else if (Number(r.amount) > Number(approvalLimit)) {
      // Over the limit is checked BEFORE ready/waiting: even a Manager override
      // cannot approve an over-limit expense, so a waiting+over-limit row must be
      // reported as OVER LIMIT, not merely "waiting" (§9).
      overLimit.push(r.id);
    } else if (!r.isReadyNow) {
      // Within limit but not yet at this reviewer's stage — needs the override.
      waiting.push(r.id);
    } else {
      // Ready now and within limit — normal V2 approval.
      readyNow.push(r.id);
    }
  }
  return { readyNow, overLimit, waiting, terminal };
}

/**
 * The server queue RPCs (get_debug_review_queue_page_v1,
 * review_preview_approval_targets_v1) already compute per-row
 * `available_actions` canonically — this is the single source of truth for
 * "can a normal Approve act on this row right now", never a second
 * hierarchy-state-machine reconstructed from status/approval_tier/role in
 * React (REVIEW-VERIFIED-READY-CLASSIFICATION hotfix, §6/§12). A terminal
 * row fails closed even if a stale `available_actions` somehow still lists
 * "approve".
 */
export function isNormallyApprovable(row: {
  available_actions?: string[] | null;
  isTerminal?: boolean;
}): boolean {
  if (row.isTerminal) return false;
  return Array.isArray(row.available_actions) && row.available_actions.includes("approve");
}

/** A confirmation warning is required when the selection is not all immediately approvable. */
export function needsApprovalWarning(c: ApprovalClassification): boolean {
  return c.waiting.length > 0 || c.overLimit.length > 0 || c.terminal.length > 0;
}

/**
 * Whether PROCEED may run at all.
 *
 * Waiting rows can only be approved with the Manager-override server capability;
 * until that migration is installed, a selection containing waiting rows must NOT
 * proceed (we never call a server function that does not exist). Otherwise PROCEED
 * approves the readyNow rows and simply skips over-limit/terminal.
 */
export function canProceedWithApproval(
  c: ApprovalClassification,
  overrideAvailable: boolean,
): boolean {
  if (c.waiting.length > 0 && !overrideAvailable) return false;
  return c.readyNow.length > 0 || (c.waiting.length > 0 && overrideAvailable);
}
