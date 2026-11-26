import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PwtInboundJob } from "@/lib/pwt/pwtInbound";

const jobs: { current: PwtInboundJob[] } = { current: [] };
const startInboundSync = vi.fn();
const getInboundProblems = vi.fn();
const supportsDates = vi.fn(async () => true);

vi.mock("@/lib/pwt/pwtInbound", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pwt/pwtInbound")>("@/lib/pwt/pwtInbound");
  return {
    ...actual,
    listInboundJobs: vi.fn(async () => jobs.current),
    getInboundProblems: (...a: unknown[]) => getInboundProblems(...a),
    startInboundSync: (...a: unknown[]) => startInboundSync(...a),
    getInboundVoucherType: vi.fn(async () => "PesoWise Payment"),
    inboundSupportsDates: () => supportsDates(),
    setInboundVoucherType: vi.fn(async () => undefined),
  };
});
vi.mock("@/lib/pwt/pwtSync", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pwt/pwtSync")>("@/lib/pwt/pwtSync");
  return { ...actual, listPwtConnectors: vi.fn(async () => [{ id: "c", status: "active", last_seen_at: new Date().toISOString(), tally_company: "Demo", last_active_company: "Demo" }]) };
});

import { SyncFromTallyDialog } from "../SyncFromTallyDialog";

const job = (over: Partial<PwtInboundJob> = {}): PwtInboundJob => ({
  id: "j1", status: "completed", tally_company: "Demo", created_at: "2026-10-17T10:00:00Z", completed_at: "2026-10-17T10:00:09Z",
  vouchers_fetched: 3, imported_count: 2, already_imported_count: 1, skipped_count: 0, unmatched_count: 0, failed_count: 0, flagged_count: 0,
  imported_amount: 1500, progress_current: 3, progress_total: 3, error: null, ...over,
});

