import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SubmitStatusChoiceDialog } from "@/components/SubmitStatusChoiceDialog";

describe("SubmitStatusChoiceDialog — segregation of duties (Phase 9)", () => {
  it("defaults to Submitted and allows confirming immediately", () => {
    const onConfirm = vi.fn();
    render(<SubmitStatusChoiceDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith("submitted", "");
  });

  it("the Confirm button is disabled for 'Approved' until a reason is typed", () => {
    const onConfirm = vi.fn();
    render(<SubmitStatusChoiceDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByLabelText(/Approved/));
    const confirmButton = screen.getByRole("button", { name: /confirm/i });
    expect(confirmButton).toBeDisabled();

    fireEvent.click(confirmButton); // disabled -- must be a no-op
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows the balance-deduction warning only when Approved is selected", () => {
    render(<SubmitStatusChoiceDialog open onOpenChange={() => {}} onConfirm={vi.fn()} />);
    expect(screen.queryByText(/immediately deducts/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Approved/));
    expect(screen.getByText(/immediately deducts/i)).toBeInTheDocument();
  });

  it("typing a reason enables Confirm for Approved, and the reason is passed through", () => {
    const onConfirm = vi.fn();
    render(<SubmitStatusChoiceDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByLabelText(/Approved/));
    fireEvent.change(screen.getByPlaceholderText(/why is this being approved/i), {
      target: { value: "Urgent reimbursement, employee traveling" },
    });
    const confirmButton = screen.getByRole("button", { name: /confirm/i });
    expect(confirmButton).not.toBeDisabled();
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith("approved", "Urgent reimbursement, employee traveling");
  });

  it("Verified does not require a reason", () => {
    const onConfirm = vi.fn();
    render(<SubmitStatusChoiceDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByLabelText(/Verified/));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith("verified", "");
  });
});
