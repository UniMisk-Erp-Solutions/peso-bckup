/**
 * Proves the core architectural guarantee of the Cloud maintenance control
 * plane: LocalPesoWiseBootstrap (and therefore bootstrapAuthSession() /
 * local Supabase) is mounted for every outcome EXCEPT a fresh "maintenance"
 * resolution. See docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §17/§21.
 *
 * Uses vi.doMock + vi.resetModules + dynamic import per test, matching the
 * established pattern in this codebase for modules that read import.meta.env
 * at top-level (see advanceExpenseTierRoleAuthority.test.ts / systemStatusDisablement.test.ts).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import type { MaintenanceReadOutcome } from "../maintenanceResolver";

const localAppMountCount = { current: 0 };
const fetchMaintenanceStatus = vi.fn<[string | undefined, number], Promise<MaintenanceReadOutcome>>();

function mockCommonDeps() {
  vi.doMock("@/maintenance/LocalPesoWiseBootstrap", () => ({
    LocalPesoWiseBootstrap: () => {
      localAppMountCount.current += 1;
      return <div data-testid="local-app-mounted">local app</div>;
    },
  }));
  vi.doMock("@/integrations/maintenance-cloud/maintenanceStatusService", () => ({
    fetchMaintenanceStatus: (...args: [string | undefined, number]) => fetchMaintenanceStatus(...args),
  }));
}

async function loadMaintenanceBootstrap() {
  vi.resetModules();
  mockCommonDeps();
  const mod = await import("../MaintenanceBootstrap");
  return mod.MaintenanceBootstrap;
}

beforeEach(() => {
  localAppMountCount.current = 0;
  fetchMaintenanceStatus.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("MaintenanceBootstrap — disabled (VITE_MAINTENANCE_CONTROL_ENABLED !== 'true')", () => {
  it("renders the local app immediately and makes zero Cloud requests", async () => {
    vi.stubEnv("VITE_MAINTENANCE_CONTROL_ENABLED", "false");
    const MaintenanceBootstrap = await loadMaintenanceBootstrap();

    render(<MaintenanceBootstrap />);

    expect(await screen.findByTestId("local-app-mounted")).toBeInTheDocument();
    expect(fetchMaintenanceStatus).not.toHaveBeenCalled();
  });

  it("also treats an absent flag as disabled", async () => {
    vi.stubEnv("VITE_MAINTENANCE_CONTROL_ENABLED", "");
    const MaintenanceBootstrap = await loadMaintenanceBootstrap();

    render(<MaintenanceBootstrap />);

    expect(await screen.findByTestId("local-app-mounted")).toBeInTheDocument();
    expect(fetchMaintenanceStatus).not.toHaveBeenCalled();
  });
});

describe("MaintenanceBootstrap — enabled", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MAINTENANCE_CONTROL_ENABLED", "true");
    vi.stubEnv("VITE_MAINTENANCE_ENV", "production");
    vi.stubEnv("VITE_MAINTENANCE_REQUEST_TIMEOUT_MS", "2500");
  });

  it("fresh MAINTENANCE (forced): local app is NEVER mounted", async () => {
    fetchMaintenanceStatus.mockResolvedValue({
      kind: "success",
      row: {
        environment: "production",
        force_maintenance: true,
        title: "Down for maintenance",
        message: "Back soon",
        starts_at: null,
        ends_at: null,
        updated_at: new Date().toISOString(),
        updated_by: null,
      },
    });
    const MaintenanceBootstrap = await loadMaintenanceBootstrap();

    render(<MaintenanceBootstrap />);

    await screen.findByText("Down for maintenance");
    expect(localAppMountCount.current).toBe(0);
    expect(screen.queryByTestId("local-app-mounted")).not.toBeInTheDocument();
  });

  it("fresh MAINTENANCE (scheduled, active window): local app is NEVER mounted", async () => {
    const now = Date.now();
    fetchMaintenanceStatus.mockResolvedValue({
      kind: "success",
      row: {
        environment: "production",
        force_maintenance: false,
        title: "Scheduled work",
        message: null,
        starts_at: new Date(now - 60_000).toISOString(),
        ends_at: new Date(now + 60_000).toISOString(),
        updated_at: new Date().toISOString(),
        updated_by: null,
      },
    });
    const MaintenanceBootstrap = await loadMaintenanceBootstrap();

    render(<MaintenanceBootstrap />);

    await screen.findByText("Scheduled work");
    expect(localAppMountCount.current).toBe(0);
  });

  it("fresh NORMAL: local app IS mounted", async () => {
    fetchMaintenanceStatus.mockResolvedValue({
      kind: "success",
      row: {
        environment: "production",
        force_maintenance: false,
        title: null,
        message: null,
        starts_at: null,
        ends_at: null,
        updated_at: new Date().toISOString(),
        updated_by: null,
      },
    });
    const MaintenanceBootstrap = await loadMaintenanceBootstrap();

    render(<MaintenanceBootstrap />);

    expect(await screen.findByTestId("local-app-mounted")).toBeInTheDocument();
    expect(localAppMountCount.current).toBe(1);
  });

  it("fresh UPCOMING: local app IS mounted, alongside a non-blocking banner", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    fetchMaintenanceStatus.mockResolvedValue({
      kind: "success",
      row: {
        environment: "production",
        force_maintenance: false,
        title: "Upcoming window",
        message: null,
        starts_at: future,
        ends_at: new Date(Date.now() + 7_200_000).toISOString(),
        updated_at: new Date().toISOString(),
        updated_by: null,
      },
    });
    const MaintenanceBootstrap = await loadMaintenanceBootstrap();

    render(<MaintenanceBootstrap />);

    expect(await screen.findByTestId("local-app-mounted")).toBeInTheDocument();
    expect(screen.getByText(/Upcoming window/)).toBeInTheDocument();
  });

  it.each<[string, MaintenanceReadOutcome]>([
    ["timeout", { kind: "timeout" }],
    ["network_error", { kind: "network_error" }],
    ["http_error (paused/non-2xx)", { kind: "http_error", status: 503 }],
    ["malformed", { kind: "malformed" }],
    ["not_configured", { kind: "not_configured" }],
    ["no_rows", { kind: "no_rows" }],
  ])("Cloud failure (%s): fails open — local app IS mounted, no error/offline UI", async (_label, outcome) => {
    fetchMaintenanceStatus.mockResolvedValue(outcome);
    const MaintenanceBootstrap = await loadMaintenanceBootstrap();

    render(<MaintenanceBootstrap />);

    expect(await screen.findByTestId("local-app-mounted")).toBeInTheDocument();
    expect(screen.queryByText(/maintenance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });

  it("OWNER BUG REGRESSION: a transient failure during an active scheduled window must NOT unlock the app", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      // First poll: fresh success, scheduled maintenance currently active (started
      // 1 minute ago, ends in 89 minutes — matches the owner's ~90-minute window).
      fetchMaintenanceStatus.mockResolvedValueOnce({
        kind: "success",
        row: {
          environment: "production",
          force_maintenance: false,
          title: "Scheduled work",
          message: null,
          starts_at: new Date(now - 60_000).toISOString(),
          ends_at: new Date(now + 89 * 60_000).toISOString(),
          updated_at: new Date(now).toISOString(),
          updated_by: null,
        },
      });
      const MaintenanceBootstrap = await loadMaintenanceBootstrap();
      render(<MaintenanceBootstrap />);

      await vi.waitFor(() => expect(screen.getByText("Scheduled work")).toBeInTheDocument());
      expect(localAppMountCount.current).toBe(0);

      // Second poll (the interval timer firing): a transient network failure —
      // the exact scenario the owner reported. This must NOT unmount the
      // maintenance screen or mount the local app.
      fetchMaintenanceStatus.mockResolvedValueOnce({ kind: "network_error" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200_000);
      });

      expect(screen.getByText("Scheduled work")).toBeInTheDocument();
      expect(localAppMountCount.current).toBe(0);
      expect(screen.queryByTestId("local-app-mounted")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls at the configured 120s interval, not the old 20s/60s split", async () => {
    fetchMaintenanceStatus.mockResolvedValue({
      kind: "success",
      row: {
        environment: "production",
        force_maintenance: false,
        title: null,
        message: null,
        starts_at: null,
        ends_at: null,
        updated_at: new Date().toISOString(),
        updated_by: null,
      },
    });
    vi.useFakeTimers();
    try {
      const MaintenanceBootstrap = await loadMaintenanceBootstrap();
      render(<MaintenanceBootstrap />);
      await vi.waitFor(() => expect(fetchMaintenanceStatus).toHaveBeenCalledTimes(1));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(119_000);
      });
      expect(fetchMaintenanceStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(fetchMaintenanceStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("EXACT START TIMER: a future schedule enters maintenance at starts_at without waiting for the next poll", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      fetchMaintenanceStatus.mockResolvedValue({
        kind: "success",
        row: {
          environment: "production",
          force_maintenance: false,
          title: "Future window",
          message: null,
          starts_at: new Date(now + 30_000).toISOString(),
          ends_at: new Date(now + 3_630_000).toISOString(),
          updated_at: new Date(now).toISOString(),
          updated_by: null,
        },
      });
      const MaintenanceBootstrap = await loadMaintenanceBootstrap();
      render(<MaintenanceBootstrap />);

      await vi.waitFor(() => expect(screen.getByTestId("local-app-mounted")).toBeInTheDocument());
      expect(screen.queryByText("Future window")).not.toBeInTheDocument();

      // Advance just past starts_at — well short of the 120s poll interval —
      // the local exact-start timer alone must flip this to maintenance.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });

      expect(screen.getByText("Future window")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("EXACT END TIMER: an active schedule returns to normal at ends_at without waiting for the next poll", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      fetchMaintenanceStatus.mockResolvedValue({
        kind: "success",
        row: {
          environment: "production",
          force_maintenance: false,
          title: "Ending soon",
          message: null,
          starts_at: new Date(now - 60_000).toISOString(),
          ends_at: new Date(now + 30_000).toISOString(),
          updated_at: new Date(now).toISOString(),
          updated_by: null,
        },
      });
      const MaintenanceBootstrap = await loadMaintenanceBootstrap();
      render(<MaintenanceBootstrap />);

      await vi.waitFor(() => expect(screen.getByText("Ending soon")).toBeInTheDocument());

      // Once ends_at passes, the next mocked read (still the same expired
      // row) must not resurrect a schedule that has already lapsed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });

      expect(screen.queryByText("Ending soon")).not.toBeInTheDocument();
      expect(screen.getByTestId("local-app-mounted")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("SILENT POLLING: an automatic background poll while on the maintenance screen never shows a checking state", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      fetchMaintenanceStatus.mockResolvedValue({
        kind: "success",
        row: {
          environment: "production",
          force_maintenance: true,
          title: "Forced maintenance",
          message: null,
          starts_at: null,
          ends_at: null,
          updated_at: new Date(now).toISOString(),
          updated_by: null,
        },
      });
      const MaintenanceBootstrap = await loadMaintenanceBootstrap();
      render(<MaintenanceBootstrap />);

      await vi.waitFor(() => expect(screen.getByText("Forced maintenance")).toBeInTheDocument());
      // Manual button never shows a spinning/disabled state before any click.
      expect(screen.getByRole("button", { name: /check again/i })).not.toBeDisabled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(121_000);
      });

      expect(fetchMaintenanceStatus).toHaveBeenCalledTimes(2);
      // Still not showing a checking state — the automatic poll was silent.
      expect(screen.getByRole("button", { name: /check again/i })).not.toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("performs a single-flight, timeout-bounded check — never an infinite unresolved state", async () => {
    fetchMaintenanceStatus.mockResolvedValue({
      kind: "success",
      row: {
        environment: "production",
        force_maintenance: false,
        title: null,
        message: null,
        starts_at: null,
        ends_at: null,
        updated_at: new Date().toISOString(),
        updated_by: null,
      },
    });
    const MaintenanceBootstrap = await loadMaintenanceBootstrap();

    render(<MaintenanceBootstrap />);

    await waitFor(() => expect(fetchMaintenanceStatus).toHaveBeenCalledTimes(1));
    expect(fetchMaintenanceStatus).toHaveBeenCalledWith("production", 2500);
  });
});