describe("SyncFromTallyDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    jobs.current = [];
    startInboundSync.mockReset();
    getInboundProblems.mockReset().mockResolvedValue([]);
    supportsDates.mockReset().mockResolvedValue(true);
  });
  afterEach(() => vi.useRealTimers());

  it("shows the result counts and the last successful sync of a finished job without reloading balances", async () => {
    jobs.current = [job()];
    const onSynced = vi.fn();
    render(<SyncFromTallyDialog open onOpenChange={() => undefined} organizationId="o" onSynced={onSynced} />);
    await waitFor(() => expect(screen.getByTestId("sync-from-tally-tiles")).toBeTruthy());
    expect(screen.getByTestId("sync-from-tally-summary").textContent).toMatch(/3 voucher\(s\) read · 2 imported · 1 already imported/);
    expect(screen.getByText(/Last sync:/)).toBeTruthy();
    expect(onSynced).not.toHaveBeenCalled();           // opening the dialog must not trigger a reload
  });

  it("click Sync now -> job runs -> balances reload exactly once when it finishes", async () => {
    const onSynced = vi.fn();
    startInboundSync.mockImplementation(async () => {
      jobs.current = [job({ status: "fetching", completed_at: null, progress_current: 0, progress_total: 3, imported_count: 0 })];
      return { jobId: "j1", deduplicated: false };
    });
    render(<SyncFromTallyDialog open onOpenChange={() => undefined} organizationId="o" onSynced={onSynced} />);
    await waitFor(() => expect(screen.getByTestId("sync-from-tally-start")).toBeTruthy());
    fireEvent.click(screen.getByTestId("sync-from-tally-start"));
    await waitFor(() => expect(startInboundSync).toHaveBeenCalledWith("o", { from: expect.stringMatching(/^\d{4}-\d{2}-01$/), to: null }));
    await waitFor(() => expect(screen.getByText(/Sync in progress/)).toBeTruthy());
    expect(onSynced).not.toHaveBeenCalled();

    jobs.current = [job()];                             // the connector finished and the payments were applied
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    await waitFor(() => expect(onSynced).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(onSynced).toHaveBeenCalledTimes(1);          // not repeated
  });

  it("lists every voucher that was not imported, with the reason", async () => {
    jobs.current = [job({ status: "needs_attention", unmatched_count: 1, imported_count: 0, imported_amount: 0 })];
    getInboundProblems.mockResolvedValue([{ voucher_number: "9", voucher_date: "2026-10-16", ledger_name: "Nobody-5555", amount: 100, state: "unmatched", reason: "no active employee with code 5555 in this organisation" }]);
    // a sync that finished while the dialog was closed is shown, but problems load only for a finished job we see
    render(<SyncFromTallyDialog open onOpenChange={() => undefined} organizationId="o" onSynced={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/no active employee with code 5555/)).toBeTruthy());
    expect(screen.getByText("Nobody-5555")).toBeTruthy();
  });

  it("tells the user when the connector is offline instead of waiting silently", async () => {
    jobs.current = [job({ status: "queued", completed_at: null })];
    const mod = await import("@/lib/pwt/pwtSync");
    (mod.listPwtConnectors as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: "c", status: "active", last_seen_at: new Date(Date.now() - 3600_000).toISOString(), tally_company: "Demo", last_active_company: null }]);
    render(<SyncFromTallyDialog open onOpenChange={() => undefined} organizationId="o" onSynced={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("sync-from-tally-summary").textContent).toMatch(/offline/i));
  });

  describe("choosing the voucher dates", () => {
    const start = () => fireEvent.click(screen.getByTestId("sync-from-tally-start"));
    const open = async () => {
      render(<SyncFromTallyDialog open onOpenChange={() => undefined} organizationId="o" onSynced={() => undefined} />);
      await waitFor(() => expect(screen.getByTestId("sync-from-tally-start")).toBeTruthy());
    };

    it("sends exactly the From and To the admin typed (for example 01-11-2026 to today onwards)", async () => {
      startInboundSync.mockResolvedValue({ jobId: "j1", deduplicated: false });
      await open();
      fireEvent.change(document.getElementById("pwt-date-from") as HTMLInputElement, { target: { value: "2026-11-01" } });
      fireEvent.change(document.getElementById("pwt-date-to") as HTMLInputElement, { target: { value: "" } });
      start();
      await waitFor(() => expect(startInboundSync).toHaveBeenCalledWith("o", { from: "2026-11-01", to: null }));
    });

    it("Last month fills both dates with the previous calendar month", async () => {
      await open();
      fireEvent.click(screen.getByText("Last month"));
      const from = (document.getElementById("pwt-date-from") as HTMLInputElement).value;
      const to = (document.getElementById("pwt-date-to") as HTMLInputElement).value;
      expect(from).toMatch(/^\d{4}-\d{2}-01$/);
      expect(new Date(`${to}T00:00:00`).getDate()).toBeGreaterThanOrEqual(28);          // the last day of that month
      expect(new Date(`${to}T00:00:00`).getTime()).toBeLessThan(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime());
    });

    it("refuses a start date after the end date and sends nothing", async () => {
      await open();
      fireEvent.change(document.getElementById("pwt-date-from") as HTMLInputElement, { target: { value: "2026-12-01" } });
      fireEvent.change(document.getElementById("pwt-date-to") as HTMLInputElement, { target: { value: "2026-11-01" } });
      start();
      await waitFor(() => expect(screen.getByText(/start date is after the end date/i)).toBeTruthy());
      expect(startInboundSync).not.toHaveBeenCalled();
    });

    it("needs a date, or the explicit All dates choice with its tick box", async () => {
      startInboundSync.mockResolvedValue({ jobId: "j1", deduplicated: false });
      await open();
      fireEvent.change(document.getElementById("pwt-date-from") as HTMLInputElement, { target: { value: "" } });
      start();
      await waitFor(() => expect(screen.getByText(/Choose a start date/)).toBeTruthy());
      expect(startInboundSync).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("sync-mode-all"));
      expect(screen.getByText(/credited again/)).toBeTruthy();                      // the warning is shown
      start();
      await waitFor(() => expect(screen.getByText(/Tick the box/)).toBeTruthy());
      expect(startInboundSync).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("sync-confirm-all"));
      start();
      await waitFor(() => expect(startInboundSync).toHaveBeenCalledWith("o", {}));
    });

    it("never starts a sync when the server cannot apply dates (it would read every date)", async () => {
      supportsDates.mockResolvedValue(false);
      await open();
      start();
      await waitFor(() => expect(screen.getByText(/not been updated for date selection/i)).toBeTruthy());
      expect(startInboundSync).not.toHaveBeenCalled();
    });

    it("All dates (the old behaviour) still works against a server that has not been updated", async () => {
      supportsDates.mockResolvedValue(false);
      startInboundSync.mockResolvedValue({ jobId: "j1", deduplicated: false });
      await open();
      fireEvent.click(screen.getByTestId("sync-mode-all"));
      fireEvent.click(screen.getByTestId("sync-confirm-all"));
      start();
      await waitFor(() => expect(startInboundSync).toHaveBeenCalledWith("o", {}));
    });

    it("shows which dates the last sync read, and how many vouchers were outside them", async () => {
      jobs.current = [job({ date_from: "2026-11-01", date_to: null, out_of_range_count: 7 })];
      await open();
      await waitFor(() => expect(screen.getByTestId("sync-from-tally-dates-read").textContent).toMatch(/From 01 Nov 2026/));
      expect(screen.getByTestId("sync-from-tally-summary").textContent).toMatch(/7 outside the selected dates/);
    });
  });
});
