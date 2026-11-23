/** Adapt metadata ledger XML for TallyPrime bootstrap / import readiness. */

const INDEXED_UDF_LIST =
  /<UDF:([A-Z0-9_]+)\.LIST[^>]*INDEX="(\d+)"[^>]*>\s*<UDF:\1[^>]*>([\s\S]*?)<\/UDF:\1>\s*<\/UDF:\1\.LIST>/gi;

/** Downgrade indexed UDF LIST blocks to plain TYPE="String" (imports without Bootstrap TDL). */
export function demoteIndexedMetadataXmlToPlain(xml: string): string {
  return xml.replace(INDEXED_UDF_LIST, (_m, name: string, _index: string, value: string) => {
    return `<UDF:${name} TYPE="String">${value}</UDF:${name}>`;
  });
}

export function metadataXmlUsesIndexedUdks(xml: string): boolean {
  return /PESOWISE_METADATA_JSON\.LIST/i.test(xml) || /INDEX="25001"/i.test(xml);
}

/** Duplicate Create → Alter with UDFs only (refresh report fields on existing PW-META ledgers). */
export function metadataLedgerCreateToAlterOnly(tallyMessageXml: string): string | null {
  if (!/<LEDGER ACTION="Create"/i.test(tallyMessageXml)) return null;
  let out = tallyMessageXml.replace(/<LEDGER ACTION="Create"/i, '<LEDGER ACTION="Alter"');
  out = out.replace(/\s*<PARENT>[\s\S]*?<\/PARENT>\s*/gi, "\n    ");
  out = out.replace(/\s*<UDF:PESOWISE_STABLE_KEY[\s\S]*?<\/UDF:PESOWISE_STABLE_KEY>\s*/gi, "\n    ");
  return out;
}
