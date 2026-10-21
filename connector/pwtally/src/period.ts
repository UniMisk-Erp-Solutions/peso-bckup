/**
 * Makes sure the paired Tally company's books cover every voucher date before vouchers are sent, so Tally never answers
 * "Voucher date is missing". A voucher dated before the company's "Financial year beginning from" / "Books beginning from" is refused by Tally.
 *
 * When the company only holds PesoWise entries (or nothing), its start date is moved EARLIER (same day and month, earlier year) to
 * cover the earliest voucher. A company that has its own accounting entries is never changed: the sync reports a plain instruction instead.
 * Verified live in TallyPrime: altering both dates through the XML interface works, existing vouchers are kept, and vouchers dated
 * beyond the first 12 months are accepted once the books begin earlier.
 */
import type { TallyIO } from "./engine.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const dec = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "1-Apr-26" (TallyPrime's display form) -> "2026-04-01". */
export function tallyDisplayToIso(s: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(s.trim());
  if (!m) return null;
  const mon = MONTHS.indexOf(m[2].toLowerCase());
  if (mon < 0) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${String(mon + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

export const isoToDisplay = (iso: string): string => {
  const [y, m, d] = iso.split("-");
  return `${Number(d)}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}-${y}`;
};

export function periodRequest(): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>PWTPer</ID></HEADER><BODY><DESC>` +
    `<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE>` +
    `<REPORT NAME="PWTPer"><FORMS>PWTPerF</FORMS></REPORT><FORM NAME="PWTPerF"><PARTS>PWTPerP</PARTS></FORM>` +
    `<PART NAME="PWTPerP"><LINES>PWTPerL</LINES><REPEAT>PWTPerL : PWTCo</REPEAT><SCROLLED>Vertical</SCROLLED></PART>` +
    `<LINE NAME="PWTPerL"><FIELDS>PWTPerFld</FIELDS></LINE>` +
    `<COLLECTION NAME="PWTCo"><TYPE>Company</TYPE><FETCH>Name,BooksFrom,StartingFrom</FETCH></COLLECTION>` +
    `<FIELD NAME="PWTPerFld"><SET>$Name + "|" + $$String:$BooksFrom + "|" + $$String:$StartingFrom</SET></FIELD>` +
    `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export interface CompanyPeriod {
  booksFrom: string;
  startingFrom: string;
}

/** company name -> its period (ISO dates), for every company TallyPrime has loaded. */
export function parsePeriods(xml: string): Map<string, CompanyPeriod> {
  const out = new Map<string, CompanyPeriod>();
  for (const m of xml.matchAll(/<PWTPERFLD\b[^>]*>([^<]*)</gi)) {
    const [name, b, s] = dec(m[1]).split("|");
    const booksFrom = tallyDisplayToIso(b ?? "");
    const startingFrom = tallyDisplayToIso(s ?? "");
    if (name && booksFrom && startingFrom) out.set(name.trim(), { booksFrom, startingFrom });
  }
  return out;
}

export function alterPeriodXml(company: string, startIso: string): string {
  const d = startIso.replace(/-/g, "");
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>` +
    `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>` +
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><COMPANY NAME="${esc(company)}" ACTION="Alter"><NAME>${esc(company)}</NAME>` +
    `<STARTINGFROM>${d}</STARTINGFROM><BOOKSFROM>${d}</BOOKSFROM></COMPANY></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

export function companyVouchersRequest(company: string): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PWTPerV</ID></HEADER><BODY><DESC>` +
    `<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` +
    `<SVFROMDATE>20000101</SVFROMDATE><SVTODATE>20991231</SVTODATE></STATICVARIABLES><TDL><TDLMESSAGE>` +
    `<COLLECTION NAME="PWTPerV"><TYPE>Voucher</TYPE><NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD></COLLECTION>` +
    `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/** Vouchers that are not PesoWise's own ("PWT ..." narration, or a PESO Wise Payment voucher). */
export function countForeignVouchers(xml: string): number {
  let n = 0;
  // Real vouchers carry REMOTEID; a bare <VOUCHER>87</VOUCHER> is only the company's voucher counter.
  for (const m of xml.matchAll(/<VOUCHER\b[^>]*\bREMOTEID=[^>]*>([\s\S]*?)<\/VOUCHER>/gi)) {
    const nar = dec(/<NARRATION\b[^>]*>([^<]*)</i.exec(m[1])?.[1] ?? "").trim();
    const type = dec(/<VOUCHERTYPENAME\b[^>]*>([^<]*)</i.exec(m[1])?.[1] ?? "");
    if (!/^PWT[ -]/i.test(nar) && !/wise payment/i.test(type)) n += 1;
  }
  return n;
}

/** The start date to move to: same day and month as the current start, in the latest year that is on or before the earliest voucher. */
export function coveringStart(currentStartIso: string, earliestIso: string): string {
  const [, mm, dd] = currentStartIso.split("-");
  let y = Number(earliestIso.slice(0, 4));
  if (`${y}-${mm}-${dd}` > earliestIso) y -= 1;
  return `${y}-${mm}-${dd}`;
}

export type PeriodResult =
  | { ok: true; action: "inside" | "unknown" }
  | { ok: true; action: "extended"; from: string; to: string }
  | { ok: false; reason: string };

export async function ensureCompanyPeriod(io: TallyIO, company: string, earliestIso: string): Promise<PeriodResult> {
  const p = parsePeriods(await io.post(periodRequest())).get(company);
  if (!p) return { ok: true, action: "unknown" }; // cannot read it: let Tally decide, as before
  const start = p.startingFrom < p.booksFrom ? p.startingFrom : p.booksFrom;
  const covered = (s: CompanyPeriod) => earliestIso >= s.startingFrom && earliestIso >= s.booksFrom;
  if (covered(p)) return { ok: true, action: "inside" };

  const newStart = coveringStart(start, earliestIso);
  if (countForeignVouchers(await io.post(companyVouchersRequest(company))) > 0) {
    return {
      ok: false,
      reason: `This Tally company already has its own entries and starts on ${isoToDisplay(start)}, so PesoWise did not change it. ` +
        `In Tally press Alt+F3, Alter, and set "Financial year beginning from" and "Books beginning from" to ${isoToDisplay(newStart)} or earlier, then sync again.`,
    };
  }
  const res = await io.post(alterPeriodXml(company, newStart));
  const errors = Number(/<ERRORS\b[^>]*>\s*(\d+)\s*</i.exec(res)?.[1] ?? 0);
  const line = /<LINEERROR>([^<]*)</i.exec(res)?.[1];
  if (errors > 0 || line) return { ok: false, reason: `Tally would not move the company start to ${isoToDisplay(newStart)}: ${line ?? `errors=${errors}`}` };
  const after = parsePeriods(await io.post(periodRequest())).get(company);
  if (!after || !covered(after)) return { ok: false, reason: `The company start date could not be moved to ${isoToDisplay(newStart)}. Set it in Tally (Alt+F3, Alter).` };
  return { ok: true, action: "extended", from: start, to: newStart };
}
