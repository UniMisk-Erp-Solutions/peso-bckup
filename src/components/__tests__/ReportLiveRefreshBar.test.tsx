import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReportLiveRefreshBar } from "@/components/ReportLiveRefreshBar";

// ── i18n mock ────────────────────────────────────────────────────────────────
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "liveRefresh.initialLoading": "Loading report…",
        "liveRefresh.initialLoadingHint": "Fetching live expenses for the selected filters.",
        "liveRefresh.refreshing": "Fetching live expenses…",
        "liveRefresh.refreshingHint": "Showing the last loaded report while the latest expenses are fetched.",
        "liveRefresh.updated": "Report updated",
        "liveRefresh.lastUpdated": `Last updated ${opts?.time ?? ""}`,
        "liveRefresh.refreshFailed": "Could not refresh the live report.",
        "liveRefresh.showingCached": "Showing the last successfully loaded report.",
        "liveRefresh.retry": "Retry",
        "liveRefresh.exportWait": "Wait for the live report refresh to finish before exporting.",
      };
      return map[key] ?? key;
    },
  }),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

type QueryState = {
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  data: unknown;
  dataUpdatedAt: number;
  refetch: () => void;
};

function makeQuery(overrides: Partial<QueryState> = {}): QueryState {
  return {
    isLoading: false,
    isFetching: false,
    isError: false,
    isSuccess: false,
    data: undefined,
    dataUpdatedAt: 0,
    refetch: vi.fn(),
    ...overrides,
  };
}

