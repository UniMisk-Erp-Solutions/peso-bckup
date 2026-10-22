import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PwtDeletion } from "@/lib/pwt/pwtDeletion";

const rows: { current: PwtDeletion[] } = { current: [] };
const retry = vi.fn(async () => true);

vi.mock("@/lib/pwt/pwtDeletion", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pwt/pwtDeletion")>("@/lib/pwt/pwtDeletion");
  return { ...actual, listPwtDeletions: vi.fn(async () => rows.current), retryPwtDeletion: (...a: unknown[]) => (retry as unknown as (...x: unknown[]) => Promise<boolean>)(...a) };
});

import { PwtDeletionHistory } from "../PwtDeletionHistory";
import { describeDeletion } from "@/lib/pwt/pwtDeletion";

const d = (over: Partial<PwtDeletion> = {}): PwtDeletion => ({
  id: "j1", transaction_number: "TXN-7", voucher_number: "PESO/08/02", voucher_date: "2026-08-31", amount: 100, employee_ledger: "Amit Test-1001",
  status: "completed", action: "delete_voucher", attempts: 1, error: null, detected_via: "trigger", created_at: "2026-10-19T10:00:00Z", completed_at: "2026-10-19T10:00:05Z", ...over,
});

describe("describeDeletion", () => {
  it("says in plain words what happened", () => {
    expect(describeDeletion(d())).toMatch(/TXN-7.*100\.00.*PESO\/08\/02.*Voucher deleted/);
    expect(describeDeletion(d({ action: "alter_voucher" }))).toMatch(/Amount removed from voucher/);
    expect(describeDeletion(d({ status: "blocked", action: null, error: "changed outside PesoWise" }))).toMatch(/not changed in Tally: changed outside PesoWise/);
    expect(describeDeletion(d({ reason: "edited", action: "alter_voucher" }))).toMatch(/Edited expense TXN-7.*Amount removed from voucher; the new version is posted next/);
    expect(describeDeletion(d({ status: "queued", action: null }))).toMatch(/waiting for the connector/);
  });
});

describe("PwtDeletionHistory", () => {
  beforeEach(() => { rows.current = []; retry.mockClear(); });

  it("shows corrections with their status, and an empty state", async () => {
    render(<PwtDeletionHistory organizationId="o" />);
    await waitFor(() => expect(screen.getByText(/Nothing has needed a correction/)).toBeTruthy());
    rows.current = [d(), d({ id: "j2", status: "queued", action: null })];
    fireEvent.click(document.body);
    render(<PwtDeletionHistory organizationId="o" />);
    await waitFor(() => expect(screen.getAllByTestId("pwt-deletion-row")).toHaveLength(2));
    expect(screen.getByText("Corrected in Tally")).toBeTruthy();
    expect(screen.getByText("Waiting for the Tally connector")).toBeTruthy();
    expect(screen.queryByText("Retry")).toBeNull();                       // nothing to retry unless blocked
  });

  it("offers Retry only for a blocked correction", async () => {
    rows.current = [d({ status: "blocked", action: null, error: "the Tally voucher total (90) is not what PesoWise recorded (100)" })];
    render(<PwtDeletionHistory organizationId="o" />);
    const btn = await screen.findByText("Retry");
    fireEvent.click(btn);
    await waitFor(() => expect(retry).toHaveBeenCalledWith("o", "j1"));
  });
});
