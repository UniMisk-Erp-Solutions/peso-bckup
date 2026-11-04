import type { PlannedVoucher, PwtAccountingConfig } from "./types.ts";
import { round2, tallyDate, xmlEscape } from "./util.ts";

const ENV_OPEN = "<ENVELOPE>";

function importEnvelope(company: string, reportName: "All Masters" | "Vouchers", messages: string): string {
  return `${ENV_OPEN}<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>` +
    `<REQUESTDESC><REPORTNAME>${reportName}</REPORTNAME><STATICVARIABLES>` +
    `<SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA>${messages}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

/**
 * Read-only: which company is active in TallyPrime right now.
 * Validated on TallyPrime 7.1: a Company collection with COMPUTE of $$CurrentCompany returns the active
 * company on every row. (An inline report form returned an empty envelope, so it is not used.)
 */
export function activeCompanyRequest(): string {
  return `${ENV_OPEN}<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PWTCur</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE>` +
    `<COLLECTION NAME="PWTCur"><TYPE>Company</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD><COMPUTE>PWTCurCo:$$CurrentCompany</COMPUTE></COLLECTION>` +
    `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/** Read-only: names of every ledger in a company (used to create only the missing ones). */
export function ledgerNamesRequest(company: string, objectType: "Ledger" | "Group" = "Ledger"): string {
  return `${ENV_OPEN}<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PWTLedgerNames</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>` +
    `<SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE>` +
    `<COLLECTION NAME="PWTLedgerNames"><TYPE>${objectType}</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>` +
    `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export function mastersImportXml(
  company: string,
  cfg: PwtAccountingConfig,
  ledgers: { name: string; kind: "employee" | "expense" }[],
): string {
  const msgs = ledgers.map((l) => {
    const parent = l.kind === "employee" ? cfg.employeeLedgerParent : cfg.expenseLedgerParent;
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xmlEscape(l.name)}" ACTION="Create">` +
      `<NAME>${xmlEscape(l.name)}</NAME><PARENT>${xmlEscape(parent)}</PARENT>` +
      `<ISBILLWISEON>No</ISBILLWISEON><LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>${xmlEscape(l.name)}</NAME></NAME.LIST>` +
      `</LANGUAGENAME.LIST></LEDGER></TALLYMESSAGE>`;
  }).join("");
  return importEnvelope(company, "All Masters", msgs);
}

export function voucherXml(v: PlannedVoucher): string {
  const entries = v.lines.map((l) => {
    // Tally convention: debit = ISDEEMEDPOSITIVE Yes with NEGATIVE amount; credit = No with POSITIVE amount.
    const debit = l.side === "debit";
    const amt = (debit ? -1 : 1) * round2(l.amount);
    return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xmlEscape(l.ledger)}</LEDGERNAME>` +
      `<ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${amt.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
  }).join("");
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${xmlEscape(v.voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">` +
    `<DATE>${tallyDate(v.date)}</DATE><VOUCHERTYPENAME>${xmlEscape(v.voucherType)}</VOUCHERTYPENAME>` +
    `<VOUCHERNUMBER>${xmlEscape(v.voucherNumber)}</VOUCHERNUMBER><NARRATION>${xmlEscape(v.narration)}</NARRATION>` +
    `<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>${entries}</VOUCHER></TALLYMESSAGE>`;
}

export function vouchersImportXml(company: string, vouchers: readonly PlannedVoucher[]): string {
  return importEnvelope(company, "Vouchers", vouchers.map(voucherXml).join(""));
}

/** Read-only: every voucher in the company whose narration carries our tag, for a date range. */
export function voucherReadbackRequest(company: string, tag: string, fromIso: string, toIso: string): string {
  return `${ENV_OPEN}<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PWTVouchers</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>` +
    `<SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>` +
    `<SVFROMDATE>${tallyDate(fromIso)}</SVFROMDATE><SVTODATE>${tallyDate(toIso)}</SVTODATE></STATICVARIABLES><TDL><TDLMESSAGE>` +
    `<COLLECTION NAME="PWTVouchers"><TYPE>Voucher</TYPE>` +
    `<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD>` +
    `<NATIVEMETHOD>AllLedgerEntries.LedgerName</NATIVEMETHOD><NATIVEMETHOD>AllLedgerEntries.Amount</NATIVEMETHOD>` +
    `<FILTER>PWTTagged</FILTER></COLLECTION>` +
    `<SYSTEM TYPE="Formulae" NAME="PWTTagged">$Narration Contains "${xmlEscape(tag)}"</SYSTEM>` +
    `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/* ------------------------------------------------------------------ responses */

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function oneInt(xml: string, tag: string): number | null {
  const m = [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>\\s*(\\d+)\\s*</${tag}>`, "gi"))];
  return m.length === 1 ? Number(m[0][1]) : null;
}

export interface ImportOutcome {
  ok: boolean;
  created: number;
  altered: number;
  errors: number;
  lineErrors: string[];
}

/** Fail closed: anything that is not an unambiguous clean response is NOT ok. */
export function parseImportResponse(xml: string): ImportOutcome {
  const created = oneInt(xml, "CREATED");
  const altered = oneInt(xml, "ALTERED");
  const errors = oneInt(xml, "ERRORS");
  const exceptions = oneInt(xml, "EXCEPTIONS") ?? 0;
  const lineErrors = [...xml.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)].map((m) => decode(m[1].trim()));
  const ok = created !== null && altered !== null && errors === 0 && exceptions === 0 && lineErrors.length === 0;
  return { ok, created: created ?? 0, altered: altered ?? 0, errors: (errors ?? 0) + exceptions, lineErrors };
}

