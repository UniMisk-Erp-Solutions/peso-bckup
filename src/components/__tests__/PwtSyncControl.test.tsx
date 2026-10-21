import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const startPwtSync = vi.fn(async () => ({ jobId: "j1", deduplicated: false }));

vi.mock("@/lib/pwt/pwtSync", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pwt/pwtSync")>("@/lib/pwt/pwtSync");
  return {
    ...actual,
    listPwtJobs: vi.fn(async () => []),
    listPwtConnectors: vi.fn(async () => []),
    continuePwtJob: vi.fn(async () => ({ claimed: false, done: true })),
    startPwtSync: (...a: unknown[]) => (startPwtSync as unknown as (...x: unknown[]) => Promise<unknown>)(...a),
  };
});

import { PwtSyncControl } from "../PwtSyncControl";

const renderFor = (reportType: string) =>
  render(<MemoryRouter><PwtSyncControl organizationId="org-1" params={{ reportType }} /></MemoryRouter>);

describe("Sync to Tally control", () => {
  beforeEach(() => { startPwtSync.mockClear(); });

  it("a posting report always syncs (it creates vouchers)", async () => {
    renderFor("detailed_expense");
    fireEvent.click(await screen.findByTestId("sync-to-tally"));
    await waitFor(() => expect(startPwtSync).toHaveBeenCalledTimes(1));
  });
});
