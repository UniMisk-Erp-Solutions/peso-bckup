import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jobBatches: vi.fn(),
  heartbeat: vi.fn(),
  verifyActiveCompany: vi.fn(),
  deliverBoundBatch: vi.fn(),
  checkTcpPort: vi.fn(),
}));

vi.mock("../../../connector/tally/src/config.js", () => ({
  isMetadataImportReady: () => true,
}));
vi.mock("../../../connector/tally/src/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../../connector/tally/src/pesoApi.js", () => ({
  PesoConnectorApi: class {
    heartbeat = mocks.heartbeat;
    jobBatches = mocks.jobBatches;
  },
}));
vi.mock("../../../connector/tally/src/tallyClient.js", () => ({
  TallyClient: class {
    verifyActiveCompany = mocks.verifyActiveCompany;
  },
}));
vi.mock("../../../connector/tally/src/deliverBatch.js", () => ({
  deliverBoundBatch: mocks.deliverBoundBatch,
}));
vi.mock("../../../connector/tally/src/tallyTcpCheck.js", () => ({
  checkTcpPort: mocks.checkTcpPort,
  DOCTOR_TALLY_TCP_TIMEOUT_MS: 1,
}));

import { deliverEntireJob } from "../../../connector/tally/src/deliverJob.js";

const cfg = {
  deviceToken: "test-token",
  pesoApiUrl: "https://peso.example",
  tallyCompanyName: "PesoWise Integration Test",
  metadataReadyCompany: "PesoWise Integration Test",
  metadataReadyVersion: "0.6.0-company-verify",
} as any;

describe("connector job delivery fail-stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyActiveCompany.mockResolvedValue({ verified: true, companyName: cfg.tallyCompanyName });
    mocks.heartbeat.mockResolvedValue({ ok: true });
    mocks.checkTcpPort.mockResolvedValue(true);
  });

  it("does not skip a manual-review batch to import later pending batches", async () => {
    mocks.jobBatches.mockResolvedValue({
      job_id: "job-1",
      batches: [
        { id: "held", status: "manual_review", batch_index: 0, message_count: 5 },
        { id: "later", status: "pending", batch_index: 1, message_count: 5 },
      ],
    });

    const result = await deliverEntireJob(cfg, "job-1", "0.6.0-company-verify");

    expect(result.stopped_reason).toBe("partial_failure");
    expect(mocks.deliverBoundBatch).not.toHaveBeenCalled();
  });

  it("stops the job immediately after the first delivery failure", async () => {
    mocks.jobBatches.mockResolvedValue({
      job_id: "job-2",
      batches: [
        { id: "batch-0", status: "pending", batch_index: 0, message_count: 5 },
        { id: "batch-1", status: "pending", batch_index: 1, message_count: 5 },
      ],
    });
    mocks.deliverBoundBatch.mockResolvedValue({ success: false, error_safe: "manual review" });

    const result = await deliverEntireJob(cfg, "job-2", "0.6.0-company-verify");

    expect(result).toMatchObject({
      batches_attempted: 1,
      batches_failed: 1,
      stopped_reason: "partial_failure",
    });
    expect(mocks.deliverBoundBatch).toHaveBeenCalledTimes(1);
    expect(mocks.deliverBoundBatch).toHaveBeenCalledWith(
      cfg,
      expect.anything(),
      expect.anything(),
      "job-2",
      "batch-0",
    );
  });

  it("stops on the first refused claim instead of probing later FIFO batches", async () => {
    mocks.jobBatches.mockResolvedValue({
      job_id: "job-3",
      batches: [
        { id: "batch-0", status: "pending", batch_index: 0, message_count: 5 },
        { id: "batch-1", status: "pending", batch_index: 1, message_count: 5 },
      ],
    });
    mocks.deliverBoundBatch.mockResolvedValue({ success: false, error_safe: "claim_refused" });

    const result = await deliverEntireJob(cfg, "job-3", "0.6.0-company-verify");

    expect(result.stopped_reason).toBe("partial_failure");
    expect(mocks.deliverBoundBatch).toHaveBeenCalledTimes(1);
    expect(mocks.deliverBoundBatch).toHaveBeenCalledWith(
      cfg,
      expect.anything(),
      expect.anything(),
      "job-3",
      "batch-0",
    );
  });
});
