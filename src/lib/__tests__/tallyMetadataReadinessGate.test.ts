import { describe, expect, it } from "vitest";
import { isMetadataImportReady, type ConnectorConfig } from "../../../connector/tally/src/config";
import { localTallyBridgeMatches } from "../localTallyBridge";

const config: ConnectorConfig = {
  pesoApiUrl: "https://example.invalid",
  tallyHost: "127.0.0.1",
  tallyPort: 9000,
  tallyCompanyName: "PesoWise Integration Test",
  installationId: "installation-123",
  logMaxBytes: 1000,
};

describe("Tally metadata readiness gate", () => {
  it("fails closed when setup is unconfirmed, belongs to another company, or another connector build", () => {
    expect(isMetadataImportReady(config, "0.6.0-company-verify")).toBe(false);
    expect(isMetadataImportReady({ ...config, metadataReadyCompany: "Other Co", metadataReadyVersion: "v1" }, "v1")).toBe(false);
    expect(isMetadataImportReady({ ...config, metadataReadyCompany: config.tallyCompanyName, metadataReadyVersion: "old" }, "v1")).toBe(false);
  });

  it("is ready only for the attested intended company and connector build", () => {
    const ready = { ...config, metadataReadyCompany: config.tallyCompanyName, metadataReadyVersion: "v1" };
    expect(isMetadataImportReady(ready, "v1")).toBe(true);
  });

  it("keeps the Sync UI closed unless the bridge reports explicit readiness", () => {
    const health = {
      ok: true,
      connector_paired: true,
      organization_id: "org-1",
      tally_company_name: "PesoWise Integration Test",
      tally_company_verified: true,
      tally_company_verified_name: "PesoWise Integration Test",
    };
    expect(localTallyBridgeMatches(health, "org-1", "PesoWise Integration Test")).toBe(false);
    expect(localTallyBridgeMatches({ ...health, metadata_import_ready: true }, "org-1", "PesoWise Integration Test")).toBe(true);
  });
});
