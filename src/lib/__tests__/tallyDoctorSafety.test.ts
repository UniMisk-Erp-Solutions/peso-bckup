import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const root = process.cwd();

function read(rel: string) {
  return readFileSync(resolve(root, rel), "utf-8");
}

describe("Tally doctor / agent safety (post c0000005)", () => {
  it("doctor probes company identity with read-only Export only and no Load Company", () => {
    const doctor = read("connector/tally/src/doctor.ts");
    const client = read("connector/tally/src/tallyClient.ts");
    const main = read("connector/tally/src/main.ts");
    expect(doctor).toContain("TallyClient");
    expect(doctor).toContain("verifyActiveCompany");
    expect(doctor).toContain("checkTcpPort");
    expect(client).toContain("<TALLYREQUEST>Export</TALLYREQUEST>");
    expect(client).not.toContain("<TALLYREQUEST>Import</TALLYREQUEST>");
    expect(doctor).not.toMatch(/\.claim\s*\(|\.ack\s*\(|postImportXmlOnce/);
    expect(doctor).not.toMatch(/TALLYREQUEST>Load Company/i);
    expect(client).not.toContain("verifyCompany");
    expect(client).not.toMatch(/Load Company/i);
    expect(client).not.toContain("buildCompanyObjectExportXml");
    expect(main).not.toContain("verifyCompany");
  });

  it("service loop does not call verifyCompany or Load Company", () => {
    const loop = read("connector/tally/src/serviceLoop.ts");
    expect(loop).not.toContain("verifyCompany");
    expect(loop).not.toMatch(/Load Company/i);
  });

  it("e2e script never starts tally.exe", () => {
    const ps1 = read("scripts/tally-integration/e2e-smoke-run-local.ps1");
    expect(ps1).not.toMatch(/Start-Process/i);
    expect(ps1).not.toMatch(/Start-Process[\s\S]*tally\.exe/i);
  });

  it("TCP check uses single timeout constant, no retry in doctor", () => {
    const tcp = read("connector/tally/src/tallyTcpCheck.ts");
    const doctor = read("connector/tally/src/doctor.ts");
    expect(tcp).toContain("DOCTOR_TALLY_TCP_TIMEOUT_MS");
    expect(doctor).not.toMatch(/for\s*\(/);
    expect(doctor).not.toMatch(/while\s*\(/);
    expect(doctor.match(/await checkTcpPort/g)?.length).toBe(1);
  });

  it("doctor exit fails while the intended Tally company remains unverified", () => {
    const main = read("connector/tally/src/main.ts");
    expect(main).toContain("report.tally_company_found");
    expect(read("connector/tally/src/doctor.ts")).toContain('"company_probe_unavailable"');
  });

  it("packaged startup opens the scoped bridge without sweeping pending batches", () => {
    const main = read("connector/tally/src/main.ts");
    const run = main.split('if (cmd === "run")')[1]?.split("console.error(")[0] ?? "";
    expect(run).toContain("startLocalBridge()");
    expect(run).toContain("no pending batches will be claimed automatically");
    expect(run).not.toContain("runServiceLoop");
  });

  it("local delivery endpoint verifies company and drains only the requested job", () => {
    const bridge = read("connector/tally/src/localBridge.ts");
    const delivery = read("connector/tally/src/deliverJob.ts");
    expect(bridge).toContain('req.url === "/v1/deliver-job"');
    expect(bridge).toContain("deliverEntireJob(cfg, jobId");
    expect(delivery).toContain("verifyActiveCompany");
    expect(delivery).toContain("jobBatches(jobId)");
    expect(delivery).not.toMatch(/\.claim\s*\(/);
  });

  it("live doctor probe scripts are gated", () => {
    for (const rel of [
      "scripts/tally-integration/_doctor-company-probe-live.mjs",
      "scripts/tally-integration/_doctor-verify-live-once.mjs",
    ]) {
      const src = read(rel);
      expect(src).toMatch(/ALLOW_LIVE_TALLY|DO NOT RUN/i);
    }
  });
});
