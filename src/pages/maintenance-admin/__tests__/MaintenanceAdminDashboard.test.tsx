import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const toastSpy = vi.fn();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

const getOwnMaintenanceAdminAuthorization = vi.fn();
const signOutMaintenanceAdmin = vi.fn();
vi.mock("@/integrations/maintenance-cloud/maintenanceAdminService", () => ({
  getOwnMaintenanceAdminAuthorization: (...args: unknown[]) =>
    getOwnMaintenanceAdminAuthorization(...args),
  signOutMaintenanceAdmin: (...args: unknown[]) => signOutMaintenanceAdmin(...args),
}));

const readMaintenanceStatusForAdmin = vi.fn();
const updateMaintenanceStatus = vi.fn();
vi.mock("@/integrations/maintenance-cloud/maintenanceStatusService", () => ({
  readMaintenanceStatusForAdmin: (...args: unknown[]) => readMaintenanceStatusForAdmin(...args),
  updateMaintenanceStatus: (...args: unknown[]) => updateMaintenanceStatus(...args),
}));

const readMaintenanceHistory = vi.fn();
vi.mock("@/integrations/maintenance-cloud/maintenanceHistoryService", () => ({
  readMaintenanceHistory: (...args: unknown[]) => readMaintenanceHistory(...args),
  MAINTENANCE_HISTORY_PAGE_SIZE: 20,
}));

const ADMIN_AUTHORIZED = {
  ok: true as const,
  admin: {
    user_id: "test-admin-uuid",
    is_active: true,
    can_manage_preview: true,
    can_manage_production: true,
    can_view_history: false,
    created_at: "2026-08-15T00:00:00Z",
    updated_at: "2026-08-15T00:00:00Z",
  },
};

const NORMAL_ROW = {
  environment: "preview" as const,
  force_maintenance: false,
  title: null,
  message: null,
  starts_at: null,
  ends_at: null,
  updated_at: "2026-08-15T00:00:00Z",
  updated_by: "test-admin-uuid",
};

async function renderDashboard() {
  const { MaintenanceAdminDashboard } = await import("../MaintenanceAdminDashboard");
  return render(
    <MemoryRouter initialEntries={["/admin/maintenance"]}>
      <MaintenanceAdminDashboard />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetModules();
  toastSpy.mockClear();
  getOwnMaintenanceAdminAuthorization.mockReset();
  signOutMaintenanceAdmin.mockReset();
  readMaintenanceStatusForAdmin.mockReset();
  updateMaintenanceStatus.mockReset();
  readMaintenanceHistory.mockReset();
  readMaintenanceHistory.mockResolvedValue({ ok: false, error: "not configured" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MaintenanceAdminDashboard — preview environment", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MAINTENANCE_ENV", "preview");
    getOwnMaintenanceAdminAuthorization.mockResolvedValue(ADMIN_AUTHORIZED);
    readMaintenanceStatusForAdmin.mockResolvedValue({ ok: true, row: NORMAL_ROW });
  });

  it("redirects to login when not authorized", async () => {
    getOwnMaintenanceAdminAuthorization.mockResolvedValue({
      ok: false,
      code: "no_admin_row",
      error: "Not authorized",
    });
    await renderDashboard();
    // react-router-dom's Navigate is globally stubbed in src/test/setup.ts to
    // render "Navigate to <path>" as plain text rather than actually routing.
    await waitFor(() =>
      expect(screen.getByText("Navigate to /admin/maintenance/login")).toBeInTheDocument(),
    );
  });

  it("shows a non-destructive PREVIEW badge and current status", async () => {
    await renderDashboard();
    await waitFor(() => expect(screen.getByText("PREVIEW")).toBeInTheDocument());
    expect(await screen.findByText("Normal")).toBeInTheDocument();
  });

  it("enabling maintenance on preview needs a normal confirm — no typed word required", async () => {
    const user = userEvent.setup();
    updateMaintenanceStatus.mockResolvedValue({
      ok: true,
      row: { ...NORMAL_ROW, force_maintenance: true },
    });
    readMaintenanceStatusForAdmin
      .mockResolvedValueOnce({ ok: true, row: NORMAL_ROW })
      .mockResolvedValueOnce({ ok: true, row: { ...NORMAL_ROW, force_maintenance: true } });

    await renderDashboard();
    await screen.findByText("Normal");

    await user.click(screen.getByRole("button", { name: /enable maintenance now/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByLabelText(/type "production" to confirm/i)).not.toBeInTheDocument();

    const confirmButton = within(dialog).getByRole("button", { name: /confirm/i });
    expect(confirmButton).not.toBeDisabled();
    await user.click(confirmButton);

    await waitFor(() =>
      expect(updateMaintenanceStatus).toHaveBeenCalledWith(
        "preview",
        expect.objectContaining({ force_maintenance: true }),
      ),
    );
  });

  it("blocks Save schedule with only a start set, without opening the confirm dialog", async () => {
    const user = userEvent.setup();
    await renderDashboard();
    await screen.findByText("Normal");

    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-01" } });
    await user.type(screen.getByLabelText("Maintenance start time"), "3:00 PM{Enter}");
    await user.click(screen.getByRole("button", { name: /save schedule/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/end date\/time is required/i);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(updateMaintenanceStatus).not.toHaveBeenCalled();
  });

  it("shows a destructive toast and does not silently accept a read-back mismatch", async () => {
    const user = userEvent.setup();
    updateMaintenanceStatus.mockResolvedValue({
      ok: true,
      row: { ...NORMAL_ROW, force_maintenance: true },
    });
    // Read-back disagrees with what update() claimed — must not be trusted as success.
    readMaintenanceStatusForAdmin
      .mockResolvedValueOnce({ ok: true, row: NORMAL_ROW })
      .mockResolvedValueOnce({ ok: true, row: NORMAL_ROW });

    await renderDashboard();
    await screen.findByText("Normal");

    await user.click(screen.getByRole("button", { name: /enable maintenance now/i }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /confirm/i }));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      ),
    );
  });
});

