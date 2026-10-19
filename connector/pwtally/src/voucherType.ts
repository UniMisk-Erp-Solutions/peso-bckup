/**
 * Makes sure the payment voucher type used by "Sync from Tally" exists in the paired company, so nobody has to create it by hand.
 * It only ever CREATES a missing voucher type (type of voucher: Payment). An existing one is never changed or deleted.
 */
import { activeCompany, type TallyIO } from "./engine.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const dec = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function voucherTypesRequest(company: string): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PWTVchTypes</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` +
    `<TDL><TDLMESSAGE><COLLECTION NAME="PWTVchTypes"><TYPE>VoucherType</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD></COLLECTION>` +
    `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/** name -> parent voucher type, as TallyPrime reports them. */
export function parseVoucherTypes(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<VOUCHERTYPE\b[^>]*\bNAME="([^"]*)"[^>]*>([\s\S]*?)<\/VOUCHERTYPE>/gi)) {
    const parent = /<PARENT\b[^>]*>([^<]*)</i.exec(m[2])?.[1];
    out.set(dec(m[1]), dec((parent ?? "").trim()));
  }
  return out;
}

export function createVoucherTypeXml(company: string, name: string): string {
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>` +
    `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>` +
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHERTYPE NAME="${esc(name)}" ACTION="Create"><NAME>${esc(name)}</NAME><PARENT>Payment</PARENT>` +
    `<LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>${esc(name)}</NAME></NAME.LIST></LANGUAGENAME.LIST></VOUCHERTYPE></TALLYMESSAGE>` +
    `</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

export type EnsureResult =
  | { ok: true; state: "exists" | "created" }
  | { ok: false; reason: string };

/** Create the voucher type when it is missing. Wrong-company protected; verified by reading Tally back. */
export async function ensurePaymentVoucherType(io: TallyIO, company: string, name: string): Promise<EnsureResult> {
  const wanted = name.trim();
  if (!wanted) return { ok: false, reason: "no voucher type name" };
  if ((await activeCompany(io)) !== company) return { ok: false, reason: "the paired company is not the active company" };

  const existing = parseVoucherTypes(await io.post(voucherTypesRequest(company)));
  if (existing.has(wanted)) {
    return existing.get(wanted) === "Payment" ? { ok: true, state: "exists" } : { ok: false, reason: `"${wanted}" already exists in Tally but is not a Payment voucher type; left unchanged` };
  }
  const res = await io.post(createVoucherTypeXml(company, wanted));
  const created = Number(/<CREATED\b[^>]*>\s*(\d+)\s*</i.exec(res)?.[1] ?? 0);
  const errors = Number(/<ERRORS\b[^>]*>\s*(\d+)\s*</i.exec(res)?.[1] ?? 0);
  if (errors > 0 || /<LINEERROR>/i.test(res)) return { ok: false, reason: `Tally rejected the voucher type: ${/<LINEERROR>([^<]*)</i.exec(res)?.[1] ?? `errors=${errors}`}` };
  const after = parseVoucherTypes(await io.post(voucherTypesRequest(company)));
  if (after.get(wanted) !== "Payment") return { ok: false, reason: `readback: "${wanted}" was not found as a Payment voucher type (created=${created})` };
  return { ok: true, state: "created" };
}
