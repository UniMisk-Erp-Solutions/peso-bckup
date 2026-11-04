import type {
  AggregationResult, CanonicalTxn, ExpenseCategoryRule, ImportRow, PlannedVoucher,
  PosterState, PostedEdit, PostedInfo, PwtAccountingConfig, PwtIssue,
} from "./types.ts";
import { monthEnd, monthStart, norm, round2 } from "./util.ts";

export function employeeLedgerName(cfg: PwtAccountingConfig, t: Pick<CanonicalTxn, "employeeId" | "employeeName">): string {
  const o = cfg.employeeLedgerOverrides?.[t.employeeId];
  if (o) return o;
  // Workbook convention: "<Employee name>-<Employee ID>"
  return `${t.employeeName.replace(/\s+/g, " ").trim()}-${t.employeeId}`;
}

export function findCategory(cfg: PwtAccountingConfig, expenseType: string): ExpenseCategoryRule | undefined {
  const k = norm(expenseType);
  if (!k) return undefined;
  return cfg.categories.find((c) => norm(c.expenseType) === k || (c.aliases ?? []).some((a) => norm(a) === k));
}

/** Whether a canonical row may become an accounting voucher line. */
export function isPostable(t: CanonicalTxn): { ok: boolean; reason?: string } {
  switch (t.origin) {
    case "detailed_expense":
      return t.isLedgerDebit ? { ok: true } : { ok: false, reason: "not a ledger debit" };
    case "claim_approval":
      return t.status.toLowerCase() === "approved" && t.hoApproved
        ? { ok: true }
        : { ok: false, reason: `claim status "${t.status}" is not final-approved` };
    default:
      return { ok: false, reason: `${t.origin} never posts accounting` };
  }
}

export function planPosting(
  cfg: PwtAccountingConfig,
  txns: readonly CanonicalTxn[],
  state: PosterState,
  /** `view`: aggregate for DISPLAY only (any report, no posting-eligibility gate, no registry); callers pass an empty state. */
  opts: { view?: boolean } = {},
): AggregationResult {
  const issues: PwtIssue[] = [];
  const edits: PostedEdit[] = [];
  const seen = new Map<string, CanonicalTxn>();
  type Bucket = { date: string; rule: ExpenseCategoryRule; ledger: string; total: number; ids: string[]; items: { sourceId: string; amount: number; contentHash: string; expenseType: string }[] };
  const buckets = new Map<string, Bucket>();

  for (const t of txns) {
    const post = opts.view ? { ok: true as const, reason: undefined } : isPostable(t);
    if (!post.ok) {
      // Pending / verification claims are reported but never an error: they are simply not accounting yet.
      if (t.origin === "claim_approval") {
        issues.push({ code: "NOT_APPROVED", sourceId: t.sourceId, detail: post.reason!, blocking: false });
      }
      continue;
    }
    const prev = seen.get(t.sourceId);
    if (prev) {
      if (prev.amount !== t.amount) {
        issues.push({ code: "AMOUNT_MISMATCH", sourceId: t.sourceId, blocking: false,
          detail: `seen twice with ${prev.amount} and ${t.amount}; first kept` });
      }
      continue;
    }
    seen.set(t.sourceId, t);

    if (state.postedSourceIds.has(t.sourceId)) {
      const info = state.postedInfo?.[t.sourceId];
      if (info && !opts.view) {
        const changed = changedAfterPosting(info, t);
        if (changed.length) {
          edits.push({
            sourceId: t.sourceId, changed, was: info,
            now: { amount: round2(t.amount), month: t.billDate ? t.billDate.slice(0, 7) : null, code: t.employeeId ? String(t.employeeId) : null, type: t.expenseType },
          });
          issues.push({ code: "EDITED_AFTER_POSTING", sourceId: t.sourceId, blocking: false,
            detail: `edited after posting (${changed.join(", ")}); the old posting is corrected in Tally and the new version is posted` });
          continue;
        }
      }
      const was = state.postedAmounts?.[t.sourceId];
      if (was !== undefined && round2(was) !== round2(t.amount)) {
        issues.push({ code: "AMOUNT_MISMATCH", sourceId: t.sourceId, blocking: false,
          detail: `already posted as ${was}, now ${t.amount}; not re-posted` });
      } else {
        issues.push({ code: "ALREADY_POSTED", sourceId: t.sourceId, detail: "already in Tally registry", blocking: false });
      }
      continue;
    }
    if (!t.employeeId) {
      issues.push({ code: "MISSING_EMPLOYEE_ID", sourceId: t.sourceId, detail: `no employee id for "${t.employeeName}"`, blocking: true });
      continue;
    }
    const rule = findCategory(cfg, t.expenseType);
    if (!rule) {
      issues.push({ code: "UNMAPPED_EXPENSE_TYPE", sourceId: t.sourceId, blocking: true,
        detail: `expense type "${t.expenseType}" has no ledger mapping` });
      continue;
    }
    if (!Number.isFinite(t.amount) || t.amount <= 0) {
      issues.push({ code: "NON_POSITIVE_AMOUNT", sourceId: t.sourceId, detail: `amount ${t.amount}`, blocking: true });
      continue;
    }
    if (!t.billDate && cfg.postingDatePolicy !== "fixed") {
      issues.push({ code: "BAD_DATE", sourceId: t.sourceId, detail: "missing/invalid bill date", blocking: true });
      continue;
    }
    const date = cfg.postingDatePolicy === "fixed" && cfg.fixedPostingDate
      ? cfg.fixedPostingDate
      : cfg.postingDatePolicy === "month_start" ? monthStart(t.billDate) : monthEnd(t.billDate);
    const ledger = employeeLedgerName(cfg, t);
    const bk = `${date}|${rule.serial}|${ledger}`;
    const b = buckets.get(bk) ?? { date, rule, ledger, total: 0, ids: [], items: [] };
    b.total = round2(b.total + t.amount);
    b.ids.push(t.sourceId);
    b.items.push({ sourceId: t.sourceId, amount: t.amount, contentHash: t.contentHash, expenseType: t.expenseType });
    buckets.set(bk, b);
  }

  const sorted = [...buckets.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || a.rule.serial - b.rule.serial || a.ledger.localeCompare(b.ledger)
  );

  const rows: ImportRow[] = [];
  const postings: AggregationResult["postings"] = [];
  const vmap = new Map<string, PlannedVoucher>();
  for (const b of sorted) {
    const vno = voucherNumber(cfg, b.date, b.rule.serial, state);
    rows.push({ voucherDate: b.date, expenseLedger: b.rule.expenseLedger, employeeLedger: b.ledger,
      voucherId: vno, total: b.total, sourceIds: b.ids });
    for (const it of b.items) {
      postings.push({ ...it, voucherNumber: vno, voucherDate: b.date, serial: b.rule.serial, employeeLedger: b.ledger, expenseLedger: b.rule.expenseLedger });
    }
    const vk = `${b.date}|${b.rule.serial}`;
    let v = vmap.get(vk);
    if (!v) {
      v = { key: vk, date: b.date, voucherType: cfg.voucherType, voucherNumber: vno,
        narration: `${cfg.narrationTag} ${vno}`, lines: [], total: 0, sourceIds: [] };
      vmap.set(vk, v);
    }
    v.lines.push({ ledger: b.ledger, side: cfg.expenseSide === "debit" ? "credit" : "debit", amount: b.total });
    v.total = round2(v.total + b.total);
    v.sourceIds.push(...b.ids);
  }
  const vouchers = [...vmap.values()];
  for (const v of vouchers) {
    const rule = cfg.categories.find((c) => c.serial === Number(v.key.split("|")[1]))!;
    v.lines.unshift({ ledger: rule.expenseLedger, side: cfg.expenseSide, amount: v.total });
  }

  return {
    rows,
    vouchers,
    issues,
    employeeLedgers: [...new Set(rows.map((r) => r.employeeLedger))].sort(),
    expenseLedgers: [...new Set(rows.map((r) => r.expenseLedger))].sort(),
    postedSourceIds: rows.flatMap((r) => r.sourceIds),
    postings,
    edits,
  };
}

