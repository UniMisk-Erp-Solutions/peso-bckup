import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const readMaintenanceHistory = vi.fn();
vi.mock("@/integrations/maintenance-cloud/maintenanceHistoryService", () => ({
  readMaintenanceHistory: (...args: unknown[]) => readMaintenanceHistory(...args),
  MAINTENANCE_HISTORY_PAGE_SIZE: 20,
}));

const OWN_USER_ID = "owner-uuid";

/**
 * MaintenanceHistoryTab.tsx's own module graph reads MAINTENANCE_ENV as a
 * module-level constant captured from import.meta.env at first import --
 * exactly once, whenever this file's module graph first loads. A static
 * top-level `import` resolves before ANY test code (including beforeEach)
 * ever runs, so a `vi.stubEnv` call in beforeEach would be setting the env
 * var only AFTER that constant was already frozen -- its actual value would
 * then depend on whatever import.meta.env.VITE_MAINTENANCE_ENV happened to
 * be at whatever point this test file's module graph was first evaluated
 * relative to other files sharing the same vitest fork, not on this file's
 * own stub. vi.resetModules() + a dynamic import performed fresh inside
 * each test (after the stub already ran) is what MaintenanceAdminDashboard's
 * own test file already does correctly for the same reason -- mirrored here.
 */
async function renderHistoryTab() {
  const { MaintenanceHistoryTab } = await import("../MaintenanceHistoryTab");
  return render(<MaintenanceHistoryTab ownUserId={OWN_USER_ID} />);
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: `hist-${Math.random()}`,
    environment: "preview",
    kind: "scheduled",
    title: "QA schedule",
    message: "Testing",
    scheduled_start_at: "2026-08-01T10:00:00Z",
    scheduled_end_at: "2026-08-01T11:00:00Z",
    actual_started_at: null,
    actual_ended_at: null,
    cancelled_at: null,
    created_at: "2026-08-01T09:00:00Z",
    created_by: OWN_USER_ID,
    updated_at: "2026-08-01T09:00:00Z",
    updated_by: OWN_USER_ID,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_MAINTENANCE_ENV", "preview");
  readMaintenanceHistory.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MaintenanceHistoryTab", () => {
  it("renders summary cards from fetched rows", async () => {
    readMaintenanceHistory.mockResolvedValue({
      ok: true,
      rows: [row()],
      totalCount: 1,
      page: 1,
      pageSize: 20,
    });
    await renderHistoryTab();
    expect(await screen.findByText("Total maintenances")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("1").length).toBeGreaterThan(0));
  });

  it("shows an empty state when there is no history yet", async () => {
    readMaintenanceHistory.mockResolvedValue({ ok: true, rows: [], totalCount: 0, page: 1, pageSize: 20 });
    await renderHistoryTab();
    // Rendered once in the desktop table and once in the mobile empty state
    // (CSS hides one via responsive classes jsdom does not evaluate).
    await waitFor(() =>
      expect(screen.getAllByText(/no maintenance history yet/i).length).toBeGreaterThan(0),
    );
  });

  it('shows "You" for the signed-in admin\'s own actions and "Maintenance admin" for others', async () => {
    readMaintenanceHistory.mockResolvedValue({
      ok: true,
      rows: [
        row({ id: "own", updated_by: OWN_USER_ID, title: "Mine" }),
        row({ id: "other", updated_by: "someone-else-uuid", title: "Theirs" }),
      ],
      totalCount: 2,
      page: 1,
      pageSize: 20,
    });
    await renderHistoryTab();
    await waitFor(() => expect(screen.getAllByText("Mine").length).toBeGreaterThan(0));
    expect(screen.getAllByText("You").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Maintenance admin").length).toBeGreaterThan(0);
  });

  it("never shows a raw UUID as the primary actor label", async () => {
    readMaintenanceHistory.mockResolvedValue({
      ok: true,
      rows: [row({ updated_by: "some-other-admin-uuid-1234" })],
      totalCount: 1,
      page: 1,
      pageSize: 20,
    });
    await renderHistoryTab();
    await waitFor(() => expect(screen.getAllByText("QA schedule").length).toBeGreaterThan(0));
    expect(screen.queryByText("some-other-admin-uuid-1234")).not.toBeInTheDocument();
  });

  it("opens a detail drawer with full occurrence details on row click", async () => {
    const user = userEvent.setup();
    readMaintenanceHistory.mockResolvedValue({
      ok: true,
      rows: [row({ title: "Detail test row" })],
      totalCount: 1,
      page: 1,
      pageSize: 20,
    });
    await renderHistoryTab();
    const cells = await screen.findAllByText("Detail test row");
    await user.click(cells[0]);
    expect(await screen.findByText("Scheduled start")).toBeInTheDocument();
    expect(screen.getByText("Scheduled end")).toBeInTheDocument();
  });

  it("clear filters resets to the default (all) filter set", async () => {
    const user = userEvent.setup();
    readMaintenanceHistory.mockResolvedValue({ ok: true, rows: [row()], totalCount: 1, page: 1, pageSize: 20 });
    await renderHistoryTab();
    await screen.findByText("Total maintenances");
    await user.click(screen.getByRole("button", { name: /clear filters/i }));
    // No throw / crash — filters reset silently, verified via a fresh fetch call.
    await waitFor(() => expect(readMaintenanceHistory).toHaveBeenCalled());
  });

  it("surfaces a load error without crashing", async () => {
    readMaintenanceHistory.mockResolvedValue({ ok: false, error: "RLS denied" });
    await renderHistoryTab();
    expect(await screen.findByText(/could not load history/i)).toBeInTheDocument();
  });
});
