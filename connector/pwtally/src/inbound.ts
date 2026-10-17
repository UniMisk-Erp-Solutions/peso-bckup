/**
 * Reverse sync (TallyPrime -> PesoWise): fetch "PesoWise Payment" vouchers from the paired Tally company and hand them to the
 * backend. The connector only READS Tally here; it never writes. The backend validates everything again and records money through
 * PesoWise's existing balance engine, so nothing in this file decides accounting.
 */
import { activeCompany, TallyOfflineError, type TallyIO } from "./engine.ts";

export const INBOUND_VOUCHER_TYPE = "PesoWise Payment";
const CHUNK = 100;

export interface InboundEntry {
  ledger: string;
  /** Tally sign: a DEBIT is negative, a CREDIT is positive. */
  amount: number;
  parent: string | null;
}

export interface InboundVoucher {
  guid: string;
  number: string;
  date: string; // ISO yyyy-mm-dd ("" when Tally gave none)
  type: string;
  narration: string;
  alter_id: number | null;
  master_id: number | null;
  cancelled: boolean;
  optional: boolean;
  entries: InboundEntry[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const dec = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Read-only: every voucher of the PesoWise Payment type, whatever its date. */
export function paymentVouchersRequest(company: string, voucherType: string = INBOUND_VOUCHER_TYPE): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PWTInbound</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` +
    `<SVFROMDATE>20000101</SVFROMDATE><SVTODATE>20991231</SVTODATE></STATICVARIABLES><TDL><TDLMESSAGE>` +
    `<COLLECTION NAME="PWTInbound"><TYPE>Voucher</TYPE>` +
    ["Date", "VoucherNumber", "VoucherTypeName", "Narration", "GUID", "AlterID", "MasterID", "IsCancelled", "IsOptional",
      "AllLedgerEntries.LedgerName", "AllLedgerEntries.Amount"].map((n) => `<NATIVEMETHOD>${n}</NATIVEMETHOD>`).join("") +
    `<FILTER>PWTInboundType</FILTER></COLLECTION>` +
    `<SYSTEM TYPE="Formulae" NAME="PWTInboundType">$VoucherTypeName = "${esc(voucherType)}"</SYSTEM>` +
    `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/** Read-only: ledger name -> parent group, used to recognise cash/bank ledgers. */
export function ledgerParentsRequest(company: string): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PWTLedgerParents</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` +
    `<TDL><TDLMESSAGE><COLLECTION NAME="PWTLedgerParents"><TYPE>Ledger</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD></COLLECTION>` +
    `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export function parseLedgerParents(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<LEDGER\b[^>]*\bNAME="([^"]*)"[^>]*>([\s\S]*?)<\/LEDGER>/gi)) {
    const parent = /<PARENT\b[^>]*>([^<]*)</i.exec(m[2])?.[1];
    if (parent !== undefined) out.set(dec(m[1]), dec(parent.trim()));
  }
  return out;
}

const tag = (b: string, name: string): string | undefined =>
  new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(b)?.[1];
const yes = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "yes";

export function parsePaymentVouchers(xml: string, parents: ReadonlyMap<string, string>): InboundVoucher[] {
  const out: InboundVoucher[] = [];
  for (const m of xml.matchAll(/<VOUCHER\b[^>]*>([\s\S]*?)<\/VOUCHER>/gi)) {
    const b = m[1];
    const guid = tag(b, "GUID")?.trim();
    if (!guid) continue;
    const d = /^(\d{4})(\d{2})(\d{2})$/.exec((tag(b, "DATE") ?? "").trim());
    const entries: InboundEntry[] = [];
    for (const e of b.matchAll(/<(?:ALL)?LEDGERENTRIES\.LIST>([\s\S]*?)<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi)) {
      const ledger = dec((tag(e[1], "LEDGERNAME") ?? "").trim());
      const amount = Number((tag(e[1], "AMOUNT") ?? "").trim());
      if (!ledger || !Number.isFinite(amount)) continue;
      entries.push({ ledger, amount, parent: parents.get(ledger) ?? null });
    }
    const n = (v: string | undefined) => (v && Number.isFinite(Number(v.trim())) ? Number(v.trim()) : null);
    out.push({
      guid,
      number: dec((tag(b, "VOUCHERNUMBER") ?? "").trim()),
      date: d ? `${d[1]}-${d[2]}-${d[3]}` : "",
      type: dec((tag(b, "VOUCHERTYPENAME") ?? "").trim()),
      narration: dec((tag(b, "NARRATION") ?? "").trim()),
      alter_id: n(tag(b, "ALTERID")),
      master_id: n(tag(b, "MASTERID")),
      cancelled: yes(tag(b, "ISCANCELLED")),
      optional: yes(tag(b, "ISOPTIONAL")),
      entries,
    });
  }
  return out;
}

export interface InboundApi {
  call<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T>;
}

export interface InboundJob {
  job_id: string;
  tally_company: string;
  /** The exact Tally voucher type to read (organisation setting; default "PesoWise Payment"). */
  voucher_type?: string;
}

export interface InboundResult {
  ok: boolean;
  fetched: number;
  error?: string;
  summary?: Record<string, unknown>;
}

/** Fetch -> upload in chunks -> finish. Any failure is reported to the backend so the job never hangs. */
export async function runInboundJob(
  job: InboundJob,
  io: TallyIO,
  api: InboundApi,
  log: (m: string) => void = () => undefined,
): Promise<InboundResult> {
  let total = 0;
  try {
    // Wrong-company protection again, immediately before reading.
    const active = await activeCompany(io);
    if (active !== job.tally_company) {
      throw new Error(`Active Tally company is "${active ?? "unknown"}" but this sync is for "${job.tally_company}"`);
    }
    const parents = parseLedgerParents(await io.post(ledgerParentsRequest(job.tally_company)));
    const vtype = job.voucher_type || INBOUND_VOUCHER_TYPE;
    const vouchers = parsePaymentVouchers(await io.post(paymentVouchersRequest(job.tally_company, vtype)), parents);
    total = vouchers.length;
    log(`Reverse sync: ${total} "${vtype}" voucher(s) read from Tally`);
    for (let i = 0; i < vouchers.length; i += CHUNK) {
      await api.call({ action: "submit", job_id: job.job_id, seq_start: i, vouchers: vouchers.slice(i, i + CHUNK), total });
    }
    const fin = await api.call<{ result?: Record<string, unknown> }>({ action: "finish", job_id: job.job_id, total });
    return { ok: true, fetched: total, summary: fin.result };
  } catch (e) {
    const msg = e instanceof TallyOfflineError ? "TallyPrime is not reachable" : e instanceof Error ? e.message : String(e);
    try {
      await api.call({ action: "finish", job_id: job.job_id, total, error: msg });
    } catch { /* the lease will expire and the job can be retried */ }
    return { ok: false, fetched: total, error: msg };
  }
}
