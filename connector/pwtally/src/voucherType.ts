/**
 * Makes sure the payment voucher type used by "Sync from Tally" exists in the paired company, so nobody has to create it by hand.
 * It creates a missing voucher type (type of voucher: Payment, active, automatically numbered) and switches one on if it exists but is
 * inactive, so it shows in TallyPrime's voucher type list. A voucher type that is not a Payment type is never touched.
 */
import { activeCompany, type TallyIO } from "./engine.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const dec = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function voucherTypesRequest(company: string): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PWTVchTypes</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` +
    `<TDL><TDLMESSAGE><COLLECTION NAME="PWTVchTypes"><TYPE>VoucherType</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD>` +
    `<NATIVEMETHOD>IsActive</NATIVEMETHOD><NATIVEMETHOD>NumberingMethod</NATIVEMETHOD></COLLECTION>` +
    `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export interface VoucherTypeInfo {
  parent: string;
  active: boolean;
  numbering: string;
}

/** name -> parent, active flag and numbering, as TallyPrime reports them. */
export function parseVoucherTypeInfo(xml: string): Map<string, VoucherTypeInfo> {
  const out = new Map<string, VoucherTypeInfo>();
  for (const m of xml.matchAll(/<VOUCHERTYPE\b[^>]*\bNAME="([^"]*)"[^>]*>([\s\S]*?)<\/VOUCHERTYPE>/gi)) {
    const tag = (t: string) => new RegExp(`<${t}\\b[^>]*>([^<]*)<`, "i").exec(m[2])?.[1]?.trim();
    out.set(dec(m[1]), { parent: dec(tag("PARENT") ?? ""), active: (tag("ISACTIVE") ?? "Yes").toLowerCase() !== "no", numbering: tag("NUMBERINGMETHOD") ?? "" });
  }
  return out;
}

/** name -> parent voucher type (kept for callers that only need the parent). */
export function parseVoucherTypes(xml: string): Map<string, string> {
  return new Map([...parseVoucherTypeInfo(xml)].map(([n, i]) => [n, i.parent]));
}

function masterXml(company: string, name: string, action: "Create" | "Alter"): string {
  // Active and automatically numbered, so it appears in Tally's voucher type list and numbers itself like any Payment voucher.
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>` +
    `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>` +
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHERTYPE NAME="${esc(name)}" ACTION="${action}"><NAME>${esc(name)}</NAME><PARENT>Payment</PARENT>` +
    `<ISACTIVE>Yes</ISACTIVE><NUMBERINGMETHOD>Automatic</NUMBERINGMETHOD>` +
    `<LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>${esc(name)}</NAME></NAME.LIST></LANGUAGENAME.LIST></VOUCHERTYPE></TALLYMESSAGE>` +
    `</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

export const createVoucherTypeXml = (company: string, name: string) => masterXml(company, name, "Create");
export const alterVoucherTypeXml = (company: string, name: string) => masterXml(company, name, "Alter");

export type EnsureResult =
  | { ok: true; state: "exists" | "created" | "activated" }
  | { ok: false; reason: string };

function importResult(res: string): { ok: boolean; why: string } {
  const errors = Number(/<ERRORS\b[^>]*>\s*(\d+)\s*</i.exec(res)?.[1] ?? 0);
  const line = /<LINEERROR>([^<]*)</i.exec(res)?.[1];
  return errors > 0 || line ? { ok: false, why: line ?? `errors=${errors}` } : { ok: true, why: "" };
}

/** Create the voucher type when missing, switch it on when inactive; verified by reading Tally back. Wrong-company protected. */
export async function ensurePaymentVoucherType(io: TallyIO, company: string, name: string): Promise<EnsureResult> {
  const wanted = name.trim();
  if (!wanted) return { ok: false, reason: "no voucher type name" };
  if ((await activeCompany(io)) !== company) return { ok: false, reason: "the paired company is not the active company" };

  const existing = parseVoucherTypeInfo(await io.post(voucherTypesRequest(company))).get(wanted);
  if (existing && existing.parent !== "Payment") {
    return { ok: false, reason: `"${wanted}" already exists in Tally but is not a Payment voucher type; left unchanged` };
  }
  if (existing && existing.active) return { ok: true, state: "exists" };

  const res = importResult(await io.post(existing ? alterVoucherTypeXml(company, wanted) : createVoucherTypeXml(company, wanted)));
  if (!res.ok) return { ok: false, reason: `Tally rejected the voucher type: ${res.why}` };
  const after = parseVoucherTypeInfo(await io.post(voucherTypesRequest(company))).get(wanted);
  if (!after || after.parent !== "Payment" || !after.active) return { ok: false, reason: `readback: "${wanted}" is not an active Payment voucher type in Tally` };
  return { ok: true, state: existing ? "activated" : "created" };
}
