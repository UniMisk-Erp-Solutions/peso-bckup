import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PwtConnector } from "@/lib/pwt/pwtSync";

const state: { connectors: PwtConnector[]; jobs: unknown[]; config: unknown } = { connectors: [], jobs: [], config: null };
const savePwtConfig = vi.fn(async () => undefined);
const createPairingCode = vi.fn(async () => "ABCD2345");

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ organizationId: "org-1" }) }));
vi.mock("@/components/PwtDeletionHistory", () => ({ PwtDeletionHistory: () => <div>deletion-history</div> }));
vi.mock("@/lib/pwt/pwtSync", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pwt/pwtSync")>("@/lib/pwt/pwtSync");
  return {
    ...actual,
    listPwtConnectors: vi.fn(async () => state.connectors),
    listPwtJobs: vi.fn(async () => state.jobs),
    getPwtConfig: vi.fn(async () => state.config),
    createPairingCode: (...a: unknown[]) => (createPairingCode as unknown as (...x: unknown[]) => Promise<string>)(...a),
    revokePwtConnector: vi.fn(async () => undefined),
    savePwtConfig: (...a: unknown[]) => (savePwtConfig as unknown as (...x: unknown[]) => Promise<void>)(...a),
  };
});

import AdminPwTally from "../AdminPwTally";

const conn = (over: Partial<PwtConnector> = {}): PwtConnector => ({
  id: "c1", device_name: "TALLY-PC", tally_company: "Demo Co", tally_version: "1.1.0", status: "active", paired_at: "2026-10-19T10:00:00Z",
  last_seen_at: new Date().toISOString(), last_active_company: "Demo Co", last_error: null, ...over,
});

const renderPage = () => render(<MemoryRouter><AdminPwTally /></MemoryRouter>);

describe("Tally integration setup page", () => {
  beforeEach(() => { state.connectors = []; state.jobs = []; state.config = null; createPairingCode.mockClear(); savePwtConfig.mockClear(); });

  it("guides a first-time admin: not connected, one download, 3 steps", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("pwt-status-title").textContent).toBe("Not connected yet"));
    expect(screen.getByTestId("pwt-download-exe").getAttribute("href")).toBe("/downloads/PesoWise-Tally-Setup.exe");
    for (const n of [1, 2, 3]) expect(screen.getByTestId(`pwt-step-${n}`)).toBeTruthy();
    expect((screen.getByText("Get code") as HTMLButtonElement).disabled).toBe(true);   // needs the company name first
  });

  it("creates a pairing code with a countdown and a copy button", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/Tally company name/), { target: { value: "Demo Co" } });
    fireEvent.click(screen.getByText("Get code"));
    await waitFor(() => expect(screen.getByTestId("pwt-code").textContent).toBe("ABCD2345"));
    expect(createPairingCode).toHaveBeenCalledWith("org-1", "Demo Co");
    expect(screen.getByText(/^1[45]:\d\d$/)).toBeTruthy();
    expect(screen.getByText("Copy")).toBeTruthy();
  });

  it("shows Connected only when the paired company is the one open in Tally", async () => {
    state.connectors = [conn()];
    renderPage();
    await waitFor(() => expect(screen.getByTestId("pwt-status-title").textContent).toBe("Connected"));
    expect(screen.getByText("Online")).toBeTruthy();
  });

  it("warns about the wrong company, and about an offline connector", async () => {
    state.connectors = [conn({ last_active_company: "Real Books Ltd" })];
    const a = renderPage();
    await waitFor(() => expect(screen.getByTestId("pwt-status-title").textContent).toBe("Wrong company open in Tally"));
    a.unmount();
    state.connectors = [conn({ last_seen_at: new Date(Date.now() - 3600_000).toISOString() })];
    renderPage();
    await waitFor(() => expect(screen.getByTestId("pwt-status-title").textContent).toBe("Connector is offline"));
  });

  it("the mapping tab has no change warning or notes; Save saves straight away", async () => {
    state.jobs = [{ id: "j1", report_type: "detailed_expense", status: "completed", posted_count: 5, voucher_count: 2, created_at: "2026-10-21T00:00:00Z", row_count: 5, issues: [] }];
    state.config = { categories: [{ serial: 1, expenseType: "Food", expenseLedger: "Travelling Expenses" }], voucherPrefix: "PESO" };
    renderPage();
    const tab = await screen.findByText("Ledger mapping");
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(screen.getAllByLabelText("Tally ledger").length).toBeGreaterThan(0));
    fireEvent.change(screen.getAllByLabelText("Tally ledger")[0], { target: { value: "Lodging Expenses" } });
    expect(screen.queryByTestId("pwt-change-warning")).toBeNull();
    expect(screen.queryByTestId("pwt-shared-ledger")).toBeNull();
    expect(screen.queryByText(/Voucher ID looks like/)).toBeNull();
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(savePwtConfig).toHaveBeenCalledTimes(1));
  });
});
