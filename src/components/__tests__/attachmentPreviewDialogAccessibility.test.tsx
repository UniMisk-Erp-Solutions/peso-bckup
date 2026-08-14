/**
 * Radix "Missing Description" / missing DialogTitle warning
 * (debug/6456-supervisor-auth-runtime, §41). AttachmentPreviewDialog's
 * `!url` branch used to render a bare `<DialogContent />` with no title or
 * description — reachable whenever `open` and `url` briefly disagree (e.g.
 * an attachment record with a missing file_url). Real render + console spy,
 * not a source regex, since a subtle Radix prop mismatch can read fine as
 * text yet still warn at runtime.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AttachmentPreviewDialog } from "@/components/AttachmentPreviewDialog";

describe("AttachmentPreviewDialog — open with no url", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders without any Radix missing-description/title warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <AttachmentPreviewDialog open={true} onOpenChange={() => {}} url={null} />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const radixWarning = (calls: unknown[][]) =>
      calls.some((args) =>
        args.some(
          (a) =>
            typeof a === "string" &&
            (/DialogContent.*requires a.*DialogTitle/i.test(a) ||
              /Missing.*Description.*aria-describedby/i.test(a)),
        ),
      );

    expect(radixWarning(warnSpy.mock.calls)).toBe(false);
    expect(radixWarning(errorSpy.mock.calls)).toBe(false);
  });

  it("has an accessible name even with no url (title/description present, visually hidden)", () => {
    render(
      <AttachmentPreviewDialog open={true} onOpenChange={() => {}} url={null} title="Receipt" />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName();
  });
});
