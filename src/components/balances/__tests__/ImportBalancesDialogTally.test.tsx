/**
 * RELEASE-PREP (Tally final hardening) §11/§12 — real component-level Tally
 * wizard integration test.
 *
 * tallyBalanceImport.test.ts proves the PURE PARSER is correct in isolation.
 * This file drives the actual React wizard end to end -- a real in-memory
 * XLSX File (built with SheetJS, exactly like a browser upload), through
 * file-select -> parse -> preview -> Continue -> staging -- and asserts the
 * exact StagedImportRow values that reach insertImportRows, and that only
 * the V2 financial RPCs (validateImportBatchV2/applyImportBatchV2) are ever
 * invoked, never the v1 equivalents or a direct profiles.balance/ledger
 * write from the browser.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as XLSX from "xlsx";
import { ImportBalancesDialog } from "../ImportBalancesDialog";

// Neither a real DOM File nor node:buffer's File survives this round trip
// intact: jsdom's own File.prototype has no .arrayBuffer() at all, and
// node:buffer's File produces an ArrayBuffer that XLSX.read() fails to
// recognize as binary data inside this jsdom-environment vitest worker
// (it falls through to XLSX's raw-text/CSV fallback, "reading" the ZIP
// container's own bytes as garbled text -- confirmed by direct
// inspection). The component only ever calls two things on the file it
// receives: `.name` and `.arrayBuffer()` (never `instanceof File`,
// `.size`, or `.type`) -- so a minimal duck-typed fake that hands back the
// EXACT SAME Uint8Array.buffer this test just built, in this test file's
// own realm, with no File/Blob/FileReader machinery in between, is both
// sufficient and immune to the cross-realm issue entirely.
function fakeFile(name: string, bytes: Uint8Array): File {
  return {
    name,
    arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
  } as unknown as File;
}

const hasOrganizationFeatureMock = vi.fn();
const useBalanceHistoricalV2CapabilityMock = vi.fn();
const useBalanceAdditiveV3CapabilityMock = vi.fn();
const toastMock = vi.fn();

const validateImportBatchV2Mock = vi.fn();
const applyImportBatchV2Mock = vi.fn();
const validateImportBatchV3Mock = vi.fn();
const applyImportBatchV3Mock = vi.fn();
const getBalanceHistoricalAnchorsMock = vi.fn();

const createImportBatchMock = vi.fn();
const uploadImportSourceFileMock = vi.fn();
const attachSourceStoragePathMock = vi.fn();
const attachSourceSha256Mock = vi.fn();
const findDuplicateAppliedBatchMock = vi.fn();
const getImportRowsMock = vi.fn();
const insertImportRowsMock = vi.fn();

const supabaseFromMock = vi.fn();

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ hasOrganizationFeature: (...args: unknown[]) => hasOrganizationFeatureMock(...args) }),
}));

vi.mock("@/lib/balanceHistoricalV2Capability", () => ({
  useBalanceHistoricalV2Capability: () => useBalanceHistoricalV2CapabilityMock(),
}));

vi.mock("@/lib/balanceAdditiveV3Capability", () => ({
  useBalanceAdditiveV3Capability: () => useBalanceAdditiveV3CapabilityMock(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (...args: unknown[]) => supabaseFromMock(...args), rpc: vi.fn() },
}));

vi.mock("@/services/BalanceLedgerService", async () => {
  const actual = await vi.importActual<typeof import("@/services/BalanceLedgerService")>(
    "@/services/BalanceLedgerService",
  );
  return {
    ...actual,
    validateImportBatchV2: (...args: unknown[]) => validateImportBatchV2Mock(...args),
    applyImportBatchV2: (...args: unknown[]) => applyImportBatchV2Mock(...args),
    validateImportBatchV3: (...args: unknown[]) => validateImportBatchV3Mock(...args),
    applyImportBatchV3: (...args: unknown[]) => applyImportBatchV3Mock(...args),
    getBalanceHistoricalAnchors: (...args: unknown[]) => getBalanceHistoricalAnchorsMock(...args),
  };
});

vi.mock("@/services/BalanceImportService", async () => {
  const actual = await vi.importActual<typeof import("@/services/BalanceImportService")>(
    "@/services/BalanceImportService",
  );
  return {
    ...actual,
    createImportBatch: (...args: unknown[]) => createImportBatchMock(...args),
    uploadImportSourceFile: (...args: unknown[]) => uploadImportSourceFileMock(...args),
    attachSourceStoragePath: (...args: unknown[]) => attachSourceStoragePathMock(...args),
    attachSourceSha256: (...args: unknown[]) => attachSourceSha256Mock(...args),
    findDuplicateAppliedBatch: (...args: unknown[]) => findDuplicateAppliedBatchMock(...args),
    getImportRows: (...args: unknown[]) => getImportRowsMock(...args),
    insertImportRows: (...args: unknown[]) => insertImportRowsMock(...args),
  };
});

// ---- Fixture builder: a REAL in-memory XLSX File, mirroring
// tallyBalanceImport.test.ts's buildTallyFixture but producing a browser
// File object (not a Node buffer/workbook), since that's the actual input
// shape handleTallyFileSelected receives from a real upload. ----

interface FixtureRow {
  particulars: string;
  closing?: { value: number; side: "cr" | "dr" };
  /** Transactions Debit column (column C) -- independent of Closing Balance,
   *  only relevant to Balance Update fixtures proving Debit-only arithmetic. */
  debit?: number;
}