function renderBar(q: Partial<QueryState> = {}) {
  return render(<ReportLiveRefreshBar query={makeQuery(q)} />);
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("ReportLiveRefreshBar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── idle / nothing to show ─────────────────────────────────────────────────

  describe("idle state", () => {
    it("renders nothing when not fetching, no error, no success flash", () => {
      const { container } = renderBar({ isLoading: false, isFetching: false, isError: false, isSuccess: false });
      expect(container.firstChild).toBeNull();
    });

    it("renders nothing when query is idle with data (cache hit, no refetch yet)", () => {
      // isSuccess:false = hasn't completed a fetch in this render cycle; just sitting with cached data
      const { container } = renderBar({ data: [{ id: 1 }], isSuccess: false, isFetching: false, isError: false });
      expect(container.firstChild).toBeNull();
    });
  });

  // ── initial loading ────────────────────────────────────────────────────────

  describe("initial loading state", () => {
    it("shows loading text when isLoading and no data", () => {
      renderBar({ isLoading: true, isFetching: true, data: undefined });
      expect(screen.getByText("Loading report…")).toBeInTheDocument();
    });

    it("shows loading hint text", () => {
      renderBar({ isLoading: true, isFetching: true, data: undefined });
      expect(screen.getByText("Fetching live expenses for the selected filters.")).toBeInTheDocument();
    });

    it("has role=status for accessibility", () => {
      renderBar({ isLoading: true, isFetching: true, data: undefined });
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("does NOT show 'Retry' button during initial load", () => {
      renderBar({ isLoading: true, isFetching: true, data: undefined });
      expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    });
  });

  // ── background refresh ─────────────────────────────────────────────────────

  describe("background refresh state (has cached data)", () => {
    it("shows refreshing text when isFetching and data exists", () => {
      renderBar({ isFetching: true, data: [{ id: 1 }], isLoading: false });
      expect(screen.getByText("Fetching live expenses…")).toBeInTheDocument();
    });

    it("shows refreshing hint", () => {
      renderBar({ isFetching: true, data: [{ id: 1 }], isLoading: false });
      expect(screen.getByText("Showing the last loaded report while the latest expenses are fetched.")).toBeInTheDocument();
    });

    it("has role=status for accessibility", () => {
      renderBar({ isFetching: true, data: [{ id: 1 }], isLoading: false });
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("does NOT show the error panel while fetching (even if isError also true)", () => {
      renderBar({ isFetching: true, data: [{ id: 1 }], isLoading: false, isError: true });
      // Error state only shows when !isFetching
      expect(screen.queryByText("Could not refresh the live report.")).not.toBeInTheDocument();
    });

    it("does NOT show the initial-loading text when cached data exists", () => {
      renderBar({ isLoading: true, isFetching: true, data: [{ id: 1 }] });
      expect(screen.queryByText("Loading report…")).not.toBeInTheDocument();
    });
  });

  // ── error with cached data ─────────────────────────────────────────────────

  describe("error state with cached data", () => {
    it("shows error message", () => {
      renderBar({ isError: true, data: [{ id: 1 }], isFetching: false });
      expect(screen.getByText("Could not refresh the live report.")).toBeInTheDocument();
    });

    it("shows cached data notice", () => {
      renderBar({ isError: true, data: [{ id: 1 }], isFetching: false });
      expect(screen.getByText("Showing the last successfully loaded report.")).toBeInTheDocument();
    });

    it("shows Retry button", () => {
      renderBar({ isError: true, data: [{ id: 1 }], isFetching: false });
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });

    it("calls refetch when Retry is clicked", () => {
      const refetch = vi.fn();
      render(<ReportLiveRefreshBar query={makeQuery({ isError: true, data: [{ id: 1 }], isFetching: false, refetch })} />);
      fireEvent.click(screen.getByRole("button", { name: /retry/i }));
      expect(refetch).toHaveBeenCalledOnce();
    });

    it("does NOT show error when data is undefined (no cache)", () => {
      // Error on first load — no cached data — falls into initial loading branch or hidden
      const { container } = renderBar({ isError: true, data: undefined, isFetching: false, isLoading: false });
      // No cached data, not fetching — the component returns null (nothing useful to show)
      // (hasData=false so the error block guard `hasData && !isFetching` is false)
      expect(screen.queryByText("Could not refresh the live report.")).not.toBeInTheDocument();
    });

    it("has role=status for accessibility", () => {
      renderBar({ isError: true, data: [{ id: 1 }], isFetching: false });
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });

  // ── success flash ──────────────────────────────────────────────────────────

  describe("success flash", () => {
    it("shows 'Report updated' after a successful fetch completes", () => {
      const { rerender } = render(
        <ReportLiveRefreshBar query={makeQuery({ isFetching: true, data: [{ id: 1 }], isLoading: false })} />
      );
      // Transition to success
      rerender(
        <ReportLiveRefreshBar query={makeQuery({ isFetching: false, isSuccess: true, data: [{ id: 1 }], dataUpdatedAt: Date.now() })} />
      );
      expect(screen.getByText("Report updated")).toBeInTheDocument();
    });

    it("'Report updated' disappears after 2.5 seconds", () => {
      const { rerender } = render(
        <ReportLiveRefreshBar query={makeQuery({ isFetching: true, data: [{ id: 1 }], isLoading: false })} />
      );
      rerender(
        <ReportLiveRefreshBar query={makeQuery({ isFetching: false, isSuccess: true, data: [{ id: 1 }], dataUpdatedAt: Date.now() })} />
      );
      expect(screen.getByText("Report updated")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(2500); });
      expect(screen.queryByText("Report updated")).not.toBeInTheDocument();
    });

    it("does NOT show Retry during success flash", () => {
      const { rerender } = render(
        <ReportLiveRefreshBar query={makeQuery({ isFetching: true, data: [{ id: 1 }] })} />
      );
      rerender(
        <ReportLiveRefreshBar query={makeQuery({ isFetching: false, isSuccess: true, data: [{ id: 1 }], dataUpdatedAt: Date.now() })} />
      );
      expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    });
  });

  // ── formatTime / lastUpdated ───────────────────────────────────────────────

  describe("lastUpdated timestamp", () => {
    it("shows 'Last updated' with time when dataUpdatedAt is nonzero during success flash", () => {
      const ts = new Date("2026-07-14T14:32:00").getTime();
      const { rerender } = render(
        <ReportLiveRefreshBar query={makeQuery({ isFetching: true, data: [{ id: 1 }] })} />
      );
      rerender(
        <ReportLiveRefreshBar query={makeQuery({ isFetching: false, isSuccess: true, data: [{ id: 1 }], dataUpdatedAt: ts })} />
      );
      // The "Last updated HH:MM" line should be present
      expect(screen.getByText(/Last updated/)).toBeInTheDocument();
    });

    it("does not show 'Last updated' when dataUpdatedAt is 0", () => {
      const { rerender } = render(
        <ReportLiveRefreshBar query={makeQuery({ isFetching: true, data: [{ id: 1 }] })} />
      );
      rerender(
        <ReportLiveRefreshBar query={makeQuery({ isFetching: false, isSuccess: true, data: [{ id: 1 }], dataUpdatedAt: 0 })} />
      );
      expect(screen.queryByText(/Last updated/)).not.toBeInTheDocument();
    });
  });

  // ── state transition ordering ──────────────────────────────────────────────

  describe("state transition ordering", () => {
    it("fetching state takes priority over success flash while still fetching", () => {
      renderBar({ isFetching: true, isSuccess: true, data: [{ id: 1 }], dataUpdatedAt: Date.now() });
      // While still fetching, should not show "Report updated"
      expect(screen.queryByText("Report updated")).not.toBeInTheDocument();
      expect(screen.getByText("Fetching live expenses…")).toBeInTheDocument();
    });

    it("error state shown only when not fetching", () => {
      renderBar({ isError: true, isFetching: false, data: [{ id: 1 }] });
      expect(screen.getByText("Could not refresh the live report.")).toBeInTheDocument();
    });
  });

  // ── accessibility ──────────────────────────────────────────────────────────

  describe("accessibility", () => {
    it("all visible states have role=status", () => {
      // initial loading
      const { unmount: u1 } = renderBar({ isLoading: true, isFetching: true, data: undefined });
      expect(screen.getByRole("status")).toBeInTheDocument();
      u1();

      // background refresh
      const { unmount: u2 } = renderBar({ isFetching: true, data: [1] });
      expect(screen.getByRole("status")).toBeInTheDocument();
      u2();

      // error
      const { unmount: u3 } = renderBar({ isError: true, data: [1], isFetching: false });
      expect(screen.getByRole("status")).toBeInTheDocument();
      u3();
    });
  });
});
