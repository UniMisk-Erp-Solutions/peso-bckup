/**
 * Regression coverage for two browser-only bugs found in manual QA that no
 * other test in this suite caught (the component had no test file of its
 * own before this):
 *
 * 1. Opening the editor (Create OR Edit) threw "ReferenceError: setBulkInput
 *    is not defined" because the bulk-import refactor removed the old
 *    bulkInput/bulkFileName/lastBulkSummary/bulkOpen state but left dangling
 *    calls to their setters in the dialog's init-on-open effect and its
 *    field-type reset callback. tsc did not catch this because
 *    tsconfig.app.json has strict/noImplicitAny off, so the now-nonexistent
 *    OptionsPanel destructured props typed as implicit `any` masked the
 *    mismatch — only an actual render exercises the crash.
 *
 * 2. Saving choices from the Matrix cell popover (MatrixCellEditor.handleSave)
 *    only trimmed and dropped blanks, but never deduped case-insensitively —
 *    unlike the bulk-import engine's own `dedupePreservingFirst`, which the
 *    spec explicitly requires this editor to match ("accept pasted choices
 *    intelligently... case-insensitive duplicate"). Duplicates instead
 *    surfaced only as a blocking validateBranchDraftsIntegrity error after
 *    the fact, requiring manual cleanup.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormFieldTemplateEditorDialog } from "../FormFieldTemplateEditorDialog";
import type { TemplateRow } from "@/lib/formBuilder/templateEditor";
import type { DraftOptionBranch } from "@/lib/optionBranchPersistence";

// jsdom does not implement these; Radix Select's internals call them when opening.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
  width: 100, height: 40, top: 0, left: 0, right: 100, bottom: 40, x: 0, y: 0, toJSON: () => {},
});

const {
  insertSpy, updateSpy, deleteSpy, deleteEqSpy, saveBranchesMock, toastSpy, mockState,
  searchMock, getConfigMock, saveOptionMock, summaryMock, createOptionMock,
} = vi.hoisted(() => ({
  insertSpy: vi.fn(),
  updateSpy: vi.fn(),
  deleteSpy: vi.fn(),
  deleteEqSpy: vi.fn(),
  saveBranchesMock: vi.fn(() => Promise.resolve({ latest_updated_at: "2026-01-02T00:00:00Z" })),
  toastSpy: vi.fn(),
  mockState: { insertShouldFail: false, deleteShouldFail: false },
  searchMock: vi.fn(),
  getConfigMock: vi.fn(),
  saveOptionMock: vi.fn(),
  summaryMock: vi.fn(),
  createOptionMock: vi.fn(),
}));

// The real dialog now routes an EXISTING select/checkbox template's Parent
// Options / Dependent Fields tabs through the server-paged V2 RPCs instead
// of the old fully-downloaded local arrays — see DOC-097 "Phase 2".
vi.mock("@/lib/formBuilder/categoryServerSearchV2", async () => {
  const actual = await vi.importActual<typeof import("@/lib/formBuilder/categoryServerSearchV2")>(
    "@/lib/formBuilder/categoryServerSearchV2",
  );
  return {
    ...actual,
    searchFormTemplateParentOptions: (...args: unknown[]) => searchMock(...args),
    getFormTemplateParentOptionConfiguration: (...args: unknown[]) => getConfigMock(...args),
    saveParentOptionBranchConfigurationAtomically: (...args: unknown[]) => saveOptionMock(...args),
    getFormTemplateEditorSummary: (...args: unknown[]) => summaryMock(...args),
    createFormTemplateParentOption: (...args: unknown[]) => createOptionMock(...args),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => Promise.resolve({ data: [], error: null })),
          })),
        })),
      })),
      insert: vi.fn((payload: unknown) => {
        insertSpy(payload);
        if (mockState.insertShouldFail) {
          return {
            select: vi.fn(() => ({
              single: vi.fn(() =>
                Promise.resolve({
                  data: null,
                  error: { message: "insert failed", code: "23502" },
                }),
              ),
            })),
          };
        }
        return {
          select: vi.fn(() => ({
            single: vi.fn(() =>
              Promise.resolve({
                data: { id: "new-tmpl-1", updated_at: "2026-01-01T00:00:00Z" },
                error: null,
              }),
            ),
          })),
        };
      }),
      update: vi.fn((payload: unknown) => {
        updateSpy(payload);
        return { eq: vi.fn(() => Promise.resolve({ error: null })) };
      }),
      delete: vi.fn(() => {
        deleteSpy();
        return {
          eq: vi.fn((col1: string, val1: unknown) => {
            deleteEqSpy(col1, val1);
            return {
              eq: vi.fn((col2: string, val2: unknown) => {
                deleteEqSpy(col2, val2);
                return Promise.resolve(
                  mockState.deleteShouldFail
                    ? { error: { message: "cleanup delete failed" } }
                    : { error: null },
                );
              }),
            };
          }),
        };
      }),
    })),
  },
}));

const ONE_BRANCH: DraftOptionBranch = {
  localId: "branch-1",
  dbId: "db-1",
  parent_option_value: "sass",
  parent_branch_local_id: null,
  field_key: "col1",
  name: "Col1",
  field_type: "select",
  required: false,
  placeholder: "",
  help_text: "",
  options: ["A"],
  display_order: 0,
};

vi.mock("@/lib/optionBranchPersistence", async () => {
  const actual = await vi.importActual<typeof import("@/lib/optionBranchPersistence")>(
    "@/lib/optionBranchPersistence",
  );
  return {
    ...actual,
    loadDraftBranchesForTemplate: vi.fn(() => Promise.resolve([ONE_BRANCH])),
    saveOptionBranchConfigurationAtomically: saveBranchesMock,
  };
});

beforeEach(() => {
  mockState.insertShouldFail = false;
  mockState.deleteShouldFail = false;
  insertSpy.mockClear();
  updateSpy.mockClear();
  deleteSpy.mockClear();
  deleteEqSpy.mockClear();
  toastSpy.mockClear();
  saveBranchesMock.mockClear();
  saveBranchesMock.mockImplementation(() => Promise.resolve({ latest_updated_at: "2026-01-02T00:00:00Z" }));

  searchMock.mockReset();
  getConfigMock.mockReset();
  saveOptionMock.mockReset();
  summaryMock.mockReset();
  createOptionMock.mockReset();
  searchMock.mockResolvedValue({
    results: [],
    page: 1, pageSize: 25, totalResults: 0, totalPages: 1, hasPrevious: false, hasNext: false,
  });
  summaryMock.mockResolvedValue({
    parentOptionCount: 2,
    configuredParentOptionCount: 1,
    activeRootBranchCount: 1,
    activeNestedBranchCount: 0,
    totalActiveBranchCount: 1,
    incompleteOptionCount: 0,
    legacyOrphanGroupCount: 0,
    templateUpdatedAt: "2026-05-01T12:00:00Z",
  });
});

function baseProps(overrides?: Partial<Parameters<typeof FormFieldTemplateEditorDialog>[0]>) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    selectedTemplate: null,
    organizationId: "org-1",
    userId: "user-1",
    allowConditionalDropdown: true,
    onSaved: vi.fn(),
    ...overrides,
  };
}

async function setupNewSelectTemplateReadyToSave(
  overrides?: Partial<Parameters<typeof FormFieldTemplateEditorDialog>[0]>,
) {
  render(<FormFieldTemplateEditorDialog {...baseProps({ selectedTemplate: null, ...overrides })} />);
  await waitFor(() => expect(screen.getByRole("tab", { name: /Basics/i })).toBeInTheDocument());

  fireEvent.change(screen.getByPlaceholderText(/e\.g\., Odometer Reading/i), {
    target: { value: "QA Release Select Template" },
  });

  const selectTrigger = screen.getByRole("combobox", { name: /Field Type/i });
  fireEvent.click(selectTrigger);
  fireEvent.click(await screen.findByText(/Dropdown\/Select/i));

  const optionsTab = await screen.findByRole("tab", { name: /Parent Options/i });
  fireEvent.click(optionsTab);
  const optionInput = await screen.findByPlaceholderText(/Type option and press Enter or Add/i);
  fireEvent.change(optionInput, { target: { value: "UID-001" } });
  fireEvent.keyDown(optionInput, { key: "Enter", code: "Enter" });
  await screen.findByDisplayValue("UID-001");

  const reviewTab = await screen.findByRole("tab", { name: /Review & Save/i });
  fireEvent.click(reviewTab);

  return screen.findByRole("button", { name: /^Create Template$/i });
}

describe("FormFieldTemplateEditorDialog — open-without-crashing regression", () => {
  it("Create Template (selectedTemplate=null) opens without throwing", () => {
    expect(() => render(<FormFieldTemplateEditorDialog {...baseProps()} />)).not.toThrow();
    expect(screen.getByRole("tab", { name: /Basics/i })).toBeInTheDocument();
  });

  it("Edit Template with an existing select-type template opens without throwing and reaches Parent Options", async () => {
    const template: TemplateRow = {
      id: "tmpl-1",
      organization_id: "org-1",
      name: "asd",
      field_type: "select",
      required: true,
      placeholder: null,
      default_value: null,
      help_text: null,
      validation_rules: null,
      options: ["sass", "bisss"],
      batch_entry_mode: null,
      updated_at: new Date().toISOString(),
    } as TemplateRow;

    expect(() =>
      render(<FormFieldTemplateEditorDialog {...baseProps({ selectedTemplate: template })} />),
    ).not.toThrow();

    await waitFor(() => expect(screen.getByRole("tab", { name: /Basics/i })).toBeInTheDocument());

    // Parent Options is a plain Tabs trigger (not a Radix Select) — reachable without
    // driving a portal-positioned dropdown. An EXISTING select template's Parent
    // Options tab is the server-paged section (DOC-097/DOC-099/DOC-100): a
    // debounced auto-search (no explicit Search button, matching main's live-
    // filter feel), no eager options[] download, but full feature parity with
    // main — bulk import, Matrix and presets are NOT disabled here (DOC-099
    // fixed the regression where they were). Radix Tabs' automatic activation
    // mode reacts to a real focus event, which fireEvent.click doesn't fire —
    // userEvent.click does (mousedown -> focus -> mouseup -> click), so it's
    // required here even though plain fireEvent.click works for most buttons.
    const user = userEvent.setup();
    const optionsTab = await screen.findByRole("tab", { name: /Parent Options/i });
    await user.click(optionsTab);
    await waitFor(() => expect(optionsTab).toHaveAttribute("data-state", "active"));
    expect(await screen.findByPlaceholderText(/Search parent options/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Paste \/ Import data/i })).toBeInTheDocument();
    expect(screen.getByText(/Add option/i)).toBeInTheDocument();
    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument();

    const dependentTab = await screen.findByRole("tab", { name: /Dependent Fields/i });
    await user.click(dependentTab);
    await waitFor(() => expect(dependentTab).toHaveAttribute("data-state", "active"));
    expect(await screen.findByRole("button", { name: /^List$/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^Matrix$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Import data$/i })).toBeInTheDocument();
    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument();
  });

  it("an existing select template auto-loads page 1 on open but never issues a supabase.from(...) options[]/branches query", async () => {
    const template: TemplateRow = {
      id: "tmpl-1",
      organization_id: "org-1",
      name: "asd",
      field_type: "select",
      required: true,
      placeholder: null,
      default_value: null,
      help_text: null,
      validation_rules: null,
      options: ["sass", "bisss"],
      batch_entry_mode: null,
      updated_at: new Date().toISOString(),
    } as TemplateRow;

    render(<FormFieldTemplateEditorDialog {...baseProps({ selectedTemplate: template })} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Basics/i })).toBeInTheDocument());

    fireEvent.click(await screen.findByRole("tab", { name: /Parent Options/i }));
    await waitFor(() => expect(summaryMock).toHaveBeenCalledWith("org-1", "tmpl-1"));

    // DOC-097 hotfix pt.3 Part 1: opening Parent Options now auto-loads page 1
    // (server-paged browse, query=null) exactly once instead of the old
    // "No search run yet" idle state -- guarded so it fires only once even
    // under React StrictMode's dev double-invoke.
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith("org-1", "tmpl-1", null, 1, 25, false));
    expect(searchMock).toHaveBeenCalledTimes(1);
  });
});

describe("FormFieldTemplateEditorDialog — Matrix cell editor deduplication regression", () => {
  it("saving duplicate/blank choices from the Matrix cell popover trims and case-insensitively dedupes them", async () => {
    // Matrix editing is only reachable on a brand-new (not-yet-created)
    // template — an existing select/checkbox template's Dependent Fields tab
    // is now the server-paged section, which does not offer Matrix (see
    // DOC-097 "Phase 2"). This still exercises the exact live MatrixCellEditor
    // code path; it's just built up here via the create-mode UI instead of a
    // pre-seeded existing-template branch draft.
    render(<FormFieldTemplateEditorDialog {...baseProps({ selectedTemplate: null })} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Basics/i })).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/e\.g\., Odometer Reading/i), {
      target: { value: "QA Matrix Regression" },
    });
    const selectTrigger = screen.getByRole("combobox", { name: /Field Type/i });
    fireEvent.click(selectTrigger);
    fireEvent.click(await screen.findByText(/Dropdown\/Select/i));

    const optionsTab = await screen.findByRole("tab", { name: /Parent Options/i });
    fireEvent.click(optionsTab);
    const optionInput = await screen.findByPlaceholderText(/Type option and press Enter or Add/i);
    fireEvent.change(optionInput, { target: { value: "sass" } });
    fireEvent.keyDown(optionInput, { key: "Enter", code: "Enter" });
    await screen.findByDisplayValue("sass");

    const dependentTab = await screen.findByRole("tab", { name: /Dependent Fields/i });
    fireEvent.click(dependentTab);
    fireEvent.click(await screen.findByText("sass"));
    fireEvent.click(await screen.findByText(/When "sass" is selected/i));
    fireEvent.click(await screen.findByRole("button", { name: /Add field/i }));

    // New draft defaults to field_type "text" with a blank name — set both so
    // the matrix treats it as a real, named, configured column.
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Travel mode/i), {
      target: { value: "Col1" },
    });
    const typeTrigger = screen.getByRole("combobox", { name: /^Type$/i });
    fireEvent.click(typeTrigger);
    fireEvent.click(await screen.findByText(/^Dropdown$/i));

    const choiceInput = await screen.findByPlaceholderText(/^Type option and press Enter$/i);
    fireEvent.change(choiceInput, { target: { value: "A" } });
    fireEvent.keyDown(choiceInput, { key: "Enter", code: "Enter" });

    const matrixButton = await screen.findByText(/^Matrix$/i);
    fireEvent.click(matrixButton);

    // The matrix cell exposes its state via a `title` attribute, not
    // accessible text (the visible text is just the choice count).
    const cell = await screen.findByTitle("Configured (1 choice)");
    fireEvent.click(cell);

    const textarea = await waitFor(() => {
      const el = Array.from(document.querySelectorAll("textarea")).find(
        (t) => t.getAttribute("placeholder") === "Option A\nOption B\nOption C",
      );
      if (!el) throw new Error("matrix cell textarea not found");
      return el;
    });
    fireEvent.change(textarea, { target: { value: "A\nA\n a \n\nB" } });

    const saveButton = screen.getByRole("button", { name: /^Save$/i });
    fireEvent.click(saveButton);

    // Deduped case-insensitively + blank line dropped: "A" and "B" survive as 2 choices, not 4.
    expect(await screen.findByTitle("Configured (2 choices)")).toBeInTheDocument();
  });
});

describe("FormFieldTemplateEditorDialog — preset 'Save as set' disabled before the template is persisted", () => {
  it("disables Save as set (with an explanatory tooltip) for a not-yet-created template, instead of silently no-opping", async () => {
    // selectedTemplate=null is Create Template mode: expense_form_field_branch_presets rows
    // require a real parent_template_id FK, so a save attempt here can never succeed. Manual QA
    // found the button was previously enabled anyway, and clicking it closed the popover with no
    // error while nothing was persisted — a silent no-op. The button must now be disabled.
    render(<FormFieldTemplateEditorDialog {...baseProps({ selectedTemplate: null })} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Basics/i })).toBeInTheDocument());

    const selectTrigger = screen.getByRole("combobox", { name: /Field Type/i });
    fireEvent.click(selectTrigger);
    fireEvent.click(await screen.findByText(/Dropdown\/Select/i));

    const optionsTab = await screen.findByRole("tab", { name: /Parent Options/i });
    fireEvent.click(optionsTab);
    const optionInput = await screen.findByPlaceholderText(/Type option and press Enter or Add/i);
    fireEvent.change(optionInput, { target: { value: "opt1" } });
    fireEvent.keyDown(optionInput, { key: "Enter", code: "Enter" });
    await screen.findByDisplayValue("opt1");

    const dependentTab = await screen.findByRole("tab", { name: /Dependent Fields/i });
    fireEvent.click(dependentTab);
    fireEvent.click(await screen.findByText("opt1"));

    // The "When ... is selected" section starts collapsed when the option has 0 fields yet.
    fireEvent.click(await screen.findByText(/When "opt1" is selected/i));
    const addFieldButton = await screen.findByRole("button", { name: /Add field/i });
    fireEvent.click(addFieldButton);

    const saveAsSetButton = await screen.findByRole("button", { name: /Save as set/i });
    expect(saveAsSetButton).toBeDisabled();
    expect(saveAsSetButton).toHaveAttribute(
      "title",
      expect.stringMatching(/save the template first/i),
    );
  });
});

describe("FormFieldTemplateEditorDialog — new-template create sends a non-null batch_entry_mode", () => {
  it("inserts batch_entry_mode: \"per_line\" (never null) for a brand-new template whose toggle was never touched", async () => {
    // Live QA reproduced a deterministic HTTP 400 creating ANY new template — even a plain
    // text field with zero parent options/branches — because the live
    // expense_form_field_templates.batch_entry_mode column is NOT NULL, while a freshly
    // opened editor's batchEntryMode state defaults to null (documented as "legacy default,
    // falls back to the per-assignment ask_once_per_batch flag" — a fallback that's meaningless
    // for a template with zero existing category assignments). Postgres rejected the insert
    // with code 23502 (not_null_violation) before save_option_branch_configuration_atomically
    // was ever reached.
    insertSpy.mockClear();
    render(<FormFieldTemplateEditorDialog {...baseProps({ selectedTemplate: null })} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Basics/i })).toBeInTheDocument());

    const nameInput = screen.getByPlaceholderText(/e\.g\., Odometer Reading/i);
    fireEvent.change(nameInput, { target: { value: "QA Regression Field" } });

    const reviewTab = await screen.findByRole("tab", { name: /Review & Save/i });
    fireEvent.click(reviewTab);

    const createButton = await screen.findByRole("button", { name: /^Create Template$/i });
    fireEvent.click(createButton);

    await waitFor(() => expect(insertSpy).toHaveBeenCalled());
    const payload = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.batch_entry_mode).toBe("per_line");
    expect(payload.batch_entry_mode).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Release-readiness save-contract suite. These pin down the exact
// saveOptionBranchConfigurationAtomically contract (expectedUpdatedAt
// null-vs-real per insert/update path) and the orphan-safety behavior added
// for the case where a new template's row commits but its branch RPC then
// fails — see FormFieldTemplateEditorDialog.tsx handleSave.
// ─────────────────────────────────────────────────────────────────────────────

describe("FormFieldTemplateEditorDialog — save-contract regression suite (release readiness)", () => {
  it("NEW SIMPLE TEXT TEMPLATE: batch_entry_mode is never null on insert, and no branch RPC or cleanup ever runs", async () => {
    render(<FormFieldTemplateEditorDialog {...baseProps({ selectedTemplate: null })} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Basics/i })).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/e\.g\., Odometer Reading/i), {
      target: { value: "QA Release Text Template" },
    });
    fireEvent.click(await screen.findByRole("tab", { name: /Review & Save/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Create Template$/i }));

    await waitFor(() => expect(insertSpy).toHaveBeenCalled());
    const payload = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.batch_entry_mode).toBe("per_line");
    expect(saveBranchesMock).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("NEW SELECT TEMPLATE WITH BRANCHES: calls the branch RPC with expectedUpdatedAt (3rd arg) = null", async () => {
    const createButton = await setupNewSelectTemplateReadyToSave();
    fireEvent.click(createButton);

    await waitFor(() => expect(saveBranchesMock).toHaveBeenCalled());
    const args = saveBranchesMock.mock.calls[0];
    expect(args[0]).toBe("org-1");
    expect(args[1]).toBe("new-tmpl-1");
    expect(args[2]).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("EXISTING SELECT TEMPLATE: Update Template no longer calls the V1 branch RPC, and never sends `options` in the metadata update", async () => {
    // Superseded by the option-scoped save architecture (DOC-097 "Phase 2"):
    // an existing select/checkbox template's branches are saved per-option,
    // independently, from ServerPagedParentOptionsSection — never as part of
    // this dialog's own "Update Template" button, and `options` must never
    // be included in that button's metadata-only update (the local `options`
    // array is never loaded for this template, so sending it would silently
    // wipe the real column).
    const template: TemplateRow = {
      id: "tmpl-1",
      organization_id: "org-1",
      name: "asd",
      field_type: "select",
      required: true,
      placeholder: null,
      default_value: null,
      help_text: null,
      validation_rules: null,
      options: ["sass"],
      batch_entry_mode: "per_line",
      updated_at: "2026-05-01T12:00:00Z",
    } as TemplateRow;

    render(<FormFieldTemplateEditorDialog {...baseProps({ selectedTemplate: template })} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Basics/i })).toBeInTheDocument());
    fireEvent.click(await screen.findByRole("tab", { name: /Review & Save/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Update Template$/i }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    expect(saveBranchesMock).not.toHaveBeenCalled();
    const payload = updateSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("options");
    expect(payload.name).toBe("asd");
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("CREATE FAILURE: template insert failing means the branch RPC never runs, no success toast fires, onSaved never runs", async () => {
    mockState.insertShouldFail = true;
    const onSaved = vi.fn();
    const createButton = await setupNewSelectTemplateReadyToSave({ onSaved });
    fireEvent.click(createButton);

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(saveBranchesMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    const titles = toastSpy.mock.calls.map((c) => (c[0] as { title?: string })?.title ?? "");
    expect(titles.some((t) => /created/i.test(t))).toBe(false);
  });

  it("BRANCH RPC FAILURE AFTER INSERT: compensating cleanup deletes exactly the new template (scoped by id + org) and surfaces the original branch error", async () => {
    saveBranchesMock.mockRejectedValueOnce(new Error("branch save exploded"));
    const onSaved = vi.fn();
    const createButton = await setupNewSelectTemplateReadyToSave({ onSaved });
    fireEvent.click(createButton);

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(1));
    expect(deleteEqSpy).toHaveBeenCalledWith("id", "new-tmpl-1");
    expect(deleteEqSpy).toHaveBeenCalledWith("organization_id", "org-1");
    expect(onSaved).not.toHaveBeenCalled();

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const descriptions = toastSpy.mock.calls.map((c) => (c[0] as { description?: string })?.description ?? "");
    expect(descriptions.some((d) => /branch save exploded/.test(d))).toBe(true);
  });

  it("BRANCH RPC FAILURE + CLEANUP ALSO FAILS: surfaces a distinct admin diagnostic instead of silently losing the orphan", async () => {
    saveBranchesMock.mockRejectedValueOnce(new Error("branch save exploded"));
    mockState.deleteShouldFail = true;
    const onSaved = vi.fn();
    const createButton = await setupNewSelectTemplateReadyToSave({ onSaved });
    fireEvent.click(createButton);

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(1));
    expect(onSaved).not.toHaveBeenCalled();

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const descriptions = toastSpy.mock.calls.map((c) => (c[0] as { description?: string })?.description ?? "");
    expect(descriptions.some((d) => /administrator should check Form Field Templates/.test(d))).toBe(true);
    expect(descriptions.some((d) => /branch save exploded/.test(d))).toBe(true);
  });

  it("EXISTING TEMPLATE: a per-option save failure (server-paged section) never triggers template-row cleanup deletion", async () => {
    searchMock.mockResolvedValue({
      results: [{ optionValue: "sass", displayIndex: 0, activeRootBranchCount: 0, activeTotalBranchCount: 0, configured: false, integrityStatus: "not_applicable" }],
      page: 1, pageSize: 25, totalResults: 1, totalPages: 1, hasPrevious: false, hasNext: false,
    });
    getConfigMock.mockResolvedValue({ parentOptionValue: "sass", drafts: [], configurationFingerprint: "fp-1" });
    saveOptionMock.mockRejectedValue(new Error("stale_option_configuration: modified elsewhere"));

    const template: TemplateRow = {
      id: "tmpl-1",
      organization_id: "org-1",
      name: "asd",
      field_type: "select",
      required: true,
      placeholder: null,
      default_value: null,
      help_text: null,
      validation_rules: null,
      options: ["sass"],
      batch_entry_mode: "per_line",
      updated_at: "2026-05-01T12:00:00Z",
    } as TemplateRow;

    render(<FormFieldTemplateEditorDialog {...baseProps({ selectedTemplate: template })} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Basics/i })).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /Dependent Fields/i }));
    await user.click(await screen.findByRole("button", { name: "sass" }));
    await waitFor(() => expect(getConfigMock).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: /^Save "sass"$/i }));

    await waitFor(() => expect(saveOptionMock).toHaveBeenCalled());
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled(); // Basics ("Update Template") was never touched by this action either
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Server-paged Parent Options / Dependent Fields integration (DOC-097 "Phase 2").
// The real dialog now routes an EXISTING select/checkbox template through the
// V2 RPCs; these pin down the option-save isolation, client-side pre-checks,
// and the Add option flow.
// ─────────────────────────────────────────────────────────────────────────────

describe("FormFieldTemplateEditorDialog — server-paged Parent Options integration", () => {
  const existingSelectTemplate: TemplateRow = {
    id: "tmpl-1",
    organization_id: "org-1",
    name: "Project Unique ID",
    field_type: "select",
    required: true,
    placeholder: null,
    default_value: null,
    help_text: null,
    validation_rules: null,
    options: ["202608M447"],
    batch_entry_mode: "per_line",
    updated_at: "2026-05-01T12:00:00Z",
  } as TemplateRow;

  it("opening M447 fetches only M447, and Save calls the option-scoped RPC — never V1", async () => {
    searchMock.mockResolvedValue({
      results: [{ optionValue: "202608M447", displayIndex: 0, activeRootBranchCount: 1, activeTotalBranchCount: 1, configured: true, integrityStatus: "not_applicable" }],
      page: 1, pageSize: 25, totalResults: 1, totalPages: 1, hasPrevious: false, hasNext: false,
    });
    getConfigMock.mockResolvedValue({
      parentOptionValue: "202608M447",
      drafts: [{ localId: "l1", dbId: "db-1", parent_option_value: "202608M447", parent_branch_local_id: null, field_key: "project_id", name: "Project ID", field_type: "text", required: true, placeholder: "", help_text: "", options: [], display_order: 0 }],
      configurationFingerprint: "fp-447",
    });
    saveOptionMock.mockResolvedValue({ ok: true, revisionId: "rev-1", parentOptionValue: "202608M447", branchesInserted: 0, branchesUpdated: 1, branchesRetired: 0 });

    render(<FormFieldTemplateEditorDialog {...baseProps({ selectedTemplate: existingSelectTemplate })} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Basics/i })).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /Dependent Fields/i }));
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith("org-1", "tmpl-1", null, 1, 25, false));

    // The sidebar row's accessible name includes the trailing dependent-field
    // count badge ("202608M447 1"), so match by prefix, not an exact string.
    await user.click(await screen.findByRole("button", { name: /^202608M447/ }));
    await waitFor(() => expect(getConfigMock).toHaveBeenCalledWith("org-1", "tmpl-1", "202608M447"));

    fireEvent.click(await screen.findByRole("button", { name: /^Save "202608M447"$/i }));
    await waitFor(() => expect(saveOptionMock).toHaveBeenCalled());
    expect(saveOptionMock.mock.calls[0][0]).toBe("org-1");
    expect(saveOptionMock.mock.calls[0][1]).toBe("tmpl-1");
    expect(saveOptionMock.mock.calls[0][2]).toBe("202608M447");
    expect(saveBranchesMock).not.toHaveBeenCalled(); // V1 whole-template RPC never runs
  });

  it("Add option calls createFormTemplateParentOption and re-runs the current search — never the old local array", async () => {
    searchMock.mockResolvedValue({
      results: [],
      page: 1, pageSize: 25, totalResults: 0, totalPages: 1, hasPrevious: false, hasNext: false,
    });
    createOptionMock.mockResolvedValue({ ok: true, optionValue: "202608M999", displayIndex: 502, parentOptionCount: 502 });

    render(<FormFieldTemplateEditorDialog {...baseProps({ selectedTemplate: existingSelectTemplate })} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Basics/i })).toBeInTheDocument());
    fireEvent.click(await screen.findByRole("tab", { name: /Parent Options/i }));

    const addInput = await screen.findByPlaceholderText(/Type option and press Enter or Add/i);
    fireEvent.change(addInput, { target: { value: "202608M999" } });
    fireEvent.click(await screen.findByRole("button", { name: /Add option/i }));

    await waitFor(() => expect(createOptionMock).toHaveBeenCalledWith("org-1", "tmpl-1", "202608M999"));
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("a duplicate effective root field_key inside one option blocks Save client-side, with zero RPC calls", async () => {
    searchMock.mockResolvedValue({
      results: [{ optionValue: "sass", displayIndex: 0, activeRootBranchCount: 2, activeTotalBranchCount: 2, configured: true, integrityStatus: "not_applicable" }],
      page: 1, pageSize: 25, totalResults: 1, totalPages: 1, hasPrevious: false, hasNext: false,
    });
    getConfigMock.mockResolvedValue({
      parentOptionValue: "sass",
      drafts: [
        { localId: "l1", dbId: "db-1", parent_option_value: "sass", parent_branch_local_id: null, field_key: "dup", name: "First", field_type: "text", required: false, placeholder: "", help_text: "", options: [], display_order: 0 },
        { localId: "l2", dbId: "db-2", parent_option_value: "sass", parent_branch_local_id: null, field_key: "dup", name: "Second", field_type: "text", required: false, placeholder: "", help_text: "", options: [], display_order: 1 },
      ],
      configurationFingerprint: "fp-1",
    });

    const template: TemplateRow = { ...existingSelectTemplate, options: ["sass"] };
    render(<FormFieldTemplateEditorDialog {...baseProps({ selectedTemplate: template })} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Basics/i })).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /Dependent Fields/i }));
    // The sidebar row's accessible name includes the trailing dependent-field
    // count badge ("sass 2"), so match by prefix, not an exact string.
    await user.click(await screen.findByRole("button", { name: /^sass/ }));
    await waitFor(() => expect(getConfigMock).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: /^Save "sass"$/i }));

    await screen.findByText(/already contains a "dup" field/i);
    expect(saveOptionMock).not.toHaveBeenCalled();
  });
});