function buildTallyXlsxFile(opts: {
  employeeRows: FixtureRow[];
  grandTotal?: { value: number; side: "cr" | "dr" };
  period?: string;
  filename?: string;
}): File {
  const aoa: (string | number | null)[][] = [];
  aoa.push(["MicroLink Systems Pvt Ltd", null, null, null, null]);
  aoa.push(["Group Summary", null, null, null, null]);
  aoa.push([opts.period ?? "1-Jul-26 to 31-Jul-26", null, null, null, null]);
  aoa.push(["Particulars", "Opening Balance", "Transactions Debit", "Transactions Credit", "Closing Balance"]);
  for (const row of opts.employeeRows) {
    aoa.push([
      row.particulars,
      null,
      row.debit ?? null,
      null,
      row.closing ? row.closing.value : null,
    ]);
  }
  if (opts.grandTotal) {
    aoa.push(["Grand Total", null, null, null, opts.grandTotal.value]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const closingCol = 4;
  const headerRows = 4;
  opts.employeeRows.forEach((row, idx) => {
    if (!row.closing) return;
    const ref = XLSX.utils.encode_cell({ r: headerRows + idx, c: closingCol });
    ws[ref].z = row.closing.side === "cr" ? '0.00 "Cr"' : '0.00 "Dr"';
  });
  if (opts.grandTotal) {
    const ref = XLSX.utils.encode_cell({ r: headerRows + opts.employeeRows.length, c: closingCol });
    ws[ref].z = opts.grandTotal.side === "cr" ? '0.00 "Cr"' : '0.00 "Dr"';
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return fakeFile(opts.filename ?? "tally-group-summary.xlsx", new Uint8Array(buf));
}

function buildUnsupportedXlsxFile(): File {
  const ws = XLSX.utils.aoa_to_sheet([
    ["Name", "Amount"],
    ["Someone", 100],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return fakeFile("not-tally.xlsx", new Uint8Array(buf));
}

const TWO_ROW_SAMPLE: FixtureRow[] = [
  { particulars: "Rahul Kumar Verma-1001", closing: { value: 5000, side: "cr" } },
  { particulars: "Priya Singh Rathore-1002", closing: { value: 3000, side: "dr" } },
];
// signed sum: -5000 + 3000 = -2000
const TWO_ROW_SIGNED_SUM = -2000;

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  organizationId: "org-1",
};

function setGateReady() {
  hasOrganizationFeatureMock.mockReturnValue(true);
  useBalanceHistoricalV2CapabilityMock.mockReturnValue({ ready: true, loading: false, functions: {} });
  useBalanceAdditiveV3CapabilityMock.mockReturnValue({ ready: true, loading: false, functions: {} });
}

/** Makes the profiles lookup resolve these Employee IDs to real PesoWise
 *  employees -- without this, every Tally row is "Unknown Employee" and
 *  nothing is importable (the default mock returns zero profiles). */
function mockKnownEmployees(rows: Array<{ employee_id: string; name: string }>) {
  supabaseFromMock.mockReturnValue({
    select: () => ({
      eq: () => ({
        eq: () => ({
          in: () =>
            Promise.resolve({
              data: rows.map((r) => ({ employee_id: r.employee_id, name: r.name, email: null, balance: 0 })),
              error: null,
            }),
        }),
      }),
    }),
  });
}

async function selectTallySource() {
  fireEvent.click(await screen.findByRole("radio", { name: /Tally Group Summary export/i }));
}

async function uploadTallyFile(file: File) {
  const fileInput = document.querySelector('input[type="file"][accept=".xlsx"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [file] } });
}

// sha256Hex (used for client-side duplicate-file detection, unrelated to
// anything this test verifies) calls crypto.subtle.digest on the file's
// ArrayBuffer. jsdom's window.crypto delegates to Node's real webcrypto,
// whose native WebIDL converter requires an ArrayBuffer created in the
// exact same V8 context -- one built inside jsdom's sandboxed vm context
// fails that check even though it's byte-identical (a known jsdom/webcrypto
// interop limitation, unrelated to anything under test here). Stubbing the
// digest itself sidesteps it without weakening what this suite verifies.
beforeEach(() => {
  vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
  hasOrganizationFeatureMock.mockReset();
  useBalanceHistoricalV2CapabilityMock.mockReset();
  useBalanceAdditiveV3CapabilityMock.mockReset();
  toastMock.mockReset();
  validateImportBatchV2Mock.mockReset();
  applyImportBatchV2Mock.mockReset();
  validateImportBatchV3Mock.mockReset();
  applyImportBatchV3Mock.mockReset();
  getBalanceHistoricalAnchorsMock.mockReset();
  createImportBatchMock.mockReset();
  uploadImportSourceFileMock.mockReset();
  attachSourceStoragePathMock.mockReset();
  attachSourceSha256Mock.mockReset();
  findDuplicateAppliedBatchMock.mockReset();
  getImportRowsMock.mockReset();
  insertImportRowsMock.mockReset();
  supabaseFromMock.mockReset();

  setGateReady();
  supabaseFromMock.mockReturnValue({
    select: () => ({
      eq: () => ({
        eq: () => ({
          in: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
  });
  findDuplicateAppliedBatchMock.mockResolvedValue(null);
  createImportBatchMock.mockResolvedValue({ id: "batch-1", organization_id: "org-1" });
  uploadImportSourceFileMock.mockResolvedValue("org-1/batch-1/tally-group-summary.xlsx");
  attachSourceStoragePathMock.mockResolvedValue(undefined);
  attachSourceSha256Mock.mockResolvedValue(undefined);
  insertImportRowsMock.mockResolvedValue(undefined);
  validateImportBatchV2Mock.mockResolvedValue({
    ok: true,
    batch_id: "batch-1",
    row_count: 2,
    valid_row_count: 2,
    invalid_row_count: 0,
    total_delta: TWO_ROW_SIGNED_SUM,
    apply_disabled: false,
    conflict_count: 0,
  });
  // Tally always uses the additive V3 modes (opening_credit/balance_credit)
  // now, so this is the mock that actually matters for every Tally test.
  validateImportBatchV3Mock.mockResolvedValue({
    ok: true,
    batch_id: "batch-1",
    row_count: 2,
    valid_row_count: 2,
    invalid_row_count: 0,
    total_delta: TWO_ROW_SIGNED_SUM,
  });
  applyImportBatchV3Mock.mockResolvedValue({ ok: true, already_applied: false, batch_id: "batch-1", applied_count: 2 });
  getImportRowsMock.mockResolvedValue([]);
});

describe("Tally wizard — Opening Balance end-to-end staging", () => {
  it("parses, previews, and stages rows with the resolved Case A effective date (periodEnd + 1)", async () => {
    mockKnownEmployees([
      { employee_id: "1001", name: "Rahul Kumar Verma" },
      { employee_id: "1002", name: "Priya Singh Rathore" },
    ]);
    render(<ImportBalancesDialog {...defaultProps} />);

    await selectTallySource();
    fireEvent.click(await screen.findByRole("radio", { name: /^Opening Balance/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    await uploadTallyFile(buildTallyXlsxFile({ employeeRows: TWO_ROW_SAMPLE, grandTotal: { value: 2000, side: "cr" } }));

    await screen.findByText(/Reconciliation OK/i);
    // Cr / Dr / Zero counts: 1 Cr, 1 Dr, 0 zero.
    expect(screen.getByText("1 / 1 / 0")).toBeInTheDocument();
    expect(screen.getByText("2026-08-01")).toBeInTheDocument(); // periodEnd 2026-07-31 + 1 day

    const continueBtn = screen.getByRole("button", { name: /^Continue$/i });
    expect(continueBtn).not.toBeDisabled();
    fireEvent.click(continueBtn);

    await waitFor(() => expect(insertImportRowsMock).toHaveBeenCalled());
    const [batchId, stagedRows] = insertImportRowsMock.mock.calls[0];
    expect(batchId).toBe("batch-1");
    expect(stagedRows).toHaveLength(2);
    expect(stagedRows[0]).toMatchObject({
      rawEmployeeId: "1001",
      rawEmail: null,
      inputAmount: -5000,
      effectiveDate: "2026-08-01",
    });
    expect(stagedRows[0].note).toMatch(/Tally import \(2026-07-01 to 2026-07-31\)/);
    expect(stagedRows[1]).toMatchObject({
      rawEmployeeId: "1002",
      rawEmail: null,
      inputAmount: 3000,
      effectiveDate: "2026-08-01",
    });

    expect(validateImportBatchV3Mock).toHaveBeenCalledWith("batch-1");
    expect(applyImportBatchV3Mock).not.toHaveBeenCalled(); // Apply is a separate, later, explicit step
  });

  it("records the Hold flag in the staged row's note", async () => {
    mockKnownEmployees([{ employee_id: "9999", name: "Held Employee" }]);
    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(await screen.findByRole("radio", { name: /^Opening Balance/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    await uploadTallyFile(
      buildTallyXlsxFile({
        employeeRows: [{ particulars: "Held Employee-9999-Hold", closing: { value: 100, side: "dr" } }],
        grandTotal: { value: 100, side: "dr" },
      }),
    );
    await screen.findByText(/Reconciliation OK/i);
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    await waitFor(() => expect(insertImportRowsMock).toHaveBeenCalled());
    const [, stagedRows] = insertImportRowsMock.mock.calls[0];
    expect(stagedRows[0].note).toMatch(/-- Hold/);
    expect(stagedRows[0].rawEmployeeId).toBe("9999"); // Hold suffix stripped from identity
  });
});

describe("Tally wizard — Balance Update end-to-end staging", () => {
  it("stages rows with effective date = periodEnd itself (Case B, end of day)", async () => {
    mockKnownEmployees([
      { employee_id: "1001", name: "Rahul Kumar Verma" },
      { employee_id: "1002", name: "Priya Singh Rathore" },
    ]);
    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(await screen.findByRole("radio", { name: /^Balance Credit/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    await uploadTallyFile(buildTallyXlsxFile({ employeeRows: TWO_ROW_SAMPLE, grandTotal: { value: 2000, side: "cr" } }));
    await screen.findByText(/Reconciliation OK/i);
    expect(screen.getByText("2026-07-31")).toBeInTheDocument(); // periodEnd itself, not +1

    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    await waitFor(() => expect(insertImportRowsMock).toHaveBeenCalled());
    const [, stagedRows] = insertImportRowsMock.mock.calls[0];
    expect(stagedRows[0].effectiveDate).toBe("2026-07-31");
    expect(stagedRows[1].effectiveDate).toBe("2026-07-31");
  });
});

describe("Tally wizard — Allocation is impossible", () => {
  it("does not offer an Allocation option once Tally is selected as the source", async () => {
    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    expect(screen.queryByRole("radio", { name: /^Allocation/ })).not.toBeInTheDocument();
  });
});

describe("Tally wizard — fail-closed blocking conditions", () => {
  it("blocks Continue when the Grand Total row is missing entirely", async () => {
    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    await uploadTallyFile(buildTallyXlsxFile({ employeeRows: TWO_ROW_SAMPLE })); // no grandTotal
    await screen.findByText(/must include a valid Grand Total Closing Balance/i);
    expect(screen.getByRole("button", { name: /^Continue$/i })).toBeDisabled();
  });

  it("blocks Continue when the parsed total mismatches the Grand Total by more than ₹0.01", async () => {
    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    await uploadTallyFile(
      buildTallyXlsxFile({ employeeRows: TWO_ROW_SAMPLE, grandTotal: { value: 1500, side: "cr" } }), // wrong
    );
    await screen.findByText(/Reconciliation FAILED/i);
    expect(screen.getByRole("button", { name: /^Continue$/i })).toBeDisabled();
  });

  it("does NOT block Continue when a row's identity fails to parse -- it becomes a warning and the row is skipped, not fatal", async () => {
    mockKnownEmployees([{ employee_id: "100", name: "Someone" }]);
    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    await uploadTallyFile(
      buildTallyXlsxFile({
        employeeRows: [
          { particulars: "No numeric id here", closing: { value: 100, side: "dr" } },
          { particulars: "Someone-100", closing: { value: 100, side: "dr" } },
        ],
        // Grand Total includes BOTH rows -- the sheet itself reconciles even
        // though one row can never be staged.
        grandTotal: { value: 200, side: "dr" },
      }),
    );
    await screen.findByText(/Reconciliation OK/i);
    expect(screen.getAllByText(/could not be matched to an employee and will be skipped/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/"No numeric id here"/)).toBeInTheDocument();
    expect(screen.getByText(/1 row will be skipped\. The complete Tally report still reconciles\./i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Continue$/i })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    await waitFor(() => expect(insertImportRowsMock).toHaveBeenCalled());
    const [, stagedRows] = insertImportRowsMock.mock.calls[0];
    // Only the identified, matched row is staged -- the unparseable row never reaches staging.
    expect(stagedRows).toHaveLength(1);
    expect(stagedRows[0].rawEmployeeId).toBe("100");
  });

  it("blocks Continue when an employee row's Closing Balance amount itself cannot be read (a genuine reconciliation problem, distinct from identity)", async () => {
    // Built inline: an employee row with a numeric closing value but no
    // Cr/Dr marking at all -- ambiguous sign, must fail closed as an amount
    // problem, never silently treated as an identity-only skip.
    const aoa: (string | number | null)[][] = [
      ["MicroLink Systems Pvt Ltd", null, null, null, null],
      ["Group Summary", null, null, null, null],
      ["1-Jul-26 to 31-Jul-26", null, null, null, null],
      ["Particulars", "Opening Balance", "Transactions Debit", "Transactions Credit", "Closing Balance"],
      ["Someone-100", null, null, null, 500], // no Cr/Dr format -> ambiguous
      ["Someone Else-200", null, null, null, 300],
      ["Grand Total", null, null, null, 300],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws[XLSX.utils.encode_cell({ r: 5, c: 4 })].z = '0.00 "Dr"'; // valid row, unambiguous
    ws[XLSX.utils.encode_cell({ r: 6, c: 4 })].z = '0.00 "Dr"'; // Grand Total is unambiguous
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    await uploadTallyFile(fakeFile("tally-group-summary.xlsx", new Uint8Array(buf)));
    await screen.findByText(/Reconciliation FAILED/i);
    expect(screen.getByText(/unreadable Closing Balance and must be fixed in Tally/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Continue$/i })).toBeDisabled();
  });

  it("rejects an unsupported workbook shape without offering a mapping screen", async () => {
    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    await uploadTallyFile(buildUnsupportedXlsxFile());
    // Two elements both mention "doesn't look like a supported Tally Group
    // Summary export" (the heading and the parser's own detail reason) --
    // wait for either, then assert both are actually present.
    await screen.findAllByText(/doesn't look like a supported Tally Group Summary export/i);
    expect(screen.getAllByText(/doesn't look like a supported Tally Group Summary export/i)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^Continue$/i })).toBeDisabled();
  });

  it("never starts staging for a file over the 5,000-row limit", async () => {
    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    const bigRows: FixtureRow[] = Array.from({ length: 5001 }, (_, i) => ({
      particulars: `Employee ${i}-${10000 + i}`,
      closing: { value: 1, side: "dr" as const },
    }));
    await uploadTallyFile(buildTallyXlsxFile({ employeeRows: bigRows, grandTotal: { value: 5001, side: "dr" } }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringMatching(/maximum per import is 5000/i),
        }),
      ),
    );
    expect(createImportBatchMock).not.toHaveBeenCalled();
    expect(uploadImportSourceFileMock).not.toHaveBeenCalled();
    expect(insertImportRowsMock).not.toHaveBeenCalled();
  }, 15000);
});

describe("Tally wizard — employee identity preview", () => {
  it("shows a WARNING - WILL SKIP badge (not a fatal red box) when the Tally employee ID matches no active profile, and does not block Continue by itself", async () => {
    // Both rows unknown -> nothing importable -> Continue correctly stays
    // disabled (Phase 9's "at least one importable row" rule), but the
    // sheet itself must still show as reconciling and the badges must be
    // warnings, never destructive/fatal.
    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    await uploadTallyFile(buildTallyXlsxFile({ employeeRows: TWO_ROW_SAMPLE, grandTotal: { value: 2000, side: "cr" } }));
    await screen.findByText(/Reconciliation OK/i);
    expect(screen.getAllByText("WARNING — WILL SKIP")).toHaveLength(2);
    expect(screen.getByText(/Employee ID 1001 was not found in PesoWise and will be skipped\./)).toBeInTheDocument();
    expect(screen.getByText(/Employee ID 1002 was not found in PesoWise and will be skipped\./)).toBeInTheDocument();
    expect(screen.queryByText("Unknown Employee")).not.toBeInTheDocument();
    // Nothing importable -> correctly disabled, but for the RIGHT reason (no importable rows), not a fatal parse error.
    expect(screen.getByRole("button", { name: /^Continue$/i })).toBeDisabled();
  });

  it("one known + one unknown employee: Continue is enabled, and only the known employee is staged", async () => {
    mockKnownEmployees([{ employee_id: "1001", name: "Rahul Kumar Verma" }]);
    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    await uploadTallyFile(buildTallyXlsxFile({ employeeRows: TWO_ROW_SAMPLE, grandTotal: { value: 2000, side: "cr" } }));
    await screen.findByText(/Reconciliation OK/i);
    expect(screen.getByText("WARNING — WILL SKIP")).toBeInTheDocument();
    expect(screen.getByText("Matched")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Continue$/i })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    await waitFor(() => expect(insertImportRowsMock).toHaveBeenCalled());
    const [, stagedRows] = insertImportRowsMock.mock.calls[0];
    expect(stagedRows).toHaveLength(1);
    expect(stagedRows[0].rawEmployeeId).toBe("1001");
  });

  it("shows a WARNING - WILL IMPORT name-mismatch badge and keeps Employee ID as the staged identity, never the Tally name", async () => {
    mockKnownEmployees([{ employee_id: "1001", name: "Rahul K. Verma (PesoWise)" }]);
    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    await uploadTallyFile(buildTallyXlsxFile({ employeeRows: TWO_ROW_SAMPLE, grandTotal: { value: 2000, side: "cr" } }));
    await screen.findByText(/Reconciliation OK/i);

    expect(screen.getByText("WARNING — WILL IMPORT")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Name differs — Employee ID 1001 matched PesoWise employee "Rahul K\. Verma \(PesoWise\)"\. Tally name: "Rahul Kumar Verma"\. Employee ID will be used\./,
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    await waitFor(() => expect(insertImportRowsMock).toHaveBeenCalled());
    const [, stagedRows] = insertImportRowsMock.mock.calls[0];
    // Only the matched (name-mismatch) row is staged -- 1002 is unknown and skipped.
    expect(stagedRows).toHaveLength(1);
    // Identity is the Tally Employee ID, never the PesoWise display name.
    expect(stagedRows[0].rawEmployeeId).toBe("1001");
  });
});

describe("Tally preview with the Historical Balance backend NOT ready (feature flag off, capability 404)", () => {
  it("still parses and renders a full local preview, and makes ZERO calls to any staging/mutation RPC", async () => {
    // The exact scenario that was broken: flag off AND backend missing.
    // Tally selection/upload/parse/preview must all still work locally --
    // only the database-writing calls are forbidden.
    hasOrganizationFeatureMock.mockReturnValue(false);
    useBalanceHistoricalV2CapabilityMock.mockReturnValue({ ready: false, loading: false, functions: {} });

    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    await uploadTallyFile(buildTallyXlsxFile({ employeeRows: TWO_ROW_SAMPLE, grandTotal: { value: 2000, side: "cr" } }));

    // Local preview renders fully -- period, counts, reconciliation --
    // exactly as it would with the backend ready.
    await screen.findByText(/Reconciliation OK/i);
    expect(screen.getByText("2026-07-01 to 2026-07-31")).toBeInTheDocument();
    expect(screen.getByText("1 / 1 / 0")).toBeInTheDocument();

    // The "preview only, backend not installed" banner is shown, and
    // Continue is disabled.
    expect(screen.getByText(/Preview only/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Continue$/i })).toBeDisabled();

    // Attempting Continue anyway (defense in depth -- the button is
    // disabled, but the handler itself must also refuse) triggers no
    // mutation RPCs.
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    expect(createImportBatchMock).not.toHaveBeenCalled();
    expect(uploadImportSourceFileMock).not.toHaveBeenCalled();
    expect(insertImportRowsMock).not.toHaveBeenCalled();
    expect(validateImportBatchV2Mock).not.toHaveBeenCalled();
    expect(validateImportBatchV3Mock).not.toHaveBeenCalled();
    expect(applyImportBatchV2Mock).not.toHaveBeenCalled();
    expect(applyImportBatchV3Mock).not.toHaveBeenCalled();
  });

  it("Opening Balance and Balance Update remain selectable for Tally even with the flag off", async () => {
    hasOrganizationFeatureMock.mockReturnValue(false);
    useBalanceHistoricalV2CapabilityMock.mockReturnValue({ ready: false, loading: false, functions: {} });

    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();

    fireEvent.click(screen.getByRole("radio", { name: /^Balance Credit/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    await uploadTallyFile(buildTallyXlsxFile({ employeeRows: TWO_ROW_SAMPLE, grandTotal: { value: 2000, side: "cr" } }));

    await screen.findByText(/Reconciliation OK/i);
    expect(screen.getByText("2026-07-31")).toBeInTheDocument(); // Balance Update -> periodEnd itself
  });
});

describe("Zero-amount rows are a no-op, never a blocking error (ZERO-ROW-NOOP hotfix)", () => {
  it("an all-zero validated batch shows 'No change' (not 'Needs attention') and disables Apply with 'Nothing to apply', never 'need fixing'", async () => {
    mockKnownEmployees([
      { employee_id: "1001", name: "Rahul Kumar Verma" },
      { employee_id: "1002", name: "Priya Singh Rathore" },
    ]);
    // The parser's own arithmetic is proven elsewhere (tallyBalanceImport.test.ts);
    // this test only cares about how the wizard renders a validate response
    // where every row nets to zero -- so the V3 validate/rows mocks are set
    // directly to that shape, independent of what the uploaded file parses to.
    validateImportBatchV3Mock.mockResolvedValue({
      ok: true,
      batch_id: "batch-1",
      row_count: 2,
      valid_row_count: 0,
      no_op_row_count: 2,
      invalid_row_count: 0,
      total_delta: 0,
    });
    getImportRowsMock.mockResolvedValue([
      {
        id: "row-1",
        row_number: 1,
        raw_employee_id: "1001",
        raw_email: null,
        matched_user_id: "user-1001",
        current_balance_snapshot: 1000,
        input_amount: 0,
        calculated_new_balance: 1000,
        effective_date: "2026-08-01",
        note: null,
        validation_status: "no_op",
        validation_code: "no_op",
        validation_message: "No balance change.",
        ledger_entry_id: null,
        historical_position_before: null,
        conflict_status: "none",
        conflict_type: null,
        resolution_action: null,
        resolution_target_anchor_id: null,
        resolution_reason: null,
        resolution_override_balance: null,
        resolution_override_effective_date: null,
      },
      {
        id: "row-2",
        row_number: 2,
        raw_employee_id: "1002",
        raw_email: null,
        matched_user_id: "user-1002",
        current_balance_snapshot: 500,
        input_amount: 0,
        calculated_new_balance: 500,
        effective_date: "2026-08-01",
        note: null,
        validation_status: "no_op",
        validation_code: "no_op",
        validation_message: "No balance change.",
        ledger_entry_id: null,
        historical_position_before: null,
        conflict_status: "none",
        conflict_type: null,
        resolution_action: null,
        resolution_target_anchor_id: null,
        resolution_reason: null,
        resolution_override_balance: null,
        resolution_override_effective_date: null,
      },
    ]);

    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(await screen.findByRole("radio", { name: /^Opening Balance/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    await uploadTallyFile(buildTallyXlsxFile({ employeeRows: TWO_ROW_SAMPLE, grandTotal: { value: 2000, side: "cr" } }));
    await screen.findByText(/Reconciliation OK/i);

    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    await waitFor(() => expect(validateImportBatchV3Mock).toHaveBeenCalled());

    // Preview step: zero rows must show up as "No change", never counted
    // under "Needs attention" (that tile is reserved for genuine invalid rows).
    // "No change" is intentionally reused for both the summary tile label and
    // the per-row badge, so assert presence via getAllByText, not a unique match.
    await screen.findByText("Needs attention");
    expect(screen.getAllByText("No change").length).toBeGreaterThanOrEqual(3); // 1 tile label + 2 row badges
    expect(screen.queryByText("Amount is missing or zero.")).not.toBeInTheDocument();
    expect(screen.getAllByText("No balance change.")).toHaveLength(2);
    expect(screen.queryByText("Invalid amount")).not.toBeInTheDocument();

    // Confirm step: Apply is disabled because there is nothing to apply, and
    // the reason given must NOT claim rows "need fixing" -- there is nothing
    // wrong with a zero-delta row.
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    expect(await screen.findByText(/Nothing to apply/i)).toBeInTheDocument();
    expect(screen.queryByText(/need fixing before you can apply/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Apply/ })).toBeDisabled();
  });
});

describe("Server-response sanity check (2026-10-01 financial audit, defense-in-depth)", () => {
  it("blocks Apply and never calls applyImportBatchV3 when a 'valid' row's calculated_new_balance disagrees with current_balance_snapshot + input_amount -- reproducing the owner's observed Current=7000/Debit=0 -> -7000 shape even if a future server regression produced it", async () => {
    mockKnownEmployees([
      { employee_id: "1001", name: "Rahul Kumar Verma" },
      { employee_id: "1002", name: "Priya Singh Rathore" },
    ]);
    validateImportBatchV3Mock.mockResolvedValue({
      ok: true,
      batch_id: "batch-1",
      row_count: 1,
      valid_row_count: 1,
      no_op_row_count: 0,
      invalid_row_count: 0,
      total_delta: -7000,
    });
    getImportRowsMock.mockResolvedValue([
      {
        id: "row-1",
        row_number: 1,
        raw_employee_id: "1001",
        raw_email: null,
        matched_user_id: "user-1001",
        current_balance_snapshot: 7000,
        input_amount: 0,
        // Deliberately inconsistent with current_balance_snapshot + input_amount
        // (7000 + 0 = 7000) -- this is the exact wrong shape the owner reported.
        calculated_new_balance: -7000,
        effective_date: "2026-08-01",
        note: null,
        validation_status: "valid",
        validation_code: null,
        validation_message: null,
        ledger_entry_id: null,
        historical_position_before: null,
        conflict_status: "none",
        conflict_type: null,
        resolution_action: null,
        resolution_target_anchor_id: null,
        resolution_reason: null,
        resolution_override_balance: null,
        resolution_override_effective_date: null,
      },
    ]);

    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(await screen.findByRole("radio", { name: /^Balance Credit/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    await uploadTallyFile(buildTallyXlsxFile({ employeeRows: TWO_ROW_SAMPLE, grandTotal: { value: 2000, side: "cr" } }));
    await screen.findByText(/Reconciliation OK/i);

    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    await waitFor(() => expect(validateImportBatchV3Mock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    const applyButton = await screen.findByRole("button", { name: /^Apply/ });
    fireEvent.click(applyButton);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: "Balance validation returned an inconsistent result. Nothing has been applied.",
        }),
      ),
    );
    expect(applyImportBatchV3Mock).not.toHaveBeenCalled();
  });
});

describe("Balance Update happy path (2026-10-01 re-audit, Part 10/11/12): Current 7000 + Debit 5000 = 12000, Closing 50000 proven irrelevant", () => {
  it("stages input_amount=5000 (not the 50000 Closing Balance) end to end through the real parser/upload pipeline, creates the batch with mode=balance_credit, and Apply succeeds once the server confirms current+debit=new", async () => {
    mockKnownEmployees([{ employee_id: "2001", name: "Test Employee" }]);

    render(<ImportBalancesDialog {...defaultProps} />);
    await selectTallySource();
    fireEvent.click(await screen.findByRole("radio", { name: /^Balance Credit/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    // Real file, real parser: Debit=5000, Closing=50000 on the SAME row --
    // the exact shape the owner asked to prove Closing cannot influence
    // Balance Update. Grand Total reconciles against Closing Balance only
    // (independent of Debit), matching this single row's own signed closing.
    await uploadTallyFile(
      buildTallyXlsxFile({
        employeeRows: [{ particulars: "Test Employee-2001", debit: 5000, closing: { value: 50000, side: "dr" } }],
        grandTotal: { value: 50000, side: "dr" },
      }),
    );
    await screen.findByText(/Reconciliation OK/i);

    // Mocks must be set BEFORE the Continue click that actually triggers
    // stageAndValidate -- that single click both stages the real parsed row
    // and immediately calls validateImportBatchV3Mock/getImportRowsMock.
    validateImportBatchV3Mock.mockResolvedValue({
      ok: true,
      batch_id: "batch-1",
      row_count: 1,
      valid_row_count: 1,
      no_op_row_count: 0,
      invalid_row_count: 0,
      total_delta: 5000,
    });
    getImportRowsMock.mockResolvedValue([
      {
        id: "row-1",
        row_number: 1,
        raw_employee_id: "2001",
        raw_email: null,
        matched_user_id: "user-2001",
        current_balance_snapshot: 7000,
        input_amount: 5000,
        calculated_new_balance: 12000, // current + Debit, Closing (50000) nowhere in this number
        effective_date: "2026-07-31",
        note: null,
        validation_status: "valid",
        validation_code: null,
        validation_message: null,
        ledger_entry_id: null,
        historical_position_before: null,
        conflict_status: "none",
        conflict_type: null,
        resolution_action: null,
        resolution_target_anchor_id: null,
        resolution_reason: null,
        resolution_override_balance: null,
        resolution_override_effective_date: null,
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    await waitFor(() => expect(insertImportRowsMock).toHaveBeenCalled());

    // The staged amount sent to the database must be the Debit (5000),
    // never the Closing Balance (50000), never Closing-Opening, never
    // Debit-Credit -- this is the actual value that will become input_amount.
    const [, stagedRows] = insertImportRowsMock.mock.calls[0];
    expect(stagedRows[0].inputAmount).toBe(5000);
    expect(createImportBatchMock).toHaveBeenCalledWith(expect.objectContaining({ mode: "balance_credit" }));

    await waitFor(() => expect(validateImportBatchV3Mock).toHaveBeenCalled());

    // Preview must show Current/Debit/New -- 7,000 / 5,000 / 12,000 -- and
    // never the Closing Balance (50,000) or any Closing-derived figure.
    expect(await screen.findByText(/12,000/)).toBeInTheDocument();
    expect(screen.getByText(/7,000/)).toBeInTheDocument();
    expect(screen.queryByText(/50,000/)).not.toBeInTheDocument();
    expect(screen.queryByText(/57,000/)).not.toBeInTheDocument();
    expect(screen.queryByText(/45,000/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    const applyButton = await screen.findByRole("button", { name: /^Apply/ });
    expect(applyButton).not.toBeDisabled();
    fireEvent.click(applyButton);

    await waitFor(() => expect(applyImportBatchV3Mock).toHaveBeenCalledWith("batch-1"));
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/inconsistent result/i) }),
    );
  });
});
