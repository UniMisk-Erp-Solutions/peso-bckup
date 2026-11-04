/**
 * Deletion sync (PesoWise -> TallyPrime correction). When an expense that was synced to Tally is deleted in PesoWise, the backend
 * queues a correction job; this file applies it to the paired company and reads the result back from Tally.
 *
 *   - the voucher is found by its PesoWise reference (narration "PWT PESO/08/02") + date; never by guessing
 *   - voucher holds only this expense  -> delete the voucher
 *   - voucher holds other expenses too -> alter it, removing ONLY this expense's amount from its two ledgers
 *   - alter/delete rejected by Tally   -> post a compensating reversal voucher instead
 *   - anything ambiguous (voucher changed outside PesoWise, duplicates, ledgers unknown) -> BLOCKED, nothing is changed
 * A job is only reported `completed` after Tally itself shows the corrected state.
 */
import { activeCompany, TallyOfflineError, type TallyIO } from "./engine.ts";
import { parseImportResponse, round2, tallyDate, xmlEscape } from "../../../supabase/functions/_shared/pwt/index.ts";
import { parsePaymentVouchers, type InboundVoucher } from "./inbound.ts";

const EPS = 0.005;

export interface DeletionJob {
  job_id: string;
  tally_company: string;
  /** PesoWise voucher reference, e.g. PESO/08/02 (the narration is "<tag> <reference>"). */
  voucher_number: string;
  voucher_date: string; // ISO
  amount: number;
  employee_ledger: string | null;
  expense_ledger: string | null;
  transaction_number?: string | null;
  /** The voucher total PesoWise last recorded (null for vouchers older than the deletion feature). */
  known_total: number | null;
  /** Other not-yet-removed expenses recorded in the same voucher. */
  siblings: number;
  /** A compensating reversal was already used on this voucher: never delete or alter it again. */
  force_reversal: boolean;
  voucher_type: string;
  expense_side: "debit" | "credit";
  narration_tag: string;
}

export type Correction = "delete_voucher" | "alter_voucher" | "reversal_voucher" | "already_gone";

export interface Line { ledger: string; /** Tally sign: a DEBIT is negative. */ amount: number }

export type Plan =
  | { kind: "already_gone" }
  | { kind: "already_altered"; voucher: InboundVoucher }
  | { kind: "delete"; voucher: InboundVoucher; fallback: boolean }
  | { kind: "alter"; voucher: InboundVoucher; lines: Line[]; fallback: boolean }
  | { kind: "reverse"; voucher: InboundVoucher }
  | { kind: "blocked"; reason: string };

export const narrationOf = (j: Pick<DeletionJob, "narration_tag" | "voucher_number">) => `${j.narration_tag} ${j.voucher_number}`;
export const reversalNarration = (j: Pick<DeletionJob, "narration_tag" | "voucher_number" | "job_id" | "transaction_number">) =>
  `${j.narration_tag} REV ${j.voucher_number} ${j.transaction_number || j.job_id.slice(0, 8)}`;

/* ------------------------------------------------------------------ requests (read-only) */