describe("MaintenanceAdminDashboard — production environment", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MAINTENANCE_ENV", "production");
    getOwnMaintenanceAdminAuthorization.mockResolvedValue(ADMIN_AUTHORIZED);
    readMaintenanceStatusForAdmin.mockResolvedValue({
      ok: true,
      row: { ...NORMAL_ROW, environment: "production" },
    });
  });

  it("shows a destructive PRODUCTION badge", async () => {
    await renderDashboard();
    await waitFor(() => expect(screen.getByText("PRODUCTION")).toBeInTheDocument());
  });

  it("requires typing production before the confirm button enables on force-enable", async () => {
    const user = userEvent.setup();
    await renderDashboard();
    await screen.findByText("Normal");

    await user.click(screen.getByRole("button", { name: /enable maintenance now/i }));
    const dialog = await screen.findByRole("alertdialog");

    const confirmButton = within(dialog).getByRole("button", { name: /confirm/i });
    expect(confirmButton).toBeDisabled();

    const typedInput = within(dialog).getByLabelText(/type "production" to confirm/i);
    await user.type(typedInput, "wrong");
    expect(confirmButton).toBeDisabled();

    await user.clear(typedInput);
    await user.type(typedInput, "production");
    expect(confirmButton).not.toBeDisabled();

    expect(updateMaintenanceStatus).not.toHaveBeenCalled();
  });

  it("does not require the typed word for disabling maintenance", async () => {
    const user = userEvent.setup();
    readMaintenanceStatusForAdmin.mockResolvedValue({
      ok: true,
      row: { ...NORMAL_ROW, environment: "production", force_maintenance: true },
    });
    updateMaintenanceStatus.mockResolvedValue({
      ok: true,
      row: { ...NORMAL_ROW, environment: "production", force_maintenance: false },
    });

    await renderDashboard();
    await screen.findByText(/maintenance \(forced\)/i);

    await user.click(screen.getByRole("button", { name: /disable maintenance/i }));
    const dialog = await screen.findByRole("alertdialog");
    const confirmButton = within(dialog).getByRole("button", { name: /confirm/i });
    expect(confirmButton).not.toBeDisabled();
  });
});

describe("MaintenanceAdminDashboard — History tab gating", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MAINTENANCE_ENV", "preview");
    readMaintenanceStatusForAdmin.mockResolvedValue({ ok: true, row: NORMAL_ROW });
    readMaintenanceHistory.mockResolvedValue({ ok: true, rows: [], totalCount: 0, page: 1, pageSize: 20 });
  });

  it("shows no History tab and no tab list at all when can_view_history is false", async () => {
    getOwnMaintenanceAdminAuthorization.mockResolvedValue(ADMIN_AUTHORIZED); // can_view_history: false
    await renderDashboard();
    await screen.findByText("Normal");
    expect(screen.queryByRole("tab", { name: /history/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    // Control content still renders directly, ungated.
    expect(screen.getByRole("button", { name: /enable maintenance now/i })).toBeInTheDocument();
  });

  it("shows Control and History tabs when is_active and can_view_history are both true", async () => {
    getOwnMaintenanceAdminAuthorization.mockResolvedValue({
      ok: true,
      admin: { ...ADMIN_AUTHORIZED.admin, can_view_history: true },
    });
    await renderDashboard();
    await screen.findByText("Normal");
    expect(screen.getByRole("tab", { name: /control/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /history/i })).toBeInTheDocument();
  });

  it("does not show the History tab for an inactive admin even if can_view_history is true", async () => {
    getOwnMaintenanceAdminAuthorization.mockResolvedValue({
      ok: true,
      admin: { ...ADMIN_AUTHORIZED.admin, is_active: false, can_view_history: true },
    });
    await renderDashboard();
    // An inactive admin never reaches ok:true from getOwnMaintenanceAdminAuthorization
    // in the real service (see maintenanceAdminService.ts), but this proves the
    // dashboard's own gate is defensively correct even if that ever changed.
    await waitFor(() => expect(screen.queryByText(/checking authorization/i)).not.toBeInTheDocument());
    expect(screen.queryByRole("tab", { name: /history/i })).not.toBeInTheDocument();
  });
});
