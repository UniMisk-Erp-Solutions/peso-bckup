import { afterEach, describe, expect, it, vi } from "vitest";
import { PesoConnectorApi } from "../../../connector/tally/src/pesoApi.js";

describe("Tally claim company binding", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the intended company when claiming from the background loop", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ claimed: false }), { status: 200 }),
    );
    const api = new PesoConnectorApi("https://peso.example", "device-token-for-test-only");
    await api.claim("Company A");
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      action: "claim",
      expected_company_name: "Company A",
    });
  });

  it("binds targeted claims to both job/batch and company", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ claimed: false }), { status: 200 }),
    );
    const api = new PesoConnectorApi("https://peso.example", "device-token-for-test-only");
    await api.claimBound("job-1", "batch-1", "Company A");
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      action: "claim",
      job_id: "job-1",
      batch_id: "batch-1",
      lease_seconds: 120,
      expected_company_name: "Company A",
    });
  });
});
