import { describe, expect, it, beforeEach } from "vitest";
import {
  isExpenseFormDraftMeaningful,
  loadExpenseFormDraft,
  saveExpenseFormDraft,
  clearExpenseFormDraft,
  markExpenseFormDraftSubmitted,
  hasPendingExpenseFormDraft,
  draftStorageKey,
} from "@/lib/expenseFormDraft";

const USER = "user-1";
const ORG = "org-1";

const emptyPayload = () => ({
  expense: {
    title: "",
    destination: "",
    expense_date: new Date().toISOString(),
    purpose: "",
    amount: 0,
    category: "other",
  },
  formFieldValues: {},
  branchValues: {},
  attachments: [],
  sessionTempFilenames: [],
  sessionTempMeta: [],
});

describe("expenseFormDraft", () => {
  beforeEach(() => {
    clearExpenseFormDraft(USER, ORG, "new");
    localStorage.clear();
    sessionStorage.clear();
  });

  it("detects meaningful drafts", () => {
    expect(isExpenseFormDraftMeaningful(emptyPayload())).toBe(false);
    expect(
      isExpenseFormDraftMeaningful({
        ...emptyPayload(),
        expense: { ...emptyPayload().expense, title: "Trip" },
      }),
    ).toBe(true);
  });

  it("does not overwrite a meaningful draft with an empty autosave", () => {
    saveExpenseFormDraft(USER, ORG, {
      ...emptyPayload(),
      expense: { ...emptyPayload().expense, title: "Saved title", amount: 100 },
    }, "new");

    saveExpenseFormDraft(USER, ORG, emptyPayload(), "new");

    const restored = loadExpenseFormDraft(USER, ORG, "new");
    expect(restored?.expense.title).toBe("Saved title");
    expect(restored?.pendingSubmit).toBe(true);
  });

  it("keeps draft in memory when disk keys are cleared until submit", () => {
    saveExpenseFormDraft(
      USER,
      ORG,
      {
        ...emptyPayload(),
        expense: { ...emptyPayload().expense, title: "Pending", amount: 50 },
      },
      "new",
      { force: true },
    );
    expect(hasPendingExpenseFormDraft(USER, ORG, "new")).toBe(true);

    const key = draftStorageKey(USER, ORG, "new");
    localStorage.removeItem(key);
    localStorage.removeItem(`${key}:backup`);
    expect(loadExpenseFormDraft(USER, ORG, "new")?.expense.title).toBe("Pending");

    markExpenseFormDraftSubmitted(USER, ORG, "new");
    expect(hasPendingExpenseFormDraft(USER, ORG, "new")).toBe(false);
    expect(loadExpenseFormDraft(USER, ORG, "new")).toBeFalsy();
  });

  it("writes backup copy to localStorage", () => {
    saveExpenseFormDraft(
      USER,
      ORG,
      {
        ...emptyPayload(),
        expense: { ...emptyPayload().expense, title: "Backed up", amount: 10 },
      },
      "new",
      { force: true },
    );
    const backupKey = `${draftStorageKey(USER, ORG, "new")}:backup`;
    const raw = localStorage.getItem(backupKey);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).expense.title).toBe("Backed up");
  });
});
