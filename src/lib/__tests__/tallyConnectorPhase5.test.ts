import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseTallyImportResponse, redactSecrets } from "@/lib/tallyConnector/responseParser";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261007120000_tally_connector_phase5.sql"),
  "utf-8",
);

describe("Phase 5 migration contract", () => {
  it("defines connector devices, batches, and job statuses", () => {
    expect(sql).toContain("tally_connector_devices");
    expect(sql).toContain("tally_sync_delivery_batches");
    expect(sql).toContain("waiting_for_connector");
    expect(sql).toContain("connector_claim_delivery_batch_v1");
    expect(sql).toContain("connector_ack_delivery_batch_v1");
    expect(sql).toContain("exchange_tally_connector_pairing_v1");
  });
});

describe("Tally response parser", () => {
  it("accepts a complete clean import response", () => {
    const xml = `<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><IGNORED>0</IGNORED><ERRORS>0</ERRORS></RESPONSE>`;
    const r = parseTallyImportResponse(xml);
    expect(r.ok).toBe(true);
    expect(r.created).toBe(1);
  });

  it("rejects LINEERROR", () => {
    const xml = `<RESPONSE><LINEERROR>Ledger missing</LINEERROR></RESPONSE>`;
    const r = parseTallyImportResponse(xml);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("Ledger missing");
  });

  it("rejects empty body", () => {
    expect(parseTallyImportResponse("").ok).toBe(false);
  });

  it("requires reconciliation for duplicate-only imports", () => {
    const xml = `<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><IGNORED>0</IGNORED><ERRORS>1</ERRORS><EXCEPTIONS>1</EXCEPTIONS></RESPONSE>`;
    expect(parseTallyImportResponse(xml).ok).toBe(false);
  });

  it("rejects partial imports even when Tally created some records", () => {
    const xml = `<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><IGNORED>0</IGNORED><ERRORS>0</ERRORS><EXCEPTIONS>1</EXCEPTIONS></RESPONSE>`;
    expect(parseTallyImportResponse(xml).ok).toBe(false);
  });

  it("redacts secrets in logs", () => {
    const t = redactSecrets('device_token=abc123456789012345678901234567890');
    expect(t).not.toContain("abc123456789012345678901234567890");
  });
});

describe("Post-prepared worker references", () => {
  it("run-tally-sync-job dispatches delivery enqueue", () => {
    const worker = readFileSync(
      resolve(process.cwd(), "supabase/functions/run-tally-sync-job/index.ts"),
      "utf-8",
    );
    expect(worker).toContain("enqueueDeliveryBatches");
  });
});
