import type { TallyImportResult } from "./responseParser.js";
import type { TallyClient } from "./tallyClient.js";

export function splitTallyMessages(envelopeXml: string): string[] {
  return envelopeXml
    .split(/(?=<TALLYMESSAGE)/i)
    .filter((p) => p.includes("<TALLYMESSAGE"));
}

function wrapOneMessage(inner: string, companyEsc: string): string {
  const reportName = /<VOUCHER\b/i.test(inner)
    ? "Vouchers"
    : "All Masters";

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY>
<IMPORTDATA>
<REQUESTDESC>
<REPORTNAME>${reportName}</REPORTNAME>
<STATICVARIABLES>
<SVCURRENTCOMPANY>${companyEsc}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
${inner.trim()}
</REQUESTDATA>
</IMPORTDATA>
</BODY>
</ENVELOPE>`;
}

/**
 * One attempt only. No automatic Create-to-Alter fallback.
 * A duplicate must be handled through explicit reconciliation.
 */
export async function postTallyMessageWithDuplicateAlter(
  tally: TallyClient,
  inner: string,
  companyEsc: string,
): Promise<TallyImportResult> {
  const { parsed } = await tally.postImportXmlOnce(
    wrapOneMessage(inner, companyEsc),
  );

  return parsed;
}

/**
 * No blind retry or per-message replay after an ambiguous response.
 */
export async function postTallyBatchVerified(
  tally: TallyClient,
  envelopeXml: string,
  _companyEsc: string,
): Promise<TallyImportResult> {
  const { httpOk, parsed } = await tally.postImportXmlOnce(envelopeXml);
  if (!httpOk) {
    throw new Error("Tally returned an unsuccessful HTTP status; import outcome uncertain");
  }
  return parsed;
}

