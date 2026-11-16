import http from "node:http";
import { describe, expect, it } from "vitest";
import { mapPreparedJobItems } from "@/lib/tallyMapping/pipeline";
import { serializeCommand } from "@/lib/tallyMapping/xml/serialize";
import { dailyProjectItem, ORG_A } from "@/lib/tallyMapping/__fixtures__/synthetic";

function tallyImport(inner: string): Promise<string> {
  const company = "PesoWise Integration Test";
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY><IMPORTDATA><REQUESTDESC>
    <REPORTNAME>All Masters</REPORTNAME>
    <STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES>
  </REQUESTDESC><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY>
</ENVELOPE>`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: 9000, method: "POST", headers: { "Content-Type": "text/xml" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      },
    );
    req.on("error", reject);
    req.write(xml);
    req.end();
  });
}

describe("local Tally integration", () => {
  it.skipIf(process.env.RUN_TALLY_IMPORT !== "1")(
    "imports one daily row with DPR display UDFs",
    async () => {
      const item = dailyProjectItem(`dpr-ui-sample-${Date.now()}`);
      const mapped = mapPreparedJobItems([item], { organization_id: ORG_A, job_id: "local-sample" });
      const meta = mapped.commands.find((c) => c.kind === "report_metadata");
      expect(meta?.kind).toBe("report_metadata");
      if (meta?.kind !== "report_metadata") return;
      const inner = serializeCommand(meta);
      expect(inner).toContain("PESOWISE_DPR_EMPLOYEE");
      const resp = await tallyImport(inner);
      expect(resp).toMatch(/CREATED|ALTERED/);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ ledger: meta.metadata.ledger_name, response: resp.slice(0, 400) }));
    },
    20_000,
  );
});
