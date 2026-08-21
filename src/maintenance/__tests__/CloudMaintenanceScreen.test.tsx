import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CloudMaintenanceScreen } from "../CloudMaintenanceScreen";
import { CloudUpcomingBanner } from "../CloudUpcomingBanner";
import type { MaintenanceResolution } from "../maintenanceResolver";

function scheduledResolution(overrides: Partial<{
  title: string | null;
  message: string | null;
  starts_at: string | null;
  ends_at: string | null;
}> = {}): Extract<MaintenanceResolution, { state: "maintenance" }> {
  return {
    state: "maintenance",
    source: "scheduled",
    row: {
      environment: "production",
      force_maintenance: false,
      title: "Scheduled work",
      message: "Back soon",
      starts_at: new Date(2026, 7, 15, 17, 30).toISOString(),
      ends_at: new Date(2026, 7, 15, 19, 0).toISOString(),
      updated_at: new Date(2026, 7, 15, 17, 30).toISOString(),
      updated_by: null,
      ...overrides,
    },
  };
}

describe("CloudMaintenanceScreen", () => {
  it("renders DD/MM/YYYY dates in the time card, not a raw locale string", () => {
    render(<CloudMaintenanceScreen resolution={scheduledResolution()} onCheckAgain={vi.fn()} />);
    expect(screen.getAllByText(/15\/08\/2026/).length).toBeGreaterThan(0);
  });

  it("shows a duration derived from the schedule window", () => {
    render(<CloudMaintenanceScreen resolution={scheduledResolution()} onCheckAgain={vi.fn()} />);
    expect(screen.getByText("Duration")).toBeInTheDocument();
    expect(screen.getByText(/1 hour 30 minutes/)).toBeInTheDocument();
  });

  it('shows "not set" for forced maintenance with no end time', () => {
    const forced: Extract<MaintenanceResolution, { state: "maintenance" }> = {
      state: "maintenance",
      source: "forced",
      row: {
        environment: "production",
        force_maintenance: true,
        title: "Immediate maintenance",
        message: null,
        starts_at: null,
        ends_at: null,
        updated_at: new Date().toISOString(),
        updated_by: null,
      },
    };
    render(<CloudMaintenanceScreen resolution={forced} onCheckAgain={vi.fn()} />);
    expect(screen.getByText("Estimated return")).toBeInTheDocument();
    expect(screen.getByText("not set")).toBeInTheDocument();
  });

  it("renders the locally-bundled illustration, never an external image", () => {
    const { container } = render(
      <CloudMaintenanceScreen resolution={scheduledResolution()} onCheckAgain={vi.fn()} />,
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/giphy|tenor|https?:\/\/.*\.(gif|png|jpg|jpeg|webp)/i);
  });

  it("Check again is a secondary action, not the prominent primary button style", () => {
    render(<CloudMaintenanceScreen resolution={scheduledResolution()} onCheckAgain={vi.fn()} />);
    const button = screen.getByRole("button", { name: /check again/i });
    expect(button.className).not.toMatch(/bg-primary/);
  });

  it("checking=true only affects the manual button, never renders an error/offline banner", () => {
    render(
      <CloudMaintenanceScreen resolution={scheduledResolution()} onCheckAgain={vi.fn()} checking />,
    );
    expect(screen.getByRole("button", { name: /check again/i })).toBeDisabled();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
  });
});

describe("CloudUpcomingBanner", () => {
  it("renders DD/MM/YYYY with time and timezone, compact and non-blocking", () => {
    const resolution: Extract<MaintenanceResolution, { state: "upcoming" }> = {
      state: "upcoming",
      row: {
        environment: "production",
        force_maintenance: false,
        title: "Upcoming window",
        message: null,
        starts_at: new Date(2026, 7, 15, 17, 30).toISOString(),
        ends_at: new Date(2026, 7, 15, 19, 0).toISOString(),
        updated_at: new Date().toISOString(),
        updated_by: null,
      },
    };
    render(<CloudUpcomingBanner resolution={resolution} />);
    expect(screen.getByText(/15\/08\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/Upcoming window/)).toBeInTheDocument();
  });
});
