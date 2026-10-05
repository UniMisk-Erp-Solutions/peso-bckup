/**
 * Real-render proof of the controlled-dialog MECHANISM behind the singular
 * Expense Review dialog fix (see EngineerReview.singularReviewDialogClose.test.ts
 * for the source-level contract against the actual page file, and that
 * file's header comment for why EngineerReview.tsx itself cannot be mounted
 * in a test -- its data pipeline needs far more Supabase query-builder
 * mocking than the shared test setup provides).
 *
 * This harness reproduces the EXACT pattern EngineerReview.tsx now uses --
 * the real `@/components/ui/dialog` (Radix) primitives, one <Dialog> per
 * row inside a list, `open` bound to `selected?.id === row.id`, and a single
 * reset callback wired through both `onOpenChange` and every terminal/manual
 * close action -- so the dialog-visibility assertions below exercise real
 * Radix mount/unmount behavior in jsdom, not a mocked stand-in.
 */
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type Row = { id: string; title: string };

/**
 * Minimal stand-in for EngineerReview.tsx's singular review dialog: same
 * controlled-Dialog wiring, same reset-on-close contract, same
 * success-closes / failure-stays-open action shape.
 */
function ReviewQueue({
  rows,
  verify,
}: {
  rows: Row[];
  verify: (id: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Row | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resetSelectedExpenseReview = () => {
    setSelected(null);
    setComment("");
    setError(null);
  };

  const onVerify = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await verify(selected.id);
      resetSelectedExpenseReview();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to verify expense");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {rows.map((row) => (
        <div key={row.id} data-testid={`row-${row.id}`}>
          <Dialog
            open={selected?.id === row.id}
            onOpenChange={(open) => {
              if (!open) resetSelectedExpenseReview();
            }}
          >
            <DialogTrigger asChild>
              <Button onClick={() => setSelected(row)}>Review {row.title}</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Expense Review</DialogTitle>
                <DialogDescription>Review expense details and verify the submission</DialogDescription>
              </DialogHeader>
              {selected && (
                <div data-testid="expense-detail">
                  <p>{selected.title}</p>
                  <input
                    aria-label="comment"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                  {error && <p role="alert">{error}</p>}
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={resetSelectedExpenseReview}>
                  Cancel
                </Button>
                <Button onClick={onVerify} disabled={busy}>
                  Verify
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      ))}
    </>
  );
}

const ROWS: Row[] = [
  { id: "exp-1", title: "Fiber Splicing" },
  { id: "exp-2", title: "OPT Installation" },
];

describe("singular Expense Review dialog lifecycle (real Radix render)", () => {
  it("clicking Review opens the dialog with the expense's details visible", () => {
    render(<ReviewQueue rows={ROWS} verify={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Review Fiber Splicing" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Expense Review")).toBeInTheDocument();
    expect(within(screen.getByTestId("expense-detail")).getByText("Fiber Splicing")).toBeInTheDocument();
  });

  it("successful Verify closes the dialog completely -- no empty shell left behind", async () => {
    const verify = vi.fn().mockResolvedValue(undefined);
    render(<ReviewQueue rows={ROWS} verify={verify} />);

    fireEvent.click(screen.getByRole("button", { name: "Review Fiber Splicing" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(verify).toHaveBeenCalledWith("exp-1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The specific regression: not merely "content gone" but the WHOLE shell,
    // including the header copy that was left behind in the reported bug.
    expect(screen.queryByText("Expense Review")).not.toBeInTheDocument();
    expect(screen.queryByText("Review expense details and verify the submission")).not.toBeInTheDocument();
  });

  it("a failed Verify keeps the dialog open with details and the user's input intact", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("Network error"));
    render(<ReviewQueue rows={ROWS} verify={verify} />);

    fireEvent.click(screen.getByRole("button", { name: "Review Fiber Splicing" }));
    fireEvent.change(screen.getByLabelText("comment"), { target: { value: "checked receipts" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Network error"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(screen.getByTestId("expense-detail")).getByText("Fiber Splicing")).toBeInTheDocument();
    expect(screen.getByLabelText("comment")).toHaveValue("checked receipts");
  });

  it("manual Cancel closes the dialog and clears state", () => {
    render(<ReviewQueue rows={ROWS} verify={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Review Fiber Splicing" }));
    fireEvent.change(screen.getByLabelText("comment"), { target: { value: "draft note" } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("the built-in dialog X (Escape-equivalent close) also runs the reset -- no stale selection left behind", () => {
    render(<ReviewQueue rows={ROWS} verify={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Review Fiber Splicing" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Reopening the SAME row afterward must show a clean comment field --
    // proves selected/comment were actually cleared, not left stale.
    fireEvent.click(screen.getByRole("button", { name: "Review Fiber Splicing" }));
    expect(screen.getByLabelText("comment")).toHaveValue("");
  });

  it("closing one row and opening a different row shows only the new row's details (no cross-row stale state)", () => {
    render(<ReviewQueue rows={ROWS} verify={vi.fn().mockResolvedValue(undefined)} />);

    fireEvent.click(screen.getByRole("button", { name: "Review Fiber Splicing" }));
    fireEvent.change(screen.getByLabelText("comment"), { target: { value: "note for exp-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Review OPT Installation" }));

    expect(within(screen.getByTestId("expense-detail")).getByText("OPT Installation")).toBeInTheDocument();
    expect(screen.queryByText("Fiber Splicing")).not.toBeInTheDocument();
    expect(screen.getByLabelText("comment")).toHaveValue("");
  });

  it("only the dialog for the selected row's identity opens -- not a shared/global boolean across rows", () => {
    render(<ReviewQueue rows={ROWS} verify={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Review Fiber Splicing" }));

    // Exactly one dialog is open (Radix portals its content to document.body,
    // so identity is verified by content, not DOM nesting under the row), and
    // it shows the row that was actually clicked -- not a shared boolean that
    // would open every row's dialog at once.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(screen.getByRole("dialog")).getByText("Fiber Splicing")).toBeInTheDocument();
  });
});
