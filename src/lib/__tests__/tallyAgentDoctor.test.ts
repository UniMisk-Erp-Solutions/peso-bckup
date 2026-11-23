import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("PesoWise Tally Agent doctor (non-delivery diagnostics)", () => {
  it("pairing path uses node:crypto randomUUID, not global crypto (pkg EXE)", async () => {
    for (const rel of ["connector/tally/src/main.ts", "connector/tally/src/config.ts"]) {
      const src = readFileSync(resolve(process.cwd(), rel), "utf-8");
      expect(src).not.toMatch(/\bcrypto\.randomUUID\b/);
      expect(src).toContain("newInstallationId");
    }
    const { newInstallationId } = await import("../../../connector/tally/dist/randomId.js");
    expect(newInstallationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("main exposes doctor command and doctor never claims or imports", () => {
    const main = readFileSync(resolve(process.cwd(), "connector/tally/src/main.ts"), "utf-8");
    const doctor = readFileSync(resolve(process.cwd(), "connector/tally/src/doctor.ts"), "utf-8");
    expect(main).toContain('"doctor"');
    expect(doctor).toContain("readonly: false");
    expect(doctor).toContain("backend_heartbeat_sent");
    expect(doctor).not.toContain(".claim(");
    expect(doctor).not.toContain("postImportXmlOnce");
    expect(doctor).not.toMatch(/TALLYREQUEST>Load Company/i);
    expect(doctor).toContain("checkTcpPort");
    expect(doctor).toContain("TallyClient");
    expect(doctor).toContain("verifyActiveCompany");
  });

  it("provides explicit one-batch delivery and exits gracefully after CLI work", () => {
    const main = readFileSync(resolve(process.cwd(), "connector/tally/src/main.ts"), "utf-8");
    expect(main).toContain('if (cmd === "deliver-batch" || cmd === "run-once")');
    expect(main).toContain("deliverBoundBatch(cfg, peso, tally, jobId, batchId)");
    expect(main).toContain('argv["job-id"]');
    expect(main).toContain('argv["batch-id"]');
    expect(main).toContain("process.exitCode = result.success ? 0 : 1");
    expect(main).toContain('cmd === "deliver-batch" || cmd === "run-once"');
    const doctorCommand = main.split('if (cmd === "doctor")')[1]?.split('if (cmd === "deliver-job")')[0] ?? "";
    expect(doctorCommand).not.toContain("process.exit(");
  });

  it("metadata revision migration defines atomic ack helper", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261007150000_tally_metadata_revision.sql"),
      "utf-8",
    );
    expect(sql).toContain("last_metadata_revision");
    expect(sql).toContain("tally_expected_metadata_revision_v1");
    expect(sql).toContain("metadata_revision_mismatch");
    expect(sql).not.toContain("max(content_hash");
  });
});
