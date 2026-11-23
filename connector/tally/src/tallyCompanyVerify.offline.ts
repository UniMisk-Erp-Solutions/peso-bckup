/** Pure parser for offline fixtures only. It deliberately performs no Tally HTTP requests. */
export type OfflineCompanyVerifyResult = {
  nameMatched: boolean;
  couldNotFindCompany: boolean;
  lineError: boolean;
};

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function analyzeCompanyVerifyResponse(expectedCompany: string, xml: string): OfflineCompanyVerifyResult {
  const expected = expectedCompany.trim();
  const names = [...xml.matchAll(/<(?:NAME|SERVERCOMPANYNAME)\b[^>]*>([\s\S]*?)<\/(?:NAME|SERVERCOMPANYNAME)>/gi)]
    .map((match) => decodeXml(match[1].trim()));
  return {
    nameMatched: Boolean(expected) && names.includes(expected),
    couldNotFindCompany: /Could not find Company/i.test(xml),
    lineError: /<LINEERROR\b/i.test(xml),
  };
}
