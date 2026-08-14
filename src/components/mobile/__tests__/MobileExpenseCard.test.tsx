import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MobileExpenseCard, MobileExpenseItem } from "../MobileExpenseCard";

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: vi.fn(() => vi.fn()) };
});

function renderCard(expense: MobileExpenseItem) {
  return render(
    <MemoryRouter>
      <MobileExpenseCard expense={expense} />
    </MemoryRouter>,
  );
}

const base: MobileExpenseItem = {
  id: "exp-1",
  title: "Business Trip",
  destination: "Mumbai",
  trip_start: "2026-06-01",
  status: "submitted",
  total_amount: 5000,
};

describe("MobileExpenseCard", () => {
  it("renders title, destination and amount", () => {
    renderCard(base);
    expect(screen.getByText("Business Trip")).toBeInTheDocument();
    expect(screen.getByText("Mumbai")).toBeInTheDocument();
    expect(screen.getByText(/5,000/)).toBeInTheDocument();
  });

  it("shows Resubmitted badge when isResubmitted + status submitted", () => {
    renderCard({ ...base, status: "submitted", isResubmitted: true });
    expect(screen.getByText("Resubmitted")).toBeInTheDocument();
  });

  it("does NOT show Resubmitted badge when status is approved", () => {
    renderCard({ ...base, status: "approved", isResubmitted: true });
    expect(screen.queryByText("Resubmitted")).not.toBeInTheDocument();
  });

  it("shows Batch badge when batch_id present", () => {
    renderCard({ ...base, batch_id: "batch-123" });
    expect(screen.getByText("Batch")).toBeInTheDocument();
  });

  it("does not show Batch badge when batch_id is null", () => {
    renderCard({ ...base, batch_id: null });
    expect(screen.queryByText("Batch")).not.toBeInTheDocument();
  });

  it("renders category label when provided", () => {
    renderCard({ ...base, category: "travel" });
    expect(screen.getByText("travel")).toBeInTheDocument();
  });

  it("does not render destination row when absent", () => {
    renderCard({ ...base, destination: null });
    expect(screen.queryByText("Mumbai")).not.toBeInTheDocument();
  });
});