export function parseActiveCompany(xml: string): string | null {
  const m = /<PWTCURCO\b[^>]*>([\s\S]*?)<\/PWTCURCO>/i.exec(xml);
  return m && m[1].trim() ? decode(m[1].trim()) : null;
}

export function parseLedgerNames(xml: string): Set<string> {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<(?:LEDGER|GROUP)\b[^>]*\bNAME="([^"]*)"/gi)) out.add(decode(m[1]));
  for (const m of xml.matchAll(/<(LEDGER|GROUP)\b[^>]*>[\s\S]*?<\/\1>/gi)) {
    const n = /<NAME>([^<]*)<\/NAME>/i.exec(m[0]);
    if (n) out.add(decode(n[1].trim()));
  }
  return out;
}

/** Splits an import envelope into its TALLYMESSAGE fragments, keyed by the master NAME each creates. */
export function splitMasterMessages(xml: string): { name: string; fragment: string }[] {
  return [...xml.matchAll(/<TALLYMESSAGE\b[\s\S]*?<\/TALLYMESSAGE>/gi)].map((m) => {
    const nm = /<(?:LEDGER|GROUP)\b[^>]*\bNAME="([^"]*)"/i.exec(m[0]);
    return { name: nm ? decode(nm[1]) : "", fragment: m[0] };
  });
}

/** Rebuilds the envelope keeping only fragments whose master does not already exist in Tally. */
export function pruneMasters(
  xml: string,
  existing: ReadonlySet<string>,
): { xml: string; kept: string[]; skipped: string[] } {
  const parts = splitMasterMessages(xml);
  const keep = parts.filter((p) => p.name && !existing.has(p.name));
  const open = "<REQUESTDATA>";
  const head = xml.slice(0, xml.indexOf(open) + open.length);
  const tail = xml.slice(xml.indexOf("</REQUESTDATA>"));
  return {
    xml: head + keep.map((p) => p.fragment).join("") + tail,
    kept: keep.map((p) => p.name),
    skipped: parts.filter((p) => p.name && existing.has(p.name)).map((p) => p.name),
  };
}

export interface ReadbackVoucher {
  number: string;
  date: string;
  debit: number;
  credit: number;
  narration: string;
}

export function parseVoucherReadback(xml: string): ReadbackVoucher[] {
  const out: ReadbackVoucher[] = [];
  for (const m of xml.matchAll(/<VOUCHER\b[^>]*>([\s\S]*?)<\/VOUCHER>/gi)) {
    const b = m[1];
    // Real TallyPrime tags carry type attributes (<DATE TYPE="Date">, <AMOUNT TYPE="Amount">).
    const num = /<VOUCHERNUMBER\b[^>]*>([\s\S]*?)<\/VOUCHERNUMBER>/i.exec(b)?.[1];
    const date = /<DATE\b[^>]*>\s*(\d{8})\s*<\/DATE>/i.exec(b)?.[1];
    if (!date) continue;
    const narration = decode(/<NARRATION\b[^>]*>([\s\S]*?)<\/NARRATION>/i.exec(b)?.[1]?.trim() ?? "");
    let debit = 0;
    let credit = 0;
    for (const a of b.matchAll(/<(?:ALL)?LEDGERENTRIES\.LIST>[\s\S]*?<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi)) {
      const amt = Number(/<AMOUNT\b[^>]*>\s*(-?[\d.]+)\s*<\/AMOUNT>/i.exec(a[0])?.[1]);
      if (!Number.isFinite(amt)) continue;
      if (amt < 0) debit += -amt;
      else credit += amt;
    }
    // Journal vouchers use Tally's own auto-numbering, so the stable PesoWise voucher id lives in the narration
    // ("<TAG> PESO/08/01"). Match on that; fall back to the Tally number only if there is no tagged narration.
    const ref = /^\S+\s+(\S.*)$/.exec(narration)?.[1];
    out.push({
      number: ref ?? decode((num ?? "").trim()),
      date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      debit: round2(debit),
      credit: round2(credit),
      narration,
    });
  }
  return out;
}

export interface Reconciliation {
  ok: boolean;
  missing: string[];
  mismatched: string[];
  unbalanced: string[];
  /** Planned vouchers that exist MORE than once in Tally (a duplicate posting). */
  duplicated: string[];
}

/** A job may only be "completed" when every planned voucher is read back once, balanced, with the expected total. */
export function reconcile(planned: readonly PlannedVoucher[], readback: readonly ReadbackVoucher[]): Reconciliation {
  const byKey = new Map(readback.map((r) => [`${r.number}|${r.date}`, r]));
  const counts = new Map<string, number>();
  for (const r of readback) counts.set(`${r.number}|${r.date}`, (counts.get(`${r.number}|${r.date}`) ?? 0) + 1);
  const missing: string[] = [];
  const mismatched: string[] = [];
  const unbalanced: string[] = [];
  const duplicated: string[] = [];
  for (const p of planned) {
    const r = byKey.get(`${p.voucherNumber}|${p.date}`);
    if (!r) {
      missing.push(p.voucherNumber);
      continue;
    }
    if ((counts.get(`${p.voucherNumber}|${p.date}`) ?? 0) > 1) duplicated.push(p.voucherNumber);
    if (r.debit !== r.credit) unbalanced.push(p.voucherNumber);
    if (r.debit !== round2(p.total) || r.credit !== round2(p.total)) mismatched.push(p.voucherNumber);
  }
  return { ok: !missing.length && !mismatched.length && !unbalanced.length && !duplicated.length, missing, mismatched, unbalanced, duplicated };
}