/** Every voucher on one date whose narration is EXACTLY the given text. */
export function voucherByNarrationRequest(company: string, narration: string, dateIso: string): string {
  const d = tallyDate(dateIso);
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PWTDel</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>` +
    `<SVFROMDATE>${d}</SVFROMDATE><SVTODATE>${d}</SVTODATE></STATICVARIABLES><TDL><TDLMESSAGE>` +
    `<COLLECTION NAME="PWTDel"><TYPE>Voucher</TYPE>` +
    ["Date", "VoucherNumber", "VoucherTypeName", "Narration", "GUID", "AlterID", "MasterID", "IsCancelled", "IsOptional",
      "AllLedgerEntries.LedgerName", "AllLedgerEntries.Amount"].map((n) => `<NATIVEMETHOD>${n}</NATIVEMETHOD>`).join("") +
    `<FILTER>PWTDelNarr</FILTER></COLLECTION>` +
    `<SYSTEM TYPE="Formulae" NAME="PWTDelNarr">$Narration = "${xmlEscape(narration)}"</SYSTEM>` +
    `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/* ------------------------------------------------------------------ writes */

function importEnvelope(company: string, messages: string): string {
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>` +
    `<STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA>${messages}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

const entriesXml = (lines: readonly Line[]) =>
  lines.map((l) => {
    const debit = l.amount < 0;
    return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlEscape(l.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>` +
      `<AMOUNT>${round2(l.amount).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
  }).join("");

/** Identify the voucher exactly as TallyPrime's own Voucher Number key (validated against TallyPrime 7.1). */
const voucherKey = (v: InboundVoucher, action: "Delete" | "Alter") =>
  `<VOUCHER DATE="${tallyDate(v.date)}" TAGNAME="Voucher Number" TAGVALUE="${xmlEscape(v.number)}" VCHTYPE="${xmlEscape(v.type)}" ACTION="${action}">`;

export function deleteVoucherXml(company: string, v: InboundVoucher): string {
  return importEnvelope(company, `<TALLYMESSAGE xmlns:UDF="TallyUDF">${voucherKey(v, "Delete")}<DATE>${tallyDate(v.date)}</DATE>` +
    `<VOUCHERTYPENAME>${xmlEscape(v.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xmlEscape(v.number)}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE>`);
}

export function alterVoucherXml(company: string, v: InboundVoucher, lines: readonly Line[]): string {
  return importEnvelope(company, `<TALLYMESSAGE xmlns:UDF="TallyUDF">${voucherKey(v, "Alter")}<DATE>${tallyDate(v.date)}</DATE>` +
    `<VOUCHERTYPENAME>${xmlEscape(v.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xmlEscape(v.number)}</VOUCHERNUMBER>` +
    `<NARRATION>${xmlEscape(v.narration)}</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>${entriesXml(lines)}</VOUCHER></TALLYMESSAGE>`);
}

export function reversalLines(job: Pick<DeletionJob, "amount" | "employee_ledger" | "expense_ledger" | "expense_side">): Line[] {
  // The original posted expenseSide on the expense ledger and the opposite on the employee ledger; the reversal is the mirror image.
  const expenseSign = job.expense_side === "debit" ? 1 : -1; // reversing a debit = credit (+)
  return [
    { ledger: job.expense_ledger!, amount: round2(expenseSign * job.amount) },
    { ledger: job.employee_ledger!, amount: round2(-expenseSign * job.amount) },
  ];
}

export function reversalVoucherXml(company: string, job: DeletionJob): string {
  return importEnvelope(company, `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${xmlEscape(job.voucher_type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">` +
    `<DATE>${tallyDate(job.voucher_date)}</DATE><VOUCHERTYPENAME>${xmlEscape(job.voucher_type)}</VOUCHERTYPENAME>` +
    `<NARRATION>${xmlEscape(reversalNarration(job))}</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>${entriesXml(reversalLines(job))}</VOUCHER></TALLYMESSAGE>`);
}

/* ------------------------------------------------------------------ planning (pure) */

const totals = (v: InboundVoucher) => {
  let dr = 0;
  let cr = 0;
  for (const e of v.entries) (e.amount < 0 ? (dr -= e.amount) : (cr += e.amount));
  return { dr: round2(dr), cr: round2(cr) };
};
const near = (a: number, b: number) => Math.abs(a - b) < EPS;

/** Decide what to do, given the vouchers Tally returned for the job's reference. Pure: no I/O. */
export function planCorrection(job: DeletionJob, found: readonly InboundVoucher[]): Plan {
  const live = found.filter((v) => !v.cancelled);
  if (live.length === 0) return { kind: "already_gone" };
  if (live.length > 1) return { kind: "blocked", reason: `Tally has ${live.length} vouchers with reference "${narrationOf(job)}" on ${job.voucher_date}; cannot tell which one to correct` };
  const v = live[0];
  if (v.optional) return { kind: "blocked", reason: "the Tally voucher is an optional voucher; not changed" };
  if (job.voucher_type && v.type !== job.voucher_type) {
    return { kind: "blocked", reason: `the Tally voucher is a "${v.type}" voucher, expected "${job.voucher_type}"; not changed` };
  }
  const { dr, cr } = totals(v);
  if (!near(dr, cr)) return { kind: "blocked", reason: `the Tally voucher is unbalanced (Dr ${dr} / Cr ${cr}); not changed` };

  const canMirror = !!job.employee_ledger && !!job.expense_ledger;
  if (job.force_reversal) {
    return canMirror ? { kind: "reverse", voucher: v } : { kind: "blocked", reason: "this voucher was corrected by a reversal before and the ledgers of this expense are unknown" };
  }

  // Has an earlier attempt already removed this expense (acknowledgement lost)? PesoWise's recorded total minus this amount.
  if (job.known_total !== null && near(dr, round2(job.known_total - job.amount)) && !near(dr, job.known_total)) {
    return { kind: "already_altered", voucher: v };
  }
  // The voucher must still be exactly what PesoWise posted. Anything else was changed outside PesoWise: do not touch it.
  if (job.known_total !== null && !near(dr, job.known_total)) {
    return { kind: "blocked", reason: `the Tally voucher total (${dr}) is not what PesoWise recorded (${job.known_total}); it was changed outside PesoWise` };
  }

  // Only this expense in the voucher -> delete it.
  if (job.siblings === 0 && near(dr, job.amount)) return { kind: "delete", voucher: v, fallback: canMirror };

  if (!canMirror) {
    return { kind: "blocked", reason: "the voucher holds more than this expense and the employee/expense ledgers of this expense are not recorded" };
  }
  // Several expenses -> remove only this one's amount from its employee line and the expense line.
  const sign = job.expense_side === "debit" ? -1 : 1; // sign of the expense ledger line in Tally
  const expenseLine = v.entries.filter((e) => e.ledger === job.expense_ledger);
  const employeeLine = v.entries.filter((e) => e.ledger === job.employee_ledger);
  if (expenseLine.length !== 1 || employeeLine.length !== 1) {
    return { kind: "blocked", reason: `expected exactly one "${job.expense_ledger}" line and one "${job.employee_ledger}" line in the voucher` };
  }
  if (Math.sign(expenseLine[0].amount) !== sign || Math.sign(employeeLine[0].amount) !== -sign) {
    return { kind: "blocked", reason: "the voucher's debit/credit sides are not what PesoWise posted; not changed" };
  }
  if (Math.abs(expenseLine[0].amount) < job.amount - EPS || Math.abs(employeeLine[0].amount) < job.amount - EPS) {
    return { kind: "blocked", reason: `the voucher has less than ${job.amount} on "${job.employee_ledger}" or "${job.expense_ledger}"` };
  }
  const lines: Line[] = [];
  for (const e of v.entries) {
    if (e === expenseLine[0] || e === employeeLine[0]) {
      const left = round2(Math.abs(e.amount) - job.amount);
      if (left > EPS) lines.push({ ledger: e.ledger, amount: Math.sign(e.amount) * left });
    } else lines.push({ ledger: e.ledger, amount: e.amount });
  }
  if (!lines.some((l) => l.amount < 0) || !lines.some((l) => l.amount > 0)) {
    return { kind: "delete", voucher: v, fallback: canMirror }; // nothing meaningful would remain
  }
  return { kind: "alter", voucher: v, lines, fallback: true };
}

/** Does Tally's voucher now equal these lines (order-insensitive)? */
export function sameLines(v: InboundVoucher, lines: readonly Line[]): boolean {
  if (v.entries.length !== lines.length) return false;
  const have = new Map<string, number>();
  for (const e of v.entries) have.set(e.ledger, round2((have.get(e.ledger) ?? 0) + e.amount));
  return lines.every((l) => near(have.get(l.ledger) ?? NaN, l.amount));
}

/* ------------------------------------------------------------------ execution */

export interface DeletionApi {
  call<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T>;
}

export interface DeletionResult {
  outcome: "completed" | "blocked" | "retry";
  correction?: Correction;
  error?: string;
  detail?: Record<string, unknown>;
}

async function fetchVouchers(io: TallyIO, job: DeletionJob, narration: string): Promise<InboundVoucher[]> {
  return parsePaymentVouchers(await io.post(voucherByNarrationRequest(job.tally_company, narration, job.voucher_date)), new Map());
}

const importOk = (xml: string, want: "deleted" | "altered" | "created") => {
  const r = parseImportResponse(xml);
  const n = Number(new RegExp(`<${want.toUpperCase()}\\b[^>]*>\\s*(\\d+)\\s*</${want.toUpperCase()}>`, "i").exec(xml)?.[1] ?? NaN);
  const errors = Number(/<ERRORS\b[^>]*>\s*(\d+)\s*</i.exec(xml)?.[1] ?? NaN);
  const exceptions = Number(/<EXCEPTIONS\b[^>]*>\s*(\d+)\s*</i.exec(xml)?.[1] ?? 0);
  return { ok: n === 1 && errors === 0 && exceptions === 0 && r.lineErrors.length === 0, error: r.lineErrors.join("; ") || (errors ? `errors=${errors}` : "unexpected Tally response") };
};

/** Apply a compensating reversal (or recognise that it already exists) and read it back. */
async function reverse(job: DeletionJob, io: TallyIO): Promise<DeletionResult> {
  const narr = reversalNarration(job);
  const existing = (await fetchVouchers(io, job, narr)).filter((v) => !v.cancelled);
  if (existing.length > 1) return { outcome: "blocked", error: `more than one reversal voucher "${narr}" exists in Tally` };
  if (existing.length === 0) {
    const res = importOk(await io.post(reversalVoucherXml(job.tally_company, job)), "created");
    if (!res.ok) return { outcome: "retry", error: `Tally rejected the reversal voucher: ${res.error}` };
  }
  const after = (await fetchVouchers(io, job, narr)).filter((v) => !v.cancelled);
  if (after.length !== 1 || !sameLines(after[0], reversalLines(job))) {
    return { outcome: "retry", error: "readback: the reversal voucher is not in Tally as expected" };
  }
  return { outcome: "completed", correction: "reversal_voucher", detail: { reversal: narr, tally_voucher_number: after[0].number } };
}

export async function applyDeletion(job: DeletionJob, io: TallyIO): Promise<DeletionResult> {
  const found = await fetchVouchers(io, job, narrationOf(job));
  const plan = planCorrection(job, found);

  switch (plan.kind) {
    case "blocked":
      return { outcome: "blocked", error: plan.reason };

    case "already_gone":
      return { outcome: "completed", correction: "already_gone", detail: { note: "voucher not present in Tally" } };

    case "already_altered":
      return { outcome: "completed", correction: "alter_voucher", detail: { note: "voucher already reduced by this amount", tally_voucher_number: plan.voucher.number } };

    case "reverse":
      return await reverse(job, io);

    case "delete": {
      const res = importOk(await io.post(deleteVoucherXml(job.tally_company, plan.voucher)), "deleted");
      const after = (await fetchVouchers(io, job, narrationOf(job))).filter((v) => !v.cancelled);
      if (res.ok && after.length === 0) {
        return { outcome: "completed", correction: "delete_voucher", detail: { tally_voucher_number: plan.voucher.number } };
      }
      if (after.length === 0) return { outcome: "completed", correction: "delete_voucher", detail: { tally_voucher_number: plan.voucher.number } };
      return plan.fallback ? await reverse(job, io) : { outcome: "blocked", error: `Tally would not delete the voucher: ${res.error}` };
    }

    case "alter": {
      const res = importOk(await io.post(alterVoucherXml(job.tally_company, plan.voucher, plan.lines)), "altered");
      const after = (await fetchVouchers(io, job, narrationOf(job))).filter((v) => !v.cancelled);
      if (after.length === 1 && sameLines(after[0], plan.lines)) {
        return { outcome: "completed", correction: "alter_voucher", detail: { tally_voucher_number: plan.voucher.number, new_total: totals(after[0]).dr } };
      }
      // The voucher must be untouched or exactly as planned; anything else is not a state we can reason about.
      if (after.length === 1 && sameLines(after[0], plan.voucher.entries)) {
        return plan.fallback ? await reverse(job, io) : { outcome: "blocked", error: `Tally would not alter the voucher: ${res.error}` };
      }
      return { outcome: "blocked", error: "after the alteration the Tally voucher is in an unexpected state; manual review needed" };
    }
  }
}

/** Claimed job -> Tally -> backend acknowledgement. Never throws; a failed acknowledgement is retried by lease expiry. */
export async function runDeletionJob(
  job: DeletionJob,
  io: TallyIO,
  api: DeletionApi,
  log: (m: string) => void = () => undefined,
): Promise<DeletionResult> {
  let out: DeletionResult;
  let offline = false;
  try {
    const active = await activeCompany(io);
    if (active !== job.tally_company) {
      offline = true; // not the job's fault: do not use up an attempt
      out = { outcome: "retry", error: `Active Tally company is "${active ?? "unknown"}" but this correction is for "${job.tally_company}"` };
    } else {
      out = await applyDeletion(job, io);
    }
  } catch (e) {
    offline = e instanceof TallyOfflineError;
    out = { outcome: "retry", error: e instanceof Error ? e.message : String(e) };
  }
  log(`Deletion correction ${job.voucher_number} (${job.amount}): ${out.outcome}${out.correction ? ` / ${out.correction}` : ""}${out.error ? ` - ${out.error}` : ""}`);
  try {
    await api.call({
      action: "ack", job_id: job.job_id, outcome: out.outcome, correction: out.correction ?? null, error: out.error ?? null,
      result: { ...(out.detail ?? {}), offline },
    });
  } catch (e) {
    log(`  could not report the outcome (the job will be re-offered): ${(e as Error).message}`);
  }
  return out;
}
