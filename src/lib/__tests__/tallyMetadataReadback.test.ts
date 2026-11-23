import { describe, expect, it } from "vitest";
import {
  buildMetadataReadbackXml,
  metadataReportTypeFromDeliveryKey,
  parseMetadataReadback,
} from "../../../connector/tally/src/metadataReadback";

const row = (name: string, type = "claim_verification", flat = "Employee|123|60.00") => `
  <LEDGER NAME="${name}" RESERVEDNAME="">
    <UDF:PESOWISE_REPORT_TYPE TYPE="String">${type}</UDF:PESOWISE_REPORT_TYPE>
    <UDF:PESOWISE_REPORT_FLAT_ROW TYPE="String">${flat}</UDF:PESOWISE_REPORT_FLAT_ROW>
  </LEDGER>`;

describe("Tally metadata read-back", () => {
  it("builds a read-only collection export without choosing a company or importing", () => {
    const xml = buildMetadataReadbackXml("claim_verification", ["PW-META-a"]);
    expect(xml).toContain("<TALLYREQUEST>Export</TALLYREQUEST>");
    expect(xml).toContain("<ID>PW Metadata Readback</ID>");
    expect(xml).toContain("<FILTER>PWMetadataReadbackMatch</FILTER>");
    expect(xml).toContain('$Name = "PW-META-a"');
    expect(xml).not.toContain("<SVCURRENTCOMPANY>");
    expect(xml).not.toContain("Import");
  });

  it("rejects names that could modify the inline read-only filter", () => {
    expect(() => buildMetadataReadbackXml("claim_verification", ['PW-META-a" OR TRUE'])).toThrow(
      "deterministic PesoWise metadata ledger names",
    );
  });

  it("confirms expected rows only when identity, report type, and stored flat data match", () => {
    const xml = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA>${row("PW-META-a")}${row("PW-META-b")}</DATA></BODY></ENVELOPE>`;
    expect(parseMetadataReadback(xml, "claim_verification", ["PW-META-a", "PW-META-b"])).toMatchObject({
      verified: true,
      expected: 2,
      found: 2,
    });
  });

  it("fails closed for missing rows, wrong report type, empty export, and empty expectations", () => {
    const xml = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY>${row("PW-META-a", "claim_approval")}</BODY></ENVELOPE>`;
    expect(parseMetadataReadback(xml, "claim_verification", ["PW-META-a", "PW-META-b"]).verified).toBe(false);
    expect(parseMetadataReadback("", "claim_verification", ["PW-META-a"]).reason).toBe("tally_export_failed");
    expect(parseMetadataReadback(xml, "claim_verification", []).reason).toBe("empty_expected_set");
  });

  it("extracts a known report type from a metadata delivery key", () => {
    expect(metadataReportTypeFromDeliveryKey("org:meta:claim_verification:row-1")).toBe("claim_verification");
    expect(metadataReportTypeFromDeliveryKey("org:meta:unknown:row-1")).toBeNull();
  });
});
