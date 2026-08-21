/**
 * Behavioral UI tests for DropdownBulkImportDialog — the shared bulk-import
 * dialog opened from both Parent Options and Dependent Fields.
 *
 * Covers the architecture rule directly: the dialog must never call onApply
 * until the user explicitly presses "Apply to draft", Cancel must leave the
 * caller's draft untouched, and Replace mode must require confirmation.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DraftOptionBranch } from "@/lib/optionBranchPersistence";
import { DropdownBulkImportDialog, type DropdownBulkImportApplyPayload } from "../DropdownBulkImportDialog";

function renderDialog(overrides?: {
  existingOptions?: string[];
  existingBranchDrafts?: DraftOptionBranch[];
  onApply?: (p: DropdownBulkImportApplyPayload) => void;
}) {
  const onApply = overrides?.onApply ?? vi.fn();
  const onOpenChange = vi.fn();
  render(
    <DropdownBulkImportDialog
      open
      onOpenChange={onOpenChange}
      existingOptions={overrides?.existingOptions ?? []}
      existingBranchDrafts={overrides?.existingBranchDrafts ?? []}
      onApply={onApply}
    />,
  );
  return { onApply, onOpenChange };
}

function pasteText(text: string) {
  const textarea = screen.getByPlaceholderText(/paste values here/i);
  fireEvent.change(textarea, { target: { value: text } });
}

describe("DropdownBulkImportDialog", () => {
  it("i18n keys resolve to real copy, not raw key strings (dialog chrome uses t() with English defaultValue)", () => {
    renderDialog();
    expect(screen.getByText("Import dropdown data")).toBeInTheDocument();
    expect(screen.getByText(/Paste from Excel, Google Sheets, CSV/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Apply to draft$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeInTheDocument();
    // None of the dropdownImport.* key paths should ever leak into the DOM as raw text.
    expect(screen.queryByText(/dropdownImport\./)).not.toBeInTheDocument();
  });

  it("does not call onApply just from typing/pasting — only on Apply click", () => {
    const { onApply } = renderDialog();
    pasteText("Ahmedabad\nMumbai\nSurat");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("detects a simple flat list and shows a preview", () => {
    renderDialog();
    pasteText("Ahmedabad\nMumbai\nSurat\nDelhi");
    expect(screen.getByText("Simple list")).toBeInTheDocument();
    expect(screen.getByText("Ahmedabad")).toBeInTheDocument();
    expect(screen.getByText("Delhi")).toBeInTheDocument();
  });

  it("detects a dependent dropdown table and shows parent/dependent columns", () => {
    renderDialog();
    pasteText(
      ["Project Unique ID,Project ID,Project Name", "UID-001,P-101,Alpha Tower", "UID-002,P-201,Beta Plaza"].join(
        "\n",
      ),
    );
    expect(screen.getByText(/Dependent dropdown table/i)).toBeInTheDocument();
    expect(screen.getAllByText("Project Unique ID").length).toBeGreaterThan(0);
  });

  it("Cancel closes the dialog without calling onApply", () => {
    const { onApply, onOpenChange } = renderDialog();
    pasteText("Ahmedabad\nMumbai");
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Apply disabled with no input, enabled once usable data is present", () => {
    renderDialog();
    const applyButton = screen.getByRole("button", { name: /apply to draft/i });
    expect(applyButton).toBeDisabled();
    pasteText("Ahmedabad\nMumbai");
    expect(applyButton).not.toBeDisabled();
  });

  it("applies a flat list via Merge and reports added/skipped counts", () => {
    const onApply = vi.fn();
    renderDialog({ existingOptions: ["Ahmedabad"], onApply });
    pasteText("Ahmedabad\nMumbai\nSurat");
    fireEvent.click(screen.getByRole("button", { name: /apply to draft/i }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const payload = onApply.mock.calls[0][0] as DropdownBulkImportApplyPayload;
    expect(payload.options).toEqual(["Ahmedabad", "Mumbai", "Surat"]);
    expect(payload.summaryText).toMatch(/2 options added/);
  });

  it("applies a dependent table (merge) and populates both options and branchDrafts", () => {
    const onApply = vi.fn();
    renderDialog({ onApply });
    pasteText(
      ["Project Unique ID,Project ID,Project Name", "UID-001,P-101,Alpha Tower", "UID-002,P-201,Beta Plaza"].join(
        "\n",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /apply to draft/i }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const payload = onApply.mock.calls[0][0] as DropdownBulkImportApplyPayload;
    expect(payload.options).toEqual(["UID-001", "UID-002"]);
    expect(payload.branchDrafts.length).toBeGreaterThan(0);
    expect(payload.branchDrafts.some((b) => b.name === "Project ID")).toBe(true);
    expect(payload.branchDrafts.some((b) => b.name === "Project Name")).toBe(true);
  });

  it("Replace mode requires confirmation before onApply is called", () => {
    const onApply = vi.fn();
    const existing: DraftOptionBranch[] = [
      {
        localId: "existing-1",
        dbId: "db-1",
        parent_option_value: "UID-001",
        parent_branch_local_id: null,
        field_key: "project_id",
        name: "Project ID",
        field_type: "select",
        required: false,
        placeholder: "",
        help_text: "",
        options: ["OLD-VALUE"],
        display_order: 0,
      },
    ];
    renderDialog({ existingOptions: ["UID-001"], existingBranchDrafts: existing, onApply });
    pasteText(
      ["Project Unique ID,Project ID,Project Name", "UID-001,P-101,Alpha Tower"].join("\n"),
    );

    fireEvent.click(screen.getByRole("radio", { name: /replace imported scope/i }));
    fireEvent.click(screen.getByRole("button", { name: /apply to draft/i }));

    // Confirmation dialog appears; onApply must NOT have fired yet.
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText(/Replace imported scope\?/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /replace and apply to draft/i }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("does not mutate existingBranchDrafts in place before Apply", () => {
    const existing: DraftOptionBranch[] = [
      {
        localId: "existing-1",
        dbId: "db-1",
        parent_option_value: "UID-001",
        parent_branch_local_id: null,
        field_key: "project_id",
        name: "Project ID",
        field_type: "select",
        required: false,
        placeholder: "",
        help_text: "",
        options: ["OLD-VALUE"],
        display_order: 0,
      },
    ];
    const snapshot = JSON.stringify(existing);
    renderDialog({ existingOptions: ["UID-001"], existingBranchDrafts: existing });
    pasteText(
      ["Project Unique ID,Project ID,Project Name", "UID-001,P-101,Alpha Tower"].join("\n"),
    );
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it("shows summary chips reflecting the analysis", () => {
    renderDialog();
    pasteText("Ahmedabad\nMumbai");
    expect(screen.getByText(/Ready to apply/i)).toBeInTheDocument();
  });

  it("blocks Apply and shows an error state for an empty/invalid dependent table", () => {
    renderDialog();
    pasteText("OnlyOneColumn\na\nb");
    // Single column -> treated as a flat list, which IS valid (each row an option) —
    // exercise a genuinely invalid case instead: duplicate dependent headers.
    pasteText("Parent,ID,ID\nU1,1,2");
    expect(screen.getByText(/Cannot apply/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /apply to draft/i })).toBeDisabled();
  });

  it("rejects an oversized uploaded file before ever reading its contents", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("tab", { name: /upload file/i }));
    await screen.findByText(/Drop a file here/i);

    const file = new File(["irrelevant"], "huge.csv", { type: "text/csv" });
    Object.defineProperty(file, "size", { value: 11 * 1024 * 1024 }); // just over the 10MB guard
    // jsdom's File polyfill doesn't implement .text()/.arrayBuffer(), so stub
    // them directly (rather than vi.spyOn an existing method) purely to prove
    // they are never invoked when the size guard rejects the file first.
    const textStub = vi.fn();
    const arrayBufferStub = vi.fn();
    Object.assign(file, { text: textStub, arrayBuffer: arrayBufferStub });

    const input = await waitFor(() => {
      const el = document.querySelector('input[type="file"]');
      if (!el) throw new Error("file input not found");
      return el as HTMLInputElement;
    });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/File too large/i)).toBeInTheDocument();
    expect(textStub).not.toHaveBeenCalled();
    expect(arrayBufferStub).not.toHaveBeenCalled();
    expect(screen.queryByText(/Loaded:/i)).not.toBeInTheDocument();
  });

  it("accepts a file at/under the size limit and proceeds to read it", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("tab", { name: /upload file/i }));
    await screen.findByText(/Drop a file here/i);

    const file = new File(["Ahmedabad\nMumbai\nSurat"], "small.csv", { type: "text/csv" });
    const textStub = vi.fn().mockResolvedValue("Ahmedabad\nMumbai\nSurat");
    Object.assign(file, { text: textStub });

    const input = await waitFor(() => {
      const el = document.querySelector('input[type="file"]');
      if (!el) throw new Error("file input not found");
      return el as HTMLInputElement;
    });
    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByText(/Loaded: small\.csv/i);
    expect(textStub).toHaveBeenCalled();
    expect(screen.queryByText(/File too large/i)).not.toBeInTheDocument();
  });
});
