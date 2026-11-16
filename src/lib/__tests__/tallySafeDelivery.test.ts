import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { injectTallyCompany, deliverBoundBatch, deliverClaimedBatch } from "../../../connector/tally/src/deliverBatch.js";
import { parseTallyImportResponse } from "../../../connector/tally/src/responseParser.js";
import { TallyClient, buildActiveCompanyProbeXml, parseActiveCompanyProbeResponse } from "../../../connector/tally/src/tallyClient.js";
import type { PesoConnectorApi } from "../../../connector/tally/src/pesoApi.js";
import { probeMetadataImportReady } from "../../../connector/tally/src/tallyMetadataPreflight.js";
import { AGENT_VERSION } from "../../../connector/tally/src/doctor.js";

vi.mock("../../../connector/tally/src/logger.js", () => ({ log: vi.fn() }));

describe("Tally connector safety gates", () => {
  it("replaces exactly one company placeholder with XML-safe text", () => {
    const xml = "<ENVELOPE><SVCURRENTCOMPANY><!-- configured at connector time --></SVCURRENTCOMPANY></ENVELOPE>";
    expect(injectTallyCompany(xml, "A & B <Ltd>")).toContain("<SVCURRENTCOMPANY>A &amp; B &lt;Ltd&gt;</SVCURRENTCOMPANY>");
  });

  it.each([
    "<ENVELOPE></ENVELOPE>",
    "<ENVELOPE><SVCURRENTCOMPANY>A</SVCURRENTCOMPANY><SVCURRENTCOMPANY>A</SVCURRENTCOMPANY></ENVELOPE>",
    "<ENVELOPE><SVCURRENTCOMPANY>B</SVCURRENTCOMPANY></ENVELOPE>",
  ])("rejects XML where the intended company cannot be established", (xml) => {
    expect(() => injectTallyCompany(xml, "A")).toThrow();
  });

  it("only confirms a complete response with a clean persisted action", () => {
    expect(parseTallyImportResponse("<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><IMPORTRESULT><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><IGNORED>0</IGNORED><ERRORS>0</ERRORS></IMPORTRESULT></DATA></BODY></ENVELOPE>").ok).toBe(true);
    expect(parseTallyImportResponse("<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><IGNORED>0</IGNORED><ERRORS>0</ERRORS></RESPONSE>").ok).toBe(true);
    expect(parseTallyImportResponse("<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><IGNORED>0</IGNORED><ERRORS>0</ERRORS><EXCEPTIONS>1</EXCEPTIONS></RESPONSE>").ok).toBe(false);
    expect(parseTallyImportResponse("<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><IGNORED>0</IGNORED><ERRORS>1</ERRORS><EXCEPTIONS>1</EXCEPTIONS></RESPONSE>").ok).toBe(false);
    expect(parseTallyImportResponse("<RESPONSE><CREATED>1</CREATED>").ok).toBe(false);
  });

  it("does not send an import when active company verification is unavailable", async () => {
    const ack = vi.fn().mockResolvedValue({ ok: true });
    const postImportXmlOnce = vi.fn();
    const api = { ack } as unknown as PesoConnectorApi;
    const tally = { verifyActiveCompany: vi.fn().mockResolvedValue({ verified: false, reason: "company_probe_unavailable" }), postImportXmlOnce } as any;
    const result = await deliverClaimedBatch(
      { tallyCompanyName: "Company A" } as any,
      api,
      tally,
      { claimed: true, batch_id: "b1", job_id: "j1", batch_index: 0, message_count: 1, xml: "<ENVELOPE><SVCURRENTCOMPANY><!-- configured at connector time --></SVCURRENTCOMPANY></ENVELOPE>", tally_company_name: "Company A" },
    );
    expect(result.success).toBe(false);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false, batch_id: "b1" }));
    expect(tally.verifyActiveCompany).toHaveBeenCalledOnce();
    expect(postImportXmlOnce).not.toHaveBeenCalled();
  });

  it("imports once and acknowledges only after an exact company match", async () => {
    const ack = vi.fn().mockResolvedValue({ ok: true });
    const postImportXmlOnce = vi.fn().mockResolvedValue({
      httpOk: true,
      text: "<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><IGNORED>0</IGNORED><ERRORS>0</ERRORS></RESPONSE>",
      parsed: parseTallyImportResponse("<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><IGNORED>0</IGNORED><ERRORS>0</ERRORS></RESPONSE>"),
    });
    const api = { ack } as unknown as PesoConnectorApi;
    const tally = {
      verifyActiveCompany: vi.fn().mockResolvedValue({ verified: true, companyName: "Company A" }),
      postImportXmlOnce,
    } as any;
    const result = await deliverClaimedBatch(
      { tallyCompanyName: "Company A" } as any,
      api,
      tally,
      { claimed: true, batch_id: "b2", job_id: "j1", batch_index: 0, message_count: 1, xml: "<ENVELOPE><SVCURRENTCOMPANY><!-- configured at connector time --></SVCURRENTCOMPANY></ENVELOPE>", tally_company_name: "Company A", delivery_updates: [{ delivery_key: "key" }] },
    );
    expect(result.success).toBe(true);
    expect(tally.verifyActiveCompany).toHaveBeenCalledOnce();
    expect(postImportXmlOnce).toHaveBeenCalledOnce();
    expect(postImportXmlOnce.mock.calls[0][0]).toContain("<SVCURRENTCOMPANY>Company A</SVCURRENTCOMPANY>");
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({
      batch_id: "b2",
      success: true,
      delivery_updates: [{ delivery_key: "key" }],
      ack_summary: expect.objectContaining({ created: 1, exceptions: 0, ignored: 0 }),
    }));
  });

  it("quarantines import timeout or partial response and never retries automatically", async () => {
    const ack = vi.fn().mockResolvedValue({ ok: true });
    const api = { ack } as unknown as PesoConnectorApi;
    const tally = {
      verifyActiveCompany: vi.fn().mockResolvedValue({ verified: true, companyName: "Company A" }),
      postImportXmlOnce: vi.fn().mockRejectedValue(new Error("timeout")),
    } as any;
    const result = await deliverClaimedBatch(
      { tallyCompanyName: "Company A" } as any,
      api,
      tally,
      { claimed: true, batch_id: "b3", job_id: "j1", batch_index: 0, message_count: 1, xml: "<ENVELOPE><SVCURRENTCOMPANY><!-- configured at connector time --></SVCURRENTCOMPANY></ENVELOPE>", tally_company_name: "Company A" },
    );
    expect(result.success).toBe(false);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ batch_id: "b3", success: false, error_safe: expect.stringContaining("reconcile before retry") }));
  });

  it("will not claim a bound batch when the company identity is wrong", async () => {
    const claimBound = vi.fn();
    const tally = { verifyActiveCompany: vi.fn().mockResolvedValue({ verified: false, reason: "company_identity_mismatch" }) } as any;
    const result = await (await import("../../../connector/tally/src/deliverBatch.js")).deliverBoundBatch(
      { tallyCompanyName: "Company A" } as any,
      { claimBound } as any,
      tally,
      "job",
      "batch",
    );
    expect(result.success).toBe(false);
    expect(claimBound).not.toHaveBeenCalled();
  });

  it("runs verified bound delivery in order: verify, claim, reverify, import, acknowledge", async () => {
    const events: string[] = [];
    const claimed = {
      claimed: true as const,
      batch_id: "bound-batch",
      job_id: "bound-job",
      batch_index: 0,
      message_count: 1,
      xml: "<ENVELOPE><SVCURRENTCOMPANY><!-- configured at connector time --></SVCURRENTCOMPANY></ENVELOPE>",
      tally_company_name: "Company A",
    };
    const api = {
      claimBound: vi.fn(async () => { events.push("claim"); return claimed; }),
      ack: vi.fn(async () => { events.push("ack"); return { ok: true }; }),
    } as any;
    const parsed = parseTallyImportResponse("<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><IGNORED>0</IGNORED><ERRORS>0</ERRORS></RESPONSE>");
    let probes = 0;
    const tally = {
      verifyActiveCompany: vi.fn(async () => {
        events.push(++probes === 1 ? "verify-before-claim" : "verify-before-import");
        return { verified: true, companyName: "Company A" };
      }),
      postImportXmlOnce: vi.fn(async () => {
        events.push("import");
        return { httpOk: true, text: "<RESPONSE>ok</RESPONSE>", parsed };
      }),
    } as any;
    const result = await deliverBoundBatch({
      tallyCompanyName: "Company A",
      metadataReadyCompany: "Company A",
      metadataReadyVersion: AGENT_VERSION,
    } as any, api, tally, "bound-job", "bound-batch");
    expect(result.success).toBe(true);
    expect(events).toEqual(["verify-before-claim", "claim", "verify-before-import", "import", "ack"]);
  });

  it("builds a read-only active-company export without choosing a company", () => {
    const request = buildActiveCompanyProbeXml();
    expect(request).toContain("<TALLYREQUEST>Export</TALLYREQUEST>");
    expect(request).toContain("PWActiveCompany:##SVCurrentCompany");
    expect(request).toContain("<OBJECT>PesoWiseActiveCompanyProbeObject</OBJECT>");
    expect(request).not.toContain("SVCURRENTCOMPANY");
    expect(request).not.toContain("<TALLYREQUEST>Import</TALLYREQUEST>");
    expect(request).not.toContain("<ACTION");
  });

  it("verifies correct, incorrect, unavailable, and ambiguous active-company responses", () => {
    const ok = "<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><OBJECT><PWACTIVECOMPANY>Company A &amp; Sons</PWACTIVECOMPANY></OBJECT></COLLECTION></DATA></BODY></ENVELOPE>";
    expect(parseActiveCompanyProbeResponse(ok, "Company A & Sons")).toEqual({ verified: true, companyName: "Company A & Sons" });
    expect(parseActiveCompanyProbeResponse(ok, "Company B")).toEqual({ verified: false, reason: "company_identity_mismatch" });
    expect(parseActiveCompanyProbeResponse("", "Company A")).toEqual({ verified: false, reason: "company_probe_unavailable" });
    expect(parseActiveCompanyProbeResponse("<ENVELOPE><STATUS>1</STATUS><PWACTIVECOMPANY>A</PWACTIVECOMPANY><PWACTIVECOMPANY>B</PWACTIVECOMPANY></ENVELOPE>", "A"))
      .toEqual({ verified: false, reason: "company_identity_ambiguous" });
    expect(parseActiveCompanyProbeResponse("<ENVELOPE><STATUS>0</STATUS><LINEERROR>Unavailable</LINEERROR></ENVELOPE>", "Company A"))
      .toEqual({ verified: false, reason: "company_probe_unavailable" });
  });

  it("verifies only a successful single-company response and fails closed on timeout", async () => {
    const client = new TallyClient({ host: "127.0.0.1", port: 9000 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(new Response("<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><PWACTIVECOMPANY>Company A</PWACTIVECOMPANY></BODY></ENVELOPE>", { status: 200 }));
    await expect(client.verifyActiveCompany("Company A")).resolves.toEqual({ verified: true, companyName: "Company A" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const requestBody = String(fetchSpy.mock.calls[0][1]?.body);
    expect(requestBody).toContain("<TALLYREQUEST>Export</TALLYREQUEST>");
    expect(requestBody).not.toContain("SVCURRENTCOMPANY");
    fetchSpy.mockRejectedValueOnce(new Error("timeout"));
    await expect(client.verifyActiveCompany("Company A")).resolves.toEqual({ verified: false, reason: "company_probe_unavailable" });
    fetchSpy.mockRestore();
  });

  it("metadata readiness preflight never sends an import", async () => {
    const postImportXmlOnce = vi.fn();
    const result = await probeMetadataImportReady({ postImportXmlOnce } as any, "Company A");
    expect(result.ok).toBe(false);
    expect(result.excerpt).toContain("no Tally XML was sent");
    expect(postImportXmlOnce).not.toHaveBeenCalled();
  });

  it("database delivery migration quarantines expired claims and requires audited retry", () => {
    const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/20261008150000_tally_delivery_safety.sql"), "utf8");
    const aclSql = readFileSync(resolve(process.cwd(), "supabase/migrations/20261008170000_tally_reconcile_service_role_acl.sql"), "utf8");
    expect(sql).toContain("SET status = 'manual_review'");
    expect(sql).toContain("ORDER BY j.created_at ASC, b.batch_index ASC");
    expect(sql).toContain("lease_expires_at <= now()");
    expect(sql).toContain("WHERE b.status IN ('pending', 'claimed')");
    expect(sql).toContain("Pre-verification deliveries need manual reconciliation");
    expect(sql).toContain("connector_version = '0.6.0-company-verify'");
    expect(sql).toContain("error_message_safe = 'A delivery lease expired and needs manual reconciliation'");
    expect(sql).toContain("p_success IS DISTINCT FROM TRUE");
    expect(sql).toContain("status NOT IN ('delivered', 'skipped')");
    expect(sql).toContain("tally_delivery_reconciliation_events");
    expect(sql).toContain("FROM PUBLIC, anon, service_role");
    expect(aclSql).toContain("FROM PUBLIC, anon, service_role");
    expect(aclSql).toContain("TO authenticated");
    expect(sql).toContain("p_decision = 'authorize_retry'");
    expect(sql).not.toContain("IF true THEN");
    expect(sql).not.toContain("SET status = 'pending',\n      last_error_safe");
  });
});
