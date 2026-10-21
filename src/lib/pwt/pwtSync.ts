/**
 * PesoWise -> TallyPrime ("pwt") browser client.
 * One request starts a sync; progress and history come from admin-checked RPCs. The browser never talks to
 * the worker, the connector, or Tally.
 */
import { supabase } from "@/integrations/supabase/client";
import { activeCustomFieldFilters } from "@/lib/detailedExpenseReportFilters";

/** The report filters a sync is started with (the same values the report panel already holds). */
export interface PwtSyncParams {
  reportType: string;
  category?: string | null;
  userId?: string | null;
  userIds?: string[] | null;
  engineerStatus?: string | null;
  hoStatus?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  customFieldFilters?: Record<string, string>;
  selectedYear?: string;
  selectedMonth?: string;
  selectedWeek?: string;
}

/** Server-bound parameters only: no row data, no pagination, no preview state. */
export function buildPwtParameters(input: PwtSyncParams): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (input.category && input.category !== "all") params.category = input.category;
  if (input.userId && input.userId !== "all") params.user_id = input.userId;
  if (input.userIds?.length) params.user_ids = input.userIds;
  if (input.engineerStatus && input.engineerStatus !== "all") params.engineer_status = input.engineerStatus;
  if (input.hoStatus && input.hoStatus !== "all") params.ho_status = input.hoStatus;
  if (input.dateFrom) params.date_from = input.dateFrom;
  if (input.dateTo) params.date_to = input.dateTo;
  const custom = input.customFieldFilters ? activeCustomFieldFilters(input.customFieldFilters) : {};
  if (Object.keys(custom).length) params.custom_field_filters = custom;
  if (input.selectedYear) params.year = input.selectedYear;
  if (input.selectedMonth && input.selectedMonth !== "all") params.month = input.selectedMonth;
  if (input.selectedWeek && input.selectedWeek !== "all") params.week = input.selectedWeek;
  return params;
}

export type PwtReportType = "daily_project" | "detailed_expense" | "claim_verification" | "claim_approval";
export type PwtJobStatus = "queued" | "preparing" | "delivering" | "completed" | "needs_attention" | "failed" | "cancelled";

export interface PwtIssue {
  code: string;
  sourceId: string;
  detail: string;
  blocking: boolean;
}

export interface PwtJob {
  id: string;
  report_type: PwtReportType;
  status: PwtJobStatus;
  tally_company: string;
  created_at: string;
  completed_at: string | null;
  row_count: number;
  posted_count: number;
  voucher_count: number;
  issue_count: number;
  blocking_count: number;
  error: string | null;
  progress_current: number;
  progress_total: number | null;
  issues: PwtIssue[];
}

export interface PwtConnector {
  id: string;
  device_name: string;
  tally_company: string;
  tally_version: string | null;
  status: "active" | "revoked";
  paired_at: string;
  last_seen_at: string | null;
  last_active_company: string | null;
  last_error: string | null;
}

/** The existing panel names the daily report "daily_project_report"; pwt uses "daily_project". */
export function toPwtReportType(panelType: string | undefined | null): PwtReportType {
  if (!panelType || panelType === "daily_project_report" || panelType === "daily_project") return "daily_project";
  if (panelType === "detailed_expense" || panelType === "claim_verification" || panelType === "claim_approval") return panelType;
  throw new Error(`Unsupported report type for Tally sync: ${panelType}`);
}

