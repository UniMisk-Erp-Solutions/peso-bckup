export type MetadataReportType =
  | "claim_verification"
  | "claim_approval"
  | "detailed_expense"
  | "daily_project_report";

export type MetadataReadbackResult = {
  verified: boolean;
  expected: number;
  found: number;
  reportType: MetadataReportType;
  missingLedgerNames: string[];
  reason?: "empty_expected_set" | "tally_export_failed" | "metadata_missing";
};

export function metadataReportTypeFromDeliveryKey(key: string): MetadataReportType | null {
  const match = key.match(/:meta:(claim_verification|claim_approval|detailed_expense|daily_project_report):/);
  return (match?.[1] as MetadataReportType | undefined) ?? null;
}

/** Export only the just-written rows. No company variable or import action is included. */
export function buildMetadataReadbackXml(reportType: MetadataReportType, ledgerNames: string[]): string {
  const names = [...new Set(ledgerNames.map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0 || names.some((name) => !/^PW-META-[A-Za-z0-9-]+$/.test(name))) {
    throw new Error("Metadata read-back requires deterministic PesoWise metadata ledger names");
  }
  const nameFilter = names.map((name) => `$Name = "${name}"`).join(" OR ");
  const childOf = reportType === "daily_project_report" ? "" : "<CHILDOF>PesoWise Metadata</CHILDOF>";
  return [
    "<ENVELOPE>",
    "<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>",
    "<ID>PW Metadata Readback</ID></HEADER>",
    "<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>",
    "<TDL><TDLMESSAGE>",
    `<SYSTEM TYPE="Formulae" NAME="PWMetadataReadbackMatch">${nameFilter}</SYSTEM>`,
    '<COLLECTION NAME="PW Metadata Readback" ISMODIFY="No" ISINITIALIZE="Yes">',
    "<TYPE>Ledger</TYPE>",
    childOf,
    "<FETCH>Name</FETCH><FETCH>PESOWISE_REPORT_TYPE</FETCH><FETCH>PESOWISE_REPORT_FLAT_ROW</FETCH>",
    "<FILTER>PWMetadataReadbackMatch</FILTER>",
    "</COLLECTION></TDLMESSAGE></TDL></DESC></BODY>",
    "</ENVELOPE>",
  ].join("");
}

/** Verify exact ledger identities and their type/flat-row fields in Tally's Export response. */
export function parseMetadataReadback(
  xml: string,
  reportType: MetadataReportType,
  expectedLedgerNames: string[],
): MetadataReadbackResult {
  const expected = [...new Set(expectedLedgerNames.map((name) => name.trim()).filter(Boolean))];
  if (expected.length === 0) {
    return { verified: false, expected: 0, found: 0, reportType, missingLedgerNames: [], reason: "empty_expected_set" };
  }
  if (!xml.trim() || /<LINEERROR\b/i.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    return { verified: false, expected: expected.length, found: 0, reportType, missingLedgerNames: expected, reason: "tally_export_failed" };
  }
  const status = [...xml.matchAll(/<STATUS\b[^>]*>\s*(-?\d+)\s*<\/STATUS\s*>/gi)];
  if (status.length !== 1 || status[0][1] !== "1") {
    return { verified: false, expected: expected.length, found: 0, reportType, missingLedgerNames: expected, reason: "tally_export_failed" };
  }

  const stored = new Map<string, { reportType: string; flatRow: string }>();
  for (const block of xml.matchAll(/<LEDGER\b([^>]*)>([\s\S]*?)<\/LEDGER\s*>/gi)) {
    const nameMatch = block[1].match(/\bNAME\s*=\s*"([^"]*)"/i);
    if (!nameMatch) continue;
    const name = decodeXml(nameMatch[1]);
    const type = block[2].match(/<UDF:PESOWISE_REPORT_TYPE\b[^>]*>([\s\S]*?)<\/UDF:PESOWISE_REPORT_TYPE\s*>/i)?.[1] ?? "";
    const flatRow = block[2].match(/<UDF:PESOWISE_REPORT_FLAT_ROW\b[^>]*>([\s\S]*?)<\/UDF:PESOWISE_REPORT_FLAT_ROW\s*>/i)?.[1] ?? "";
    stored.set(name, { reportType: decodeXml(type.replace(/<[^>]+>/g, "").trim()), flatRow: decodeXml(flatRow.replace(/<[^>]+>/g, "").trim()) });
  }

  const missingLedgerNames = expected.filter((name) => {
    const row = stored.get(name);
    return !row || row.reportType !== reportType || !row.flatRow;
  });
  const found = expected.length - missingLedgerNames.length;
  return {
    verified: found === expected.length,
    expected: expected.length,
    found,
    reportType,
    missingLedgerNames,
    ...(found === expected.length ? {} : { reason: "metadata_missing" as const }),
  };
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
