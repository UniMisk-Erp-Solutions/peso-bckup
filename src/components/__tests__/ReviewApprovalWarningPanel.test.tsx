// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewApprovalWarningPanel } from "@/components/ReviewApprovalWarningPanel";
import { classifyForApproval, isNormallyApprovable } from "@/lib/reviewBulkSelection";

const labels = {
  readyNow: "Ready now",
  waiting: "Waiting for previous verification",
  viewWaiting: (count: number) => `View ${count} waiting`,
  hideWaiting: "Hide waiting",
  overLimit: "Over your approval limit",
  completed: "Already completed",
  selectedTotal: "Selected total",
  overrideUnavailable: "Override unavailable",
  stop: "Stop",
  managerOverride: (count: number) => `Manager Override ${count} waiting`,
  approveReadyNow: (count: number) => `Approve ${count} ready now`,
};

describe("ReviewApprovalWarningPanel canonical preview payload", () => {
  it("renders 26 ready + 1 terminal with no waiting override", () => {
    const payload = [
      ...Array.from({ length: 26 }, (_, index) => ({
        expense_id: `ready-${index + 1}`,
        amount: 100,
        is_terminal: false,
        available_actions: ["approve", "reject", "correct"],
      })),
      {
        expense_id: "done-1",
        amount: 100,
        is_terminal: true,
        available_actions: [] as string[],
      },
    ];
    const classification = classifyForApproval(
      payload.map((row) => ({
        id: row.expense_id,
        amount: row.amount,
        isTerminal: row.is_terminal,
        isReadyNow: isNormallyApprovable({
          available_actions: row.available_actions,
          isTerminal: row.is_terminal,
        }),
      })),
      500_000,
    );

    render(
      <ReviewApprovalWarningPanel
        classification={classification}
        formattedTotal="₹2,700.00"
        overrideEffective
        loading={false}
        waitingExpanded={false}
        labels={labels}
        onToggleWaiting={vi.fn()}
        onStop={vi.fn()}
        onOverride={vi.fn()}
        onApproveReady={vi.fn()}
      />,
    );

    expect(screen.getByTestId("approval-warning-ready").textContent).toBe("26");
    expect(screen.getByTestId("approval-warning-waiting").textContent).toBe("0");
    expect(screen.getByTestId("approval-warning-overlimit").textContent).toBe("0");
    expect(screen.getByTestId("approval-warning-completed").textContent).toBe("1");
    expect(screen.getByTestId("approval-warning-proceed").textContent).toBe("Approve 26 ready now");
    expect(screen.queryByTestId("approval-warning-override-open")).toBeNull();
  });
});
