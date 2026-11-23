import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { dailyProjectItem } from "@/lib/tallyMapping/__fixtures__/synthetic";
import {
  E2E_CONTROLLED_SMOKE_ORG_ID,
  mapPreparedJobItemsControlledE2e,
} from "@/lib/tallyMapping/controlledE2e";
import { mapPreparedJobItems } from "@/lib/tallyMapping/pipeline";
import {
  TALLY_DELIVERY_POST_TIMEOUT_MS,
} from "../../../connector/tally/src/tallyDelivery.js";
import { TallyClient } from "../../../connector/tally/src/tallyClient.js";

const SMOKE = E2E_CONTROLLED_SMOKE_ORG_ID;

describe("Controlled E2E metadata delivery (offline)", () => {
  it("controlled mapper: exactly one metadata LEDGER, no GROUP/employee/COSTCENTRE/VOUCHER", () => {
    const item = dailyProjectItem("controlled-e2e-hash");
    item.payload.organization_id = SMOKE;
    const mapped = mapPreparedJobItemsControlledE2e([item], {
      organization_id: SMOKE,
      job_id: "job-controlled",
    });
    expect(mapped.accounting_voucher_count).toBe(0);
    expect(mapped.commands).toHaveLength(1);
    expect(mapped.commands[0].kind).toBe("report_metadata");
    expect(mapped.xml_batches).toHaveLength(1);
    expect(mapped.xml_batches[0].message_count).toBe(1);

    const xml = mapped.xml_batches[0].xml.replace(
      "<SVCURRENTCOMPANY><!-- configured at connector time --></SVCURRENTCOMPANY>",
      "<SVCURRENTCOMPANY>PesoWise Integration Test</SVCURRENTCOMPANY>",
    );
    expect(xml.match(/<TALLYMESSAGE/g)?.length).toBe(1);
    expect(xml).toContain("<LEDGER ACTION=\"Create\"");
    expect(xml).toContain("PesoWise Metadata");
    expect(xml).toContain("PESOWISE_METADATA_JSON");
    expect(xml).toContain("PW-META-");
    expect(xml).not.toContain("<GROUP");
    expect(xml).not.toContain("PesoWise Employees");
    expect(xml).not.toContain("<COSTCENTRE");
    expect(xml).not.toContain("<VOUCHER");
    expect(xml).not.toMatch(/ACTION="Alter"/i);
    expect(xml).not.toMatch(/Load Company/i);
  });

  it("production daily mapper: metadata ledger only, shared Metadata group pre-provisioned", () => {
    const item = dailyProjectItem("prod-compare-hash");
    item.payload.organization_id = SMOKE;
    const prod = mapPreparedJobItems([item], { organization_id: SMOKE, job_id: "j" });
    expect(prod.commands.some((c) => c.kind === "master" && c.master.kind === "group"
      && c.master.display_name === "PesoWise Metadata")).toBe(false);
    expect(prod.commands.filter((c) => c.kind === "voucher").length).toBe(0);
    expect(prod.commands.filter((c) => c.kind === "report_metadata").length).toBe(1);
    const xml = prod.xml_batches[0]?.xml ?? "";
    expect(xml).not.toContain("PesoWise Employees");
    expect(xml).not.toContain("<COSTCENTRE");
  });

  it("controlled mapper rejects wrong org and multi-row jobs", () => {
    const item = dailyProjectItem("x");
    expect(() =>
      mapPreparedJobItemsControlledE2e([item], {
        organization_id: "33333333-3333-3333-3333-333333333333",
        job_id: "j",
      }),
    ).toThrow(/smoke test organization/);
    expect(() =>
      mapPreparedJobItemsControlledE2e([item, item], {
        organization_id: SMOKE,
        job_id: "j",
      }),
    ).toThrow(/exactly 1 daily/);
  });

  it("corrective migration has no caller-controlled retry bypass", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261008150000_tally_delivery_safety.sql"),
      "utf-8",
    );
    expect(sql).toContain("p_job_id uuid DEFAULT NULL");
    expect(sql).toContain("p_batch_id uuid DEFAULT NULL");
    expect(sql).toContain("'manual_review'");
    expect(sql).not.toContain("p_e2e_hold");
    expect(sql).not.toContain("IF true THEN");
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.connector_ack_delivery_batch_v1");
    expect(sql).toContain("authorize_retry");
  });

  it("background and bound delivery verify active company before claiming and again before import", () => {
    const main = readFileSync(resolve(process.cwd(), "connector/tally/src/main.ts"), "utf-8");
    const loop = readFileSync(resolve(process.cwd(), "connector/tally/src/serviceLoop.ts"), "utf-8");
    const delivery = readFileSync(resolve(process.cwd(), "connector/tally/src/deliverBatch.ts"), "utf-8");
    expect(main).toContain("run-once");
    expect(loop).toContain("verifyActiveCompany");
    expect(loop).toContain("no delivery batches will be claimed");
    expect(loop.indexOf("verifyActiveCompany")).toBeLessThan(loop.indexOf("peso.claim(cfg.tallyCompanyName"));
    expect(delivery).toContain("await peso.claimBound(jobId, batchId, companyName)");
    expect(delivery).toContain("await tally.verifyActiveCompany(configuredCompany)");
    expect(delivery).toContain("await tally.postImportXmlOnce(xml)");
    expect(delivery.indexOf("await tally.verifyActiveCompany(configuredCompany)")).toBeLessThan(delivery.indexOf("await tally.postImportXmlOnce(xml)"));
  });

  it("ordinary delivery timeout is capped at 15s", () => {
    expect(TALLY_DELIVERY_POST_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    const client = readFileSync(resolve(process.cwd(), "connector/tally/src/tallyClient.ts"), "utf-8");
    expect(client).toContain("postImportXmlOnce");
    expect(client).not.toMatch(/120_000/);
  });
});

describe("TallyClient.postImportXmlOnce fetch attempts", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("exactly one fetch on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        "<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><IGNORED>0</IGNORED><ERRORS>0</ERRORS></RESPONSE>",
    });
    global.fetch = fetchMock as typeof fetch;
    const client = new TallyClient({ host: "127.0.0.1", port: 9000 });
    const r = await client.postImportXmlOnce("<xml/>", 10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.parsed.ok).toBe(true);
  });

  it("exactly one fetch on Tally exception response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<RESPONSE><ERRORS>1</ERRORS><EXCEPTIONS>1</EXCEPTIONS><CREATED>0</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><IGNORED>0</IGNORED></RESPONSE>",
    });
    global.fetch = fetchMock as typeof fetch;
    const client = new TallyClient({ host: "127.0.0.1", port: 9000 });
    const r = await client.postImportXmlOnce("<xml/>", 10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.parsed.ok).toBe(false);
  });

  it("exactly one fetch on timeout (rejects once)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    global.fetch = fetchMock as typeof fetch;
    const client = new TallyClient({ host: "127.0.0.1", port: 9000 });
    await expect(client.postImportXmlOnce("<xml/>", 10_000)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exactly one fetch on network failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    global.fetch = fetchMock as typeof fetch;
    const client = new TallyClient({ host: "127.0.0.1", port: 9000 });
    await expect(client.postImportXmlOnce("<xml/>", 10_000)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
