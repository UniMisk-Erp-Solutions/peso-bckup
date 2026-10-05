/**
 * RELEASE-PREP (Tally final visibility + reversal) §30/§31 — Import History
 * mode labels and the reversal RPC the UI actually calls.
 *
 * Regression coverage for a real bug found by re-reading the shipped code:
 * modeLabel(mode) was `mode === "historical_opening" ? "Opening / Historical"
 * : "Allocation"` -- every mode that was NOT historical_opening (including
 * balance_update, and any future/unrecognized mode) silently displayed as
 * "Allocation", which misrepresents what the batch actually did.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImportHistoryDialog } from "../ImportHistoryDialog";

const getImportBatchesMock = vi.fn();
const getImportRowsMock = vi.fn();
const getImportSourceDownloadUrlMock = vi.fn();
const reverseImportBatchV2Mock = vi.fn();
const reverseImportBatchMock = vi.fn();

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
    rpc: vi.fn(),
  },
}));

vi.mock("@/services/BalanceLedgerService", async () => {
  const actual = await vi.importActual<typeof import("@/services/BalanceLedgerService")>(
    "@/services/BalanceLedgerService",
  );
  return {
    ...actual,
    reverseImportBatchV2: (...args: unknown[]) => reverseImportBatchV2Mock(...args),
    reverseImportBatch: (...args: unknown[]) => reverseImportBatchMock(...args),
  };
});

vi.mock("@/services/BalanceImportService", async () => {
  const actual = await vi.importActual<typeof import("@/services/BalanceImportService")>(
    "@/services/BalanceImportService",
  );
  return {
    ...actual,
    getImportBatches: (...args: unknown[]) => getImportBatchesMock(...args),
    getImportRows: (...args: unknown[]) => getImportRowsMock(...args),
    getImportSourceDownloadUrl: (...args: unknown[]) => getImportSourceDownloadUrlMock(...args),
  };
});

function makeBatch(overrides: Record<string, unknown> = {}) {
  return {
    id: "batch-1",
    organization_id: "org-1",
    mode: "historical_opening",
    status: "applied",
    original_filename: "file.xlsx",
    source_storage_path: null,
    source_sha256: null,
    note: null,
    created_by: "user-1",
    created_at: "2026-07-01T00:00:00Z",
    applied_at: "2026-07-01T00:00:00Z",
    reversed_at: null,
    row_count: 2,
    total_delta: 100,
    ...overrides,
  };
}

const defaultProps = { open: true, onOpenChange: vi.fn(), organizationId: "org-1" };

beforeEach(() => {
  getImportBatchesMock.mockReset();
  getImportRowsMock.mockReset();
  getImportSourceDownloadUrlMock.mockReset();
  reverseImportBatchV2Mock.mockReset();
  reverseImportBatchMock.mockReset();
});

describe("Import History — mode labels never default to Allocation", () => {
  it.each([
    ["historical_opening", "Opening Balance"],
    ["balance_update", "Balance Update"],
    ["allocation", "Allocation"],
  ])("mode=%s renders as %s", async (mode, label) => {
    getImportBatchesMock.mockResolvedValue([makeBatch({ mode })]);
    render(<ImportHistoryDialog {...defaultProps} />);
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it("an unrecognized mode is shown verbatim, never silently relabeled as Allocation", async () => {
    getImportBatchesMock.mockResolvedValue([makeBatch({ mode: "some_future_mode" })]);
    render(<ImportHistoryDialog {...defaultProps} />);
    expect(await screen.findByText("some_future_mode")).toBeInTheDocument();
    expect(screen.queryByText("Allocation")).not.toBeInTheDocument();
  });
});

describe("Import History — Reverse Import visibility", () => {
  it("shown for an applied batch with a known mode", async () => {
    getImportBatchesMock.mockResolvedValue([makeBatch({ status: "applied", mode: "historical_opening" })]);
    render(<ImportHistoryDialog {...defaultProps} />);
    expect(await screen.findByRole("button", { name: /Reverse Import/i })).toBeInTheDocument();
  });

  it("hidden for a reversed batch", async () => {
    getImportBatchesMock.mockResolvedValue([makeBatch({ status: "reversed" })]);
    render(<ImportHistoryDialog {...defaultProps} />);
    await screen.findByText("Opening Balance");
    expect(screen.queryByRole("button", { name: /Reverse Import/i })).not.toBeInTheDocument();
  });

  it("hidden for an unrecognized mode even if status is applied", async () => {
    getImportBatchesMock.mockResolvedValue([makeBatch({ status: "applied", mode: "some_future_mode" })]);
    render(<ImportHistoryDialog {...defaultProps} />);
    await screen.findByText("some_future_mode");
    expect(screen.queryByRole("button", { name: /Reverse Import/i })).not.toBeInTheDocument();
  });
});

describe("Import History — reversal calls V2 only, never V1", () => {
  it("clicking Reverse Import calls reverseImportBatchV2, never reverseImportBatch (v1)", async () => {
    getImportBatchesMock.mockResolvedValue([makeBatch()]);
    reverseImportBatchV2Mock.mockResolvedValue({
      ok: true,
      batch_id: "batch-1",
      reversed_count: 2,
      blocked: [],
    });
    render(<ImportHistoryDialog {...defaultProps} />);

    fireEvent.click(await screen.findByRole("button", { name: /Reverse Import/i }));
    const reasonBox = await screen.findByRole("textbox");
    fireEvent.change(reasonBox, { target: { value: "Owner-requested correction" } });
    // Two "Reverse Import" buttons now coexist: the table row's action and
    // the confirmation dialog's submit button -- the row's was rendered
    // first, so the confirm dialog's is the last one in DOM order.
    const reverseButtons = screen.getAllByRole("button", { name: /^Reverse Import$/i });
    fireEvent.click(reverseButtons[reverseButtons.length - 1]);

    await waitFor(() => expect(reverseImportBatchV2Mock).toHaveBeenCalledWith("batch-1", "Owner-requested correction"));
    expect(reverseImportBatchMock).not.toHaveBeenCalled();
  });
});
