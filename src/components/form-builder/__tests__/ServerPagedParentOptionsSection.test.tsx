/**
 * DOC-099 regression coverage: bulk import / Matrix / presets must work
 * against a server-paged (large) template WITHOUT reintroducing a
 * full-template download. These tests assert the actual NETWORK SHAPE of
 * each action — which option values get requested/saved — not just that
 * the UI renders, since a component rendering successfully doesn't prove
 * it's scalable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerPagedParentOptionsSection } from "../ServerPagedParentOptionsSection";

Element.prototype.scrollIntoView = vi.fn();

const searchMock = vi.fn();
const getConfigMock = vi.fn();
const saveOptionMock = vi.fn();
const createOptionMock = vi.fn();
const batchGetMock = vi.fn();
const batchSaveMock = vi.fn();

vi.mock("@/lib/formBuilder/categoryServerSearchV2", async () => {
  const actual = await vi.importActual<typeof import("@/lib/formBuilder/categoryServerSearchV2")>(
    "@/lib/formBuilder/categoryServerSearchV2",
  );
  return {
    ...actual,
    searchFormTemplateParentOptions: (...args: unknown[]) => searchMock(...args),
    getFormTemplateParentOptionConfiguration: (...args: unknown[]) => getConfigMock(...args),
    saveParentOptionBranchConfigurationAtomically: (...args: unknown[]) => saveOptionMock(...args),
    createFormTemplateParentOption: (...args: unknown[]) => createOptionMock(...args),
    getFormTemplateParentOptionConfigurationsBatch: (...args: unknown[]) => batchGetMock(...args),
    saveFormTemplateParentOptionConfigurationsBatchAtomically: (...args: unknown[]) => batchSaveMock(...args),
  };
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

function makePage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    results: [],
    page: 1,
    pageSize: 25,
    totalResults: 0,
    totalPages: 1,
    hasPrevious: false,
    hasNext: false,
    ...overrides,
  };
}

function makeResult(optionValue: string) {
  return {
    optionValue,
    displayIndex: 0,
    activeRootBranchCount: 0,
    activeTotalBranchCount: 0,
    configured: false,
    integrityStatus: "not_applicable" as const,
    previewFields: [],
  };
}

const defaultProps = {
  organizationId: "org-1",
  templateId: "tmpl-1",
  existingOptions: ["A1", "A2", "A3"],
  allowNested: true,
  savedPresets: [],
  presetSummaries: [],
  presetsLoadState: "success" as const,
  presetDbAvailable: true,
  onPresetCreated: vi.fn(),
};

beforeEach(() => {
  searchMock.mockReset();
  getConfigMock.mockReset();
  saveOptionMock.mockReset();
  createOptionMock.mockReset();
  batchGetMock.mockReset();
  batchSaveMock.mockReset();

  searchMock.mockResolvedValue(
    makePage({
      results: [makeResult("A1"), makeResult("A2"), makeResult("A3")],
      totalResults: 3,
    }),
  );
  batchGetMock.mockResolvedValue([]);
  batchSaveMock.mockResolvedValue({ newOptionsAdded: 0, results: [] });
});

describe("ServerPagedParentOptionsSection — feature parity chrome", () => {
  it("Parent Options section shows the import affordance, never the old disabled-feature warning", async () => {
    render(<ServerPagedParentOptionsSection {...defaultProps} section="options" />);
    expect(await screen.findByRole("button", { name: /Paste \/ Import data/i })).toBeInTheDocument();
    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument();
  });

  it("Dependent Fields section shows Import data AND the List/Matrix toggle", async () => {
    render(<ServerPagedParentOptionsSection {...defaultProps} section="dependent" />);
    expect(await screen.findByRole("button", { name: /^Import data$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^List$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Matrix$/i })).toBeInTheDocument();
  });
});

describe("ServerPagedParentOptionsSection — network shape", () => {
  it("opening Matrix fetches configuration for ONLY the current page's option values, in one batched call", async () => {
    const user = userEvent.setup();
    render(<ServerPagedParentOptionsSection {...defaultProps} section="dependent" />);

    await waitFor(() => expect(searchMock).toHaveBeenCalled());
    const matrixBtn = await screen.findByRole("button", { name: /^Matrix$/i });
    await user.click(matrixBtn);

    await waitFor(() => expect(batchGetMock).toHaveBeenCalledTimes(1));
    // Exactly the 3 page rows — never a full-template fetch, never one call per option.
    expect(batchGetMock).toHaveBeenCalledWith("org-1", "tmpl-1", ["A1", "A2", "A3"]);
    expect(getConfigMock).not.toHaveBeenCalled();
  });

  it("opening one option still loads only that option's configuration (unchanged on-demand behavior)", async () => {
    getConfigMock.mockResolvedValue({ parentOptionValue: "A2", drafts: [], configurationFingerprint: "fp-a2" });
    render(<ServerPagedParentOptionsSection {...defaultProps} section="dependent" />);

    // Selecting an option happens from the Dependent Fields left-nav
    // sidebar row (matching main), not a table "Open" button.
    const sidebarRow = await screen.findByRole("button", { name: "A2" });
    fireEvent.click(sidebarRow);

    await waitFor(() => expect(getConfigMock).toHaveBeenCalledTimes(1));
    expect(getConfigMock).toHaveBeenCalledWith("org-1", "tmpl-1", "A2");
    expect(batchGetMock).not.toHaveBeenCalled();
  });

  it("a flat bulk import never fetches any existing branch configuration (flat imports never touch branches)", async () => {
    render(<ServerPagedParentOptionsSection {...defaultProps} section="options" />);
    fireEvent.click(await screen.findByRole("button", { name: /Paste \/ Import data/i }));

    const textarea = await screen.findByPlaceholderText(/Paste .*here|values.*here/i).catch(() => null);
    const anyTextarea = textarea ?? document.querySelector("textarea");
    expect(anyTextarea).not.toBeNull();
    fireEvent.change(anyTextarea as HTMLTextAreaElement, { target: { value: "A4\nA5\nA6" } });

    await screen.findByText(/Detected format/i);
    // A flat list touches zero existing option values -> the resolver must
    // never be invoked with anything, and batchGetMock stays untouched.
    expect(batchGetMock).not.toHaveBeenCalled();
  });

  it("a dependent-table bulk import resolves branches for ONLY the option values referenced by the imported table, not the whole template", async () => {
    batchGetMock.mockResolvedValue([
      { parentOptionValue: "A1", drafts: [], configurationFingerprint: "fp-1" },
    ]);
    render(<ServerPagedParentOptionsSection {...defaultProps} existingOptions={["A1", "A2", "A3", "A4", "A5"]} section="options" />);
    fireEvent.click(await screen.findByRole("button", { name: /Paste \/ Import data/i }));

    const anyTextarea = document.querySelector("textarea") as HTMLTextAreaElement;
    // Dependent table: first column = parent option, second column = a
    // dependent field. Only "A1" (of the 5 existing options) is referenced.
    fireEvent.change(anyTextarea, { target: { value: "Project\tType\nA1\tInternal" } });

    await waitFor(() => expect(batchGetMock).toHaveBeenCalledTimes(1));
    // The touched set is exactly ["A1"] -- A2..A5 are never requested.
    expect(batchGetMock).toHaveBeenCalledWith("org-1", "tmpl-1", ["A1"]);
  });
});

describe("ServerPagedParentOptionsSection — draft-first import (no silent mutation)", () => {
  it("a dependent-table import's branch data lands in a pending-changes bar, NOT auto-saved — matches main's draft-then-Save contract", async () => {
    batchGetMock.mockResolvedValue([
      { parentOptionValue: "A1", drafts: [], configurationFingerprint: "fp-1" },
    ]);
    render(<ServerPagedParentOptionsSection {...defaultProps} section="options" />);
    fireEvent.click(await screen.findByRole("button", { name: /Paste \/ Import data/i }));

    const anyTextarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(anyTextarea, { target: { value: "Project\tType\nA1\tInternal" } });
    await waitFor(() => expect(batchGetMock).toHaveBeenCalledTimes(1));

    const applyButton = await screen.findByRole("button", { name: /Apply to draft/i });
    fireEvent.click(applyButton);

    // The touched option's branch data is now a PENDING change requiring an
    // explicit Save — batchSaveMock must NOT have been called with any
    // branch entries yet just because the import dialog was applied.
    await screen.findByText(/unsaved dependent-field changes/i);
    const saveCallsWithEntries = batchSaveMock.mock.calls.filter(
      (call) => Array.isArray(call[3]) && call[3].length > 0,
    );
    expect(saveCallsWithEntries).toHaveLength(0);

    // Explicitly saving the pending bar is what actually persists it.
    const saveBar = screen.getByText(/unsaved dependent-field changes/i).closest("div")!;
    fireEvent.click(within(saveBar.parentElement as HTMLElement).getByRole("button", { name: /^Save/i }));
    await waitFor(() => expect(batchSaveMock).toHaveBeenCalled());
    const [, , , entries] = batchSaveMock.mock.calls.at(-1)!;
    expect(entries.map((e: { parentOptionValue: string }) => e.parentOptionValue)).toEqual(["A1"]);
  });

  it("saving the pending bar for an option NOT yet in existingOptions threads it through as a new option value, instead of hardcoding an empty array (regression: 'Parent option X is not an active option on this template')", async () => {
    // "NEW1" is referenced by the imported table's branch data but is
    // deliberately absent from existingOptions -- reproducing a dirty
    // option the template doesn't recognize yet (a stale existingOptions
    // snapshot, or a Matrix/import path that staged branch data before the
    // option was confirmed created). save_parent_option_branch_configuration_atomically
    // rejects any batch entry whose parent_option_value isn't already in
    // the template's options[], so the fix must pass "NEW1" through as
    // newOptionValues (the RPC's 3rd positional arg) so the same atomic
    // call creates it before validating the entry -- never a hardcoded [].
    batchGetMock.mockResolvedValue([
      { parentOptionValue: "NEW1", drafts: [], configurationFingerprint: null },
    ]);
    render(
      <ServerPagedParentOptionsSection {...defaultProps} existingOptions={["A1", "A2", "A3"]} section="options" />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Paste \/ Import data/i }));

    const anyTextarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(anyTextarea, { target: { value: "Project\tType\nNEW1\tInternal" } });
    await waitFor(() => expect(batchGetMock).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /Apply to draft/i }));
    await screen.findByText(/unsaved dependent-field changes/i);

    const saveBar = screen.getByText(/unsaved dependent-field changes/i).closest("div")!;
    fireEvent.click(within(saveBar.parentElement as HTMLElement).getByRole("button", { name: /^Save/i }));
    await waitFor(() => expect(batchSaveMock).toHaveBeenCalled());

    const [, , newOptionValues, entries] = batchSaveMock.mock.calls.at(-1)!;
    expect(newOptionValues).toEqual(["NEW1"]);
    expect(entries.map((e: { parentOptionValue: string }) => e.parentOptionValue)).toEqual(["NEW1"]);
  });
});
