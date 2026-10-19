import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PwtConnector } from "@/lib/pwt/pwtSync";

const state: { connectors: PwtConnector[] } = { connectors: [] };
const createPairingCode = vi.fn(async () => "ABCD2345");

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ organizationId: "org-1" }) }));
vi.mock("@/components/PwtDeletionHistory", () => ({ PwtDeletionHistory: () => <div>deletion-history</div> }));
vi.mock("@/lib/pwt/pwtSync", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pwt/pwtSync")>("@/lib/pwt/pwtSync");
  return {
    ...actual,
    listPwtConnectors: vi.fn(async () => state.connectors),
    listPwtJobs: vi.fn(async () => []),
    getPwtConfig: vi.fn(async () => null),
    createPairingCode: (...a: unknown[]) => (createPairingCode as unknown as (...x: unknown[]) => Promise<string>)(...a),
    revokePwtConnector: vi.fn(async () => undefined),
    savePwtConfig: vi.fn(async () => undefined),
  };
});

import AdminPwTally from "../AdminPwTally";

const conn = (over: Partial<PwtConnector> = {}): PwtConnector => ({
  id: "c1", device_name: "TALLY-PC", tally_company: "Demo Co", tally_version: "1.1.0", status: "active", paired_at: "2026-10-19T10:00:00Z",
  last_seen_at: new Date().toISOString(), last_active_company: "Demo Co", last_error: null, ...over,
});

const renderPage = () => render(<MemoryRouter><AdminPwTally /></MemoryRouter>);

describe("Tally integration setup page", () => {
  beforeEach(() => { state.connectors = []; createPairingCode.mockClear(); });

  it("guides a first-time admin: not connected, two downloads, 3 steps", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("pwt-status-title").textContent).toBe("Not connected yet"));
    expect(screen.getByTestId("pwt-download-exe").getAttribute("href")).toBe("/downloads/PesoWise-Tally-Setup.exe");
    expect(screen.getByTestId("pwt-download-tdl").getAttribute("href")).toBe("/downloads/PesoWise-Tally.tdl");
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
});
