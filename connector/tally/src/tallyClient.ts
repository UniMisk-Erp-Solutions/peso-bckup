import { parseTallyImportResponse } from "./responseParser.js";
import {
  buildMetadataReadbackXml,
  parseMetadataReadback,
  type MetadataReadbackResult,
  type MetadataReportType,
} from "./metadataReadback.js";
import { AGENT_TALLY_TCP_TIMEOUT_MS, checkTcpPort } from "./tallyTcpCheck.js";
import { TALLY_DELIVERY_POST_TIMEOUT_MS } from "./tallyDelivery.js";

const COMPANY_PROBE_TIMEOUT_MS = 5_000;

/**
 * Read-only Export request. It deliberately omits SVCURRENTCOMPANY so it cannot
 * request another company or make Tally load/select one. The inline TDL only
 * exports the current SVCurrentCompany value; it defines no actions or writes.
 */
export function buildActiveCompanyProbeXml(): string {
  return [
    "<ENVELOPE>",
    "<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PesoWiseActiveCompanyProbe</ID></HEADER>",
    "<BODY><DESC>",
    "<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>",
    "<TDL><TDLMESSAGE>",
    '<OBJECT NAME="PesoWiseActiveCompanyProbeObject"><LOCALFORMULA>PWActiveCompany:##SVCurrentCompany</LOCALFORMULA></OBJECT>',
    '<COLLECTION NAME="PesoWiseActiveCompanyProbe" ISMODIFY="No"><OBJECT>PesoWiseActiveCompanyProbeObject</OBJECT><FETCH>PWActiveCompany</FETCH></COLLECTION>',
    "</TDLMESSAGE></TDL>",
    "</DESC></BODY></ENVELOPE>",
  ].join("");
}

export type ActiveCompanyProbeResult =
  | { verified: true; companyName: string }
  | { verified: false; reason: "company_not_configured" | "company_probe_unavailable" | "company_identity_ambiguous" | "company_identity_mismatch" };

/** Strictly accepts one successful Tally response with exactly one company value. */
export function parseActiveCompanyProbeResponse(xml: string, expectedCompany: string): ActiveCompanyProbeResult {
  const expected = expectedCompany.trim();
  if (!expected) return { verified: false, reason: "company_not_configured" };
  if (!xml.trim()) return { verified: false, reason: "company_probe_unavailable" };

  const roots = [...xml.matchAll(/<ENVELOPE\b[^>]*>([\s\S]*?)<\/ENVELOPE\s*>/gi)];
  if (roots.length !== 1 || /<LINEERROR\b/i.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    return { verified: false, reason: "company_probe_unavailable" };
  }
  const status = [...roots[0][1].matchAll(/<STATUS\b[^>]*>\s*(-?\d+)\s*<\/STATUS\s*>/gi)];
  if (status.length !== 1 || status[0][1] !== "1") {
    return { verified: false, reason: "company_probe_unavailable" };
  }

  const values = [...roots[0][1].matchAll(/<PWACTIVECompany\b[^>]*>([\s\S]*?)<\/PWACTIVECompany\s*>/gi)]
    .map((match) => decodeXmlText(match[1].replace(/<[^>]+>/g, "").trim()));
  if (values.length !== 1 || !values[0]) {
    return { verified: false, reason: "company_identity_ambiguous" };
  }
  return values[0] === expected
    ? { verified: true, companyName: values[0] }
    : { verified: false, reason: "company_identity_mismatch" };
}

function decodeXmlText(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

export type TallyClientOptions = {
  host: string;
  port: number;
  companyName?: string;
};

export class TallyClient {
  constructor(private opts: TallyClientOptions) {}

  /** Probe the active company using a read-only Export request; never import or select. */
  async verifyActiveCompany(expectedName: string): Promise<ActiveCompanyProbeResult> {
    const expected = expectedName.trim();
    if (!expected) return { verified: false, reason: "company_not_configured" };
    try {
      const response = await fetch(this.baseUrl(), {
        method: "POST",
        headers: { "Content-Type": "text/xml;charset=utf-8" },
        body: buildActiveCompanyProbeXml(),
        signal: AbortSignal.timeout(COMPANY_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) return { verified: false, reason: "company_probe_unavailable" };
      return parseActiveCompanyProbeResponse(await response.text(), expected);
    } catch {
      return { verified: false, reason: "company_probe_unavailable" };
    }
  }

  private baseUrl() {
    return `http://${this.opts.host}:${this.opts.port}`;
  }

  /** TCP only — no HTTP/XML (safe idle / doctor reachability). */
  async isReachable(): Promise<boolean> {
    try {
      return await checkTcpPort(this.opts.host, this.opts.port, AGENT_TALLY_TCP_TIMEOUT_MS);
    } catch {
      return false;
    }
  }

  /** One Import POST — no retry, no fallback (timeoutMs capped at 15s). */
  async postImportXmlOnce(xml: string, timeoutMs: number = TALLY_DELIVERY_POST_TIMEOUT_MS): Promise<{
    httpOk: boolean;
    text: string;
    parsed: ReturnType<typeof parseTallyImportResponse>;
  }> {
    const ms = Math.min(Math.max(timeoutMs, 1_000), TALLY_DELIVERY_POST_TIMEOUT_MS);
    const res = await fetch(this.baseUrl(), {
      method: "POST",
      headers: { "Content-Type": "text/xml;charset=utf-8" },
      body: xml,
      signal: AbortSignal.timeout(ms),
    });
    const text = await res.text();
    const parsed = parseTallyImportResponse(text);
    return { httpOk: res.ok, text, parsed };
  }

  /** Read-only Export of the report's loaded metadata collection; never selects a company. */
  async verifyMetadataReadback(
    reportType: MetadataReportType,
    expectedLedgerNames: string[],
  ): Promise<MetadataReadbackResult> {
    try {
      const res = await fetch(this.baseUrl(), {
        method: "POST",
        headers: { "Content-Type": "text/xml;charset=utf-8" },
        body: buildMetadataReadbackXml(reportType, expectedLedgerNames),
        signal: AbortSignal.timeout(TALLY_DELIVERY_POST_TIMEOUT_MS),
      });
      if (!res.ok) {
        return {
          verified: false,
          expected: new Set(expectedLedgerNames.map((name) => name.trim()).filter(Boolean)).size,
          found: 0,
          reportType,
          missingLedgerNames: expectedLedgerNames,
          reason: "tally_export_failed",
        };
      }
      return parseMetadataReadback(await res.text(), reportType, expectedLedgerNames);
    } catch {
      return {
        verified: false,
        expected: new Set(expectedLedgerNames.map((name) => name.trim()).filter(Boolean)).size,
        found: 0,
        reportType,
        missingLedgerNames: expectedLedgerNames,
        reason: "tally_export_failed",
      };
    }
  }

  /** Delivery path — delegates to single-attempt POST (production loop). */
  async postXml(xml: string) {
    return this.postImportXmlOnce(xml, TALLY_DELIVERY_POST_TIMEOUT_MS);
  }
}