export const PWT_STATUS_LABEL: Record<PwtJobStatus, string> = {
  queued: "Queued",
  preparing: "Preparing",
  delivering: "Delivering",
  completed: "Completed",
  needs_attention: "Needs attention",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const isPwtActive = (s: PwtJobStatus) => s === "queued" || s === "preparing" || s === "delivering";

/** Tally's "Voucher date is missing" means the date is outside the company's financial year; say so and how to fix it. */
export function friendlyTallyError(error: string | null | undefined): string | null {
  if (!error) return null;
  if (/voucher date is missing/i.test(error)) {
    const ids = [...error.matchAll(/voucher (PESO\/\d{2}\/\d{2})/gi)].map((m) => m[1]);
    const note = /Connector note:[^]*$/.exec(error)?.[0];
    if (note && /inside the books/.test(note)) {
      return `Tally refused ${ids.length ? ids.join(", ") : "some vouchers"} because of their date, although the company's books cover it. ${note} ` +
        `Check that the dates were saved in Tally (Alt+F3, Alter, Ctrl+A) and that TallyPrime is fully licensed; in Educational mode Tally limits which dates it accepts.`;
    }
    if (note && /could not read/.test(note)) {
      return `Tally refused ${ids.length ? ids.join(", ") : "some vouchers"} because of their date. ${note} Make sure the paired company is the one open in TallyPrime, then sync again.`;
    }
    return `Tally refused ${ids.length ? ids.join(", ") : "some vouchers"} because their date is outside this company's financial year. In Tally open Alter Company (Alt+F3) and set "Financial year beginning from" and "Books beginning from" to a date before the earliest expense month (for example 1-Apr-2026), then sync again. Vouchers already posted stay; only the rest are sent.`;
  }
  return error;
}

/** One short, actionable line for a job (never raw stack traces). */
export function describePwtJob(j: PwtJob, connectorOnline?: boolean): string {
  switch (j.status) {
    case "queued":
      return "Waiting for the server to start.";
    case "preparing":
      return j.progress_total
        ? `Reading the report: ${j.progress_current.toLocaleString()} of ${j.progress_total.toLocaleString()} rows.`
        : `Reading the report: ${j.progress_current.toLocaleString()} rows so far.`;
    case "delivering":
      if (connectorOnline === false) {
        return "Prepared, but waiting: the connector on the Tally PC is offline. Switch on that PC and open the paired company in TallyPrime; this sync then finishes by itself.";
      }
      return "Prepared. The Windows connector delivers it to TallyPrime and verifies it; keep TallyPrime open on the paired company.";
    case "completed":
      return j.voucher_count
        ? `Verified in TallyPrime: ${j.voucher_count} voucher(s) for ${j.posted_count} expense(s).`
        : `Verified in TallyPrime. No new vouchers were needed.`;
    case "needs_attention": {
      if (j.blocking_count > 0) {
        const first = j.issues.find((i) => i.blocking);
        return `${j.blocking_count} row(s) could not be posted${first ? `, e.g. ${first.detail}` : ""}. Fix the mapping or the data, then sync again.`;
      }
      return friendlyTallyError(j.error) ?? "Delivery needs attention. Check the connector on the Tally PC.";
    }
    case "failed":
      return friendlyTallyError(j.error) ?? "The sync failed before delivery.";
    default:
      return "";
  }
}

type RpcResult<T> = Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = <T,>(name: string, args: Record<string, unknown>): RpcResult<T> =>
  (supabase as unknown as { rpc: (n: string, a: Record<string, unknown>) => RpcResult<T> }).rpc(name, args);

export async function startPwtSync(
  input: PwtSyncParams & { organizationId: string },
): Promise<{ jobId: string; deduplicated: boolean }> {
  const report = toPwtReportType(input.reportType as string);
  const parameters = buildPwtParameters(input);
  const { data, error } = await supabase.functions.invoke("pwt-start-sync", {
    body: { organization_id: input.organizationId, report_type: report, parameters },
  });
  if (error) throw new Error(error.message || "Unable to start Tally sync");
  const p = data as { accepted?: boolean; job_id?: string; deduplicated?: boolean; error?: string } | null;
  if (!p?.accepted || !p.job_id) throw new Error(p?.error ?? "Unable to start Tally sync");
  return { jobId: p.job_id, deduplicated: p.deduplicated === true };
}

/** One short preparation slice of a running sync. Large syncs are prepared in several slices; the page keeps asking until done. */
export interface PwtSliceResult {
  claimed: boolean;
  done: boolean;
  status?: string;
  phase?: "read" | "plan";
  progress?: { current: number; total: number | null };
  error?: string;
}

export async function continuePwtJob(organizationId: string, jobId: string): Promise<PwtSliceResult> {
  const { data, error } = await supabase.functions.invoke("pwt-start-sync", { body: { action: "continue", organization_id: organizationId, job_id: jobId } });
  if (error) throw new Error(error.message || "Could not continue the sync");
  return (data ?? { claimed: false, done: false }) as PwtSliceResult;
}

export async function listPwtJobs(organizationId: string, limit = 10): Promise<PwtJob[]> {
  const { data, error } = await rpc<PwtJob[]>("pwt_list_jobs_v1", { p_organization_id: organizationId, p_limit: limit });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listPwtConnectors(organizationId: string): Promise<PwtConnector[]> {
  const { data, error } = await rpc<PwtConnector[]>("pwt_list_connectors_v1", { p_organization_id: organizationId });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 12-char code from an unambiguous alphabet. Only its hash is stored server-side. */
export function generatePairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export async function createPairingCode(organizationId: string, tallyCompany: string): Promise<string> {
  const code = generatePairingCode();
  const { error } = await rpc("pwt_create_pairing_code_v1", {
    p_organization_id: organizationId,
    p_code_hash: await sha256Hex(code),
    p_tally_company: tallyCompany.trim(),
  });
  if (error) throw new Error(error.message);
  return code;
}

export async function revokePwtConnector(organizationId: string, connectorId: string): Promise<void> {
  const { error } = await rpc("pwt_revoke_connector_v1", { p_organization_id: organizationId, p_connector: connectorId });
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ mapping settings */

export interface PwtCategoryRule {
  expenseType: string;
  expenseLedger: string;
  serial: number;
  aliases?: string[];
}

export interface PwtConfig {
  categories: PwtCategoryRule[];
  voucherPrefix?: string;
  expenseSide?: "debit" | "credit";
  voucherType?: string;
  /** Also store the report rows in Tally (hidden ledgers for the PesoWise Reports screens). Off by default. */
  reportRowsInTally?: boolean;
  /** Voucher date inside the month: last day (default) or first day (for Tally editions that refuse month-end dates). */
  postingDatePolicy?: "month_end" | "month_start";
}

/** Mirrors the database validation so the user gets the message before saving. Returns "" when valid. */
export function validatePwtConfig(c: PwtConfig): string {
  if (!c.categories.length) return "Add at least one expense category.";
  const serials = new Set<number>();
  const types = new Set<string>();
  for (const r of c.categories) {
    if (!r.expenseType.trim()) return "Every row needs a PesoWise expense type.";
    if (!r.expenseLedger.trim()) return `"${r.expenseType}" needs a Tally expense ledger name.`;
    if (!Number.isInteger(r.serial) || r.serial < 1 || r.serial > 99) return `"${r.expenseType}": serial must be a whole number from 1 to 99.`;
    if (serials.has(r.serial)) return `Serial ${r.serial} is used twice. Each category needs its own serial.`;
    const k = r.expenseType.trim().toLowerCase();
    if (types.has(k)) return `"${r.expenseType}" appears twice.`;
    serials.add(r.serial);
    types.add(k);
  }
  if (c.voucherPrefix !== undefined && !/^[A-Za-z0-9]{1,10}$/.test(c.voucherPrefix)) return "Voucher prefix must be 1-10 letters or digits.";
  return "";
}

/** Best-guess Tally ledger for an expense type name (keywords); anything unrecognised goes to Miscellaneous Expenses. */
export function suggestLedger(expenseType: string): string {
  const t = expenseType.toLowerCase();
  const has = (...w: string[]) => w.some((x) => t.includes(x));
  if (has("hotel", "guest house", "lodg", "stay", "accommodation")) return "Lodging Expenses";
  if (has("petrol", "fuel", "diesel", "conveyance", "cab", "taxi")) return "Conveyance Expenses";
  if (has("travel", "bus", "train", "flight", "ticket", "metro", "food", "meal")) return "Travelling Expenses";
  if (has("mobile", "phone", "recharge", "telephone", "internet", "data card")) return "Telephone Expenses";
  if (has("material", "stores", "consumable", "purchase")) return "Consumable Stores - URD";
  if (has("manpower", "labour", "labor", "contra")) return "Labour Charges Expenses-URD";
  if (has("laptop", "rent", "equipment")) return "Rent Expenses - Equipment";
  if (has("xerox", "printing", "courier", "stationery", "medical", "site", "other")) return "Site Expenses";
  if (has("incentive", "bonus")) return "Incentive Expenses";
  return "Miscellaneous Expenses";
}

/** Adds a row (with a suggested ledger and the next free number) for every PesoWise expense type that has no mapping yet, and fills blank ledgers. */
export function autoMapRules(rules: PwtCategoryRule[], expenseTypes: string[]): { rules: PwtCategoryRule[]; added: number; filled: number } {
  const known = (n: string) => rules.some((r) => [r.expenseType, ...(r.aliases ?? [])].some((x) => x.trim().toLowerCase() === n.trim().toLowerCase()));
  let next = Math.max(0, ...rules.filter((r) => r.serial < 99).map((r) => r.serial));
  const out = rules.map((r) => ({ ...r }));
  let filled = 0;
  for (const r of out) if (!r.expenseLedger.trim() && r.expenseType.trim()) { r.expenseLedger = suggestLedger(r.expenseType); filled += 1; }
  let added = 0;
  for (const name of [...new Set(expenseTypes.map((n) => n.trim()).filter(Boolean))]) {
    if (known(name) || next >= 98) continue;
    next += 1;
    out.push({ serial: next, expenseType: name, expenseLedger: suggestLedger(name) });
    added += 1;
  }
  return { rules: out, added, filled };
}

/** Expense types (already saved) whose Tally ledger the admin has now changed. */
export function changedLedgers(saved: PwtCategoryRule[], now: PwtCategoryRule[]): string[] {
  return now
    .filter((r) => {
      const old = saved.find((x) => x.expenseType.trim().toLowerCase() === r.expenseType.trim().toLowerCase());
      return !!old && old.expenseLedger.trim() !== r.expenseLedger.trim();
    })
    .map((r) => r.expenseType);
}

/** Expense types (already saved) whose voucher number was changed. */
export function changedSerials(saved: PwtCategoryRule[], now: PwtCategoryRule[]): string[] {
  return now
    .filter((r) => {
      const old = saved.find((x) => x.expenseType.trim().toLowerCase() === r.expenseType.trim().toLowerCase());
      return !!old && old.serial !== r.serial;
    })
    .map((r) => r.expenseType);
}

/** Ledgers that more than one expense type posts to (allowed, but the accountant should know: Tally shows them together). */
export function sharedLedgers(rules: PwtCategoryRule[]): { ledger: string; types: string[] }[] {
  const by = new Map<string, string[]>();
  for (const r of rules) {
    const k = r.expenseLedger.trim();
    if (!k) continue;
    by.set(k, [...(by.get(k) ?? []), r.expenseType]);
  }
  return [...by.entries()].filter(([, v]) => v.length > 1).map(([ledger, types]) => ({ ledger, types }));
}

/** Expense types the last syncs could not map (so the admin can add them in one click). */
export function unmappedTypesFromJobs(jobs: PwtJob[]): string[] {
  const out = new Set<string>();
  for (const j of jobs) {
    for (const i of j.issues ?? []) {
      if (i.code !== "UNMAPPED_EXPENSE_TYPE") continue;
      const m = /expense type "([^"]*)"/.exec(i.detail);
      if (m && m[1]) out.add(m[1]);
    }
  }
  return [...out];
}

export async function getPwtConfig(organizationId: string): Promise<PwtConfig | null> {
  const { data, error } = await rpc<PwtConfig | null>("pwt_get_config_v1", { p_organization_id: organizationId });
  if (error) throw new Error(error.message);
  return data;
}

export async function savePwtConfig(organizationId: string, config: PwtConfig): Promise<void> {
  const problem = validatePwtConfig(config);
  if (problem) throw new Error(problem);
  const { error } = await rpc("pwt_save_config_v1", { p_organization_id: organizationId, p_config: config });
  if (error) throw new Error(error.message);
}

/** Built-in defaults shown when an organisation has not saved its own mapping yet (same as the server's). */
export const DEFAULT_PWT_CATEGORIES: PwtCategoryRule[] = [
  { serial: 1, expenseType: "Travelling (Public and Private Transport)", expenseLedger: "Travelling Expenses" },
  { serial: 2, expenseType: "Material Purchase", expenseLedger: "Consumable Stores - URD" },
  { serial: 3, expenseType: "Other ( Xerox, Printing, Courier, Stationery & Medical )", expenseLedger: "Site Expenses", aliases: ["Other ( Xerox, Printing, Courier & Stationery )", "other"] },
  { serial: 4, expenseType: "Laptop Rent", expenseLedger: "Rent Expenses - Equipment" },
  { serial: 5, expenseType: "Hotel/Guest House", expenseLedger: "Lodging Expenses" },
  { serial: 6, expenseType: "Petrol Expense (Bike and Car)", expenseLedger: "Conveyance Expenses" },
  { serial: 7, expenseType: "Local Manpower", expenseLedger: "Labour Charges Expenses-URD" },
  { serial: 8, expenseType: "Mobile Recharges", expenseLedger: "Telephone Expenses" },
  { serial: 9, expenseType: "Food", expenseLedger: "Travelling Expenses" },
  { serial: 10, expenseType: "Incentive", expenseLedger: "Incentive Expenses" },
  { serial: 99, expenseType: "N/A", expenseLedger: "Miscellaneous Expenses", aliases: ["na", "none", "-"] },
];

/** Tally ledgers offered in the Ledger mapping drop-down (any other name can be typed with "New ledger…"). */
export const PWT_LEDGER_CHOICES = [
  "Travelling Expenses", "Consumable Stores - URD", "Site Expenses", "Rent Expenses - Equipment", "Lodging Expenses",
  "Conveyance Expenses", "Labour Charges Expenses-URD", "Telephone Expenses", "Incentive Expenses", "Miscellaneous Expenses",
];

/** A saved mapping that predates the N/A rule gets it added (same as the server), unless N/A or serial 99 is already used. */
export function withNaRow(rules: PwtCategoryRule[]): PwtCategoryRule[] {
  const na = DEFAULT_PWT_CATEGORIES.find((r) => r.serial === 99)!;
  const isNa = (r: PwtCategoryRule) => r.expenseType.trim().toLowerCase() === "n/a";
  if (rules.some(isNa) && !rules.some((r) => r.serial === 99 && !isNa(r))) rules = rules.map((r) => (isNa(r) ? { ...r, serial: 99 } : r));
  const has = rules.some((r) => [r.expenseType, ...(r.aliases ?? [])].some((n) => n.trim().toLowerCase() === "n/a"));
  return has || rules.some((r) => r.serial === 99) ? rules : [...rules, na];
}

/** A connector counts as online if it reported in during the last minute. */
export function anyConnectorOnline(cs: PwtConnector[]): boolean {
  return cs.some((c) => c.status === "active" && !!c.last_seen_at && Date.now() - new Date(c.last_seen_at).getTime() < 60_000);
}