/**
 * What changed in an already-posted expense. Only facts that do NOT depend on the ledger mapping or the voucher-date setting are compared,
 * so editing the mapping never looks like an edit of every expense: amount, month, employee code and expense type (when it was recorded).
 */
export function changedAfterPosting(info: PostedInfo, t: Pick<CanonicalTxn, "amount" | "billDate" | "employeeId" | "expenseType">): PostedEdit["changed"] {
  const out: PostedEdit["changed"] = [];
  if (Number.isFinite(t.amount) && round2(info.amount) !== round2(t.amount)) out.push("amount");
  if (t.billDate && info.month && t.billDate.slice(0, 7) !== info.month) out.push("date");
  if (info.code && t.employeeId && String(t.employeeId) !== info.code) out.push("employee");
  if (info.type && t.expenseType && norm(info.type) !== norm(t.expenseType)) out.push("category");
  return out;
}

export function voucherNumber(cfg: PwtAccountingConfig, date: string, serial: number, state: PosterState): string {
  const mm = date.slice(5, 7);
  const base = `${cfg.voucherPrefix}/${mm}/${String(serial).padStart(2, "0")}`;
  const n = state.voucherCounts[`${date}|${serial}`] ?? 0;
  return n === 0 ? base : `${base}-S${n}`;
}

/** The Sumit "Import Sheet" as a 5-column table. */
export function toFiveColumns(rows: readonly ImportRow[]): string[][] {
  return [
    ["Voucher Date (Tally)", "Expense Ledger", "Employe Ledger", "Voucher ID", "Total"],
    ...rows.map((r) => [r.voucherDate, r.expenseLedger, r.employeeLedger, r.voucherId, r.total.toFixed(2)]),
  ];
}

/** Display aggregation: the same grouping/voucher-id rules, for any report, never touching the registry. */
export function planView(cfg: PwtAccountingConfig, txns: readonly CanonicalTxn[]): AggregationResult {
  return planPosting(cfg, txns, { postedSourceIds: new Set(), voucherCounts: {} }, { view: true });
}
