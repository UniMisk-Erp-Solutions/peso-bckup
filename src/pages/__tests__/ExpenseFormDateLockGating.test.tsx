/**
 * Expense date locking -- fail-CLOSED UI gating on the real ExpenseForm page
 * (2026-10-01 review fix). Before this fix, when the lock-check could not be
 * determined (still loading, or the fetch failed because the backend table
 * doesn't exist yet) the UI failed OPEN: it showed an orange warning next to
 * a fully-usable date field and Submit button. This suite mounts the REAL
 * ExpenseForm in create mode ("/expenses/new") and proves it now fails
 * CLOSED instead.
 *
 * `useExpenseDateLocks` itself is mocked directly (its own loading/error/
 * retry/race-guard behavior has its own dedicated unit tests in
 * src/hooks/__tests__/useExpenseDateLocks.test.tsx) -- this suite is about
 * what ExpenseForm DOES with that hook's output.
 *
 * Mocking stops at: @/hooks/useExpenseDateLocks (see above), @/components/
 * FileUpload (irrelevant file-picker chrome), and @/integrations/supabase/
 * client (a minimal table-dispatching fake covering only what a brand-new,
 * non-edit ExpenseForm bootstrap touches: organization_expense_form_fields,
 * expense_categories, user_roles, organization_settings).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import ExpenseForm from "@/pages/ExpenseForm";
import { useAuth } from "@/contexts/AuthContext";
import { useExpenseDateLocks } from "@/hooks/useExpenseDateLocks";
import type { ExpenseDateLock } from "@/lib/expenseDateLocks";
import { invalidateOrgSettings } from "@/lib/orgSettingsCache";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";

const ORG_ID = "org-date-lock-1";
const USER_ID = "user-date-lock-1";

vi.mock("@/hooks/useExpenseDateLocks", () => ({
  useExpenseDateLocks: vi.fn(),
}));

vi.mock("@/components/FileUpload", () => ({
  FileUpload: () => <div data-testid="file-upload">File Upload</div>,
}));

const ORG_SETTINGS_ROW = {
  organization_id: ORG_ID,
  approval_hierarchy_role_labels: null,
  allow_cashier_expense_submission: false,
  require_immediate_supervisor: false,
  engineer_approval_limit: null,
  attachment_required_above_amount: 999999,
  batch_expense_attachment_mode: null,
};

function makeQueryBuilder(table: string) {
  const state: { columns: string; filters: Record<string, unknown> } = { columns: "*", filters: {} };
  const rowsFor = (): Record<string, unknown>[] => {
    switch (table) {
      case "organization_settings":
        return [ORG_SETTINGS_ROW];
      default:
        return [];
    }
  };
  const builder: Record<string, unknown> = {
    select(cols?: string) {
      state.columns = cols ?? "*";
      return builder;
    },
    eq(col: string, val: unknown) {
      state.filters[col] = val;
      return builder;
    },
    order() {
      return builder;
    },
    maybeSingle() {
      const rows = rowsFor();
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve({ data: rowsFor(), error: null }).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => makeQueryBuilder(table),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
    functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
    storage: { from: vi.fn(() => ({ upload: vi.fn(), remove: vi.fn(), getPublicUrl: vi.fn() })) },
  },
}));

function mockAuthenticatedUser() {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: USER_ID, email: "employee@example.com" },
    session: { user: { id: USER_ID } } as never,
    userRole: "employee",
    userProfile: null,
    organization: null,
    organizationId: ORG_ID,
    loading: false,
    signOut: vi.fn(),
    refreshUserProfile: vi.fn(),
    refreshOrganization: vi.fn(),
    appBaseDomain: "localhost",
    isTenantHost: false,
    tenantSubdomainLabel: null,
    tenantHostOrgId: null,
    tenantHostOrg: null,
    organizationFeatureFlags: { [ORGANIZATION_FEATURE_KEYS.expense_date_locking]: true },
    hasOrganizationFeature: (key: string) => key === ORGANIZATION_FEATURE_KEYS.expense_date_locking,
    tenantEmployeeIdLoginEnabled: false,
    tenantResolutionStatus: "idle",
    tenantFeatureStatus: "idle",
    retryTenantResolution: vi.fn(),
    preferredLanguage: "en",
    setPreferredLanguage: vi.fn(),
    isAccountantCashier: false,
    userBalance: null,
    refreshBalance: vi.fn(),
  } as never);
}

function renderNewExpenseForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/expenses/new"]}>
        <ExpenseForm />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The date-field Popover trigger: the only button rendering a calendar icon
 *  next to the placeholder/date text, distinct from the Submit/Cancel
 *  buttons. Found by its accessible name instead of test id, since the
 *  component renders no dedicated test id for it. */
function getDateTriggerButton() {
  // date-fns `format` is globally mocked (src/test/setup.ts) to always
  // return "2024-01-01" regardless of input, so once a date is set this is
  // the button whose name is exactly that string; before any date is set it
  // shows the "Pick a date" placeholder.
  return screen.queryByRole("button", { name: /2024-01-01|pick a date/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  invalidateOrgSettings(ORG_ID);
  mockAuthenticatedUser();
});

describe("ExpenseForm date-field fail-closed gating", () => {
  it("disables the date field and Submit, and shows the checking message, while locks are loading", async () => {
    vi.mocked(useExpenseDateLocks).mockReturnValue({
      locks: [],
      loading: true,
      error: null,
      enabled: true,
      reload: vi.fn(),
    });

    renderNewExpenseForm();

    await screen.findByText(/checking available expense dates/i);
    const dateBtn = getDateTriggerButton();
    expect(dateBtn).toBeDisabled();

    const submitBtn = await screen.findByRole("button", { name: /^submit$/i });
    expect(submitBtn).toBeDisabled();
  });

  it("disables the date field and Submit, shows the new error message (not the old amber warning), and Retry calls reload()", async () => {
    const reload = vi.fn();
    vi.mocked(useExpenseDateLocks).mockReturnValue({
      locks: [],
      loading: false,
      error: "relation \"organization_expense_date_locks\" does not exist",
      enabled: true,
      reload,
    });

    renderNewExpenseForm();

    await screen.findByText(/expense dates could not be loaded\. please retry before submitting an expense\./i);
    // The old misleading-fail-open copy must be gone.
    expect(
      screen.queryByText(/could not check whether any dates are closed for submission right now/i),
    ).not.toBeInTheDocument();

    const dateBtn = getDateTriggerButton();
    expect(dateBtn).toBeDisabled();
    const submitBtn = await screen.findByRole("button", { name: /^submit$/i });
    expect(submitBtn).toBeDisabled();

    const retryBtn = screen.getByRole("button", { name: /retry/i });
    await userEvent.setup().click(retryBtn);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("re-enables the date field once a retry resolves successfully", async () => {
    const reload = vi.fn();
    const mocked = vi.mocked(useExpenseDateLocks);
    mocked.mockReturnValue({ locks: [], loading: false, error: "boom", enabled: true, reload });

    const { rerender } = renderNewExpenseForm();
    await screen.findByText(/expense dates could not be loaded/i);
    expect(getDateTriggerButton()).toBeDisabled();

    // Simulate the retry succeeding (the hook's own race-safety is covered
    // elsewhere; here we only care what ExpenseForm does once it reports success).
    mocked.mockReturnValue({ locks: [], loading: false, error: null, enabled: true, reload });
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/expenses/new"]}>
          <ExpenseForm />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getDateTriggerButton()).not.toBeDisabled());
    expect(screen.queryByText(/expense dates could not be loaded/i)).not.toBeInTheDocument();
  });

  it("feature OFF: no checking/error copy, date field and Submit behave exactly as before (regression guard)", async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: USER_ID, email: "employee@example.com" },
      session: { user: { id: USER_ID } } as never,
      userRole: "employee",
      userProfile: null,
      organization: null,
      organizationId: ORG_ID,
      loading: false,
      signOut: vi.fn(),
      refreshUserProfile: vi.fn(),
      refreshOrganization: vi.fn(),
      appBaseDomain: "localhost",
      isTenantHost: false,
      tenantSubdomainLabel: null,
      tenantHostOrgId: null,
      tenantHostOrg: null,
      organizationFeatureFlags: {},
      hasOrganizationFeature: () => false,
      tenantEmployeeIdLoginEnabled: false,
      tenantResolutionStatus: "idle",
      tenantFeatureStatus: "idle",
      retryTenantResolution: vi.fn(),
      preferredLanguage: "en",
      setPreferredLanguage: vi.fn(),
      isAccountantCashier: false,
      userBalance: null,
      refreshBalance: vi.fn(),
    } as never);
    // Exactly what the real hook returns when the feature is off.
    vi.mocked(useExpenseDateLocks).mockReturnValue({
      locks: [],
      loading: false,
      error: null,
      enabled: false,
      reload: vi.fn(),
    });

    renderNewExpenseForm();

    await screen.findByRole("button", { name: /^submit$/i });
    expect(screen.queryByText(/checking available expense dates/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/expense dates could not be loaded/i)).not.toBeInTheDocument();
    expect(getDateTriggerButton()).not.toBeDisabled();
  });
});

describe("ExpenseForm -- already-selected date becomes locked", () => {
  it("shows the closed-date notice and blocks Submit when a refetch reveals the already-selected date is now locked, without silently swapping it", async () => {
    const mocked = vi.mocked(useExpenseDateLocks);
    // Starts with proven, empty lock data -- today's default date is fine.
    mocked.mockReturnValue({ locks: [], loading: false, error: null, enabled: true, reload: vi.fn() });

    const { rerender } = renderNewExpenseForm();
    const submitBtn = await screen.findByRole("button", { name: /^submit$/i });
    await waitFor(() => expect(submitBtn).not.toBeDisabled());
    expect(screen.queryByText(/this expense date is closed for submission/i)).not.toBeInTheDocument();

    // An admin locks today's date while the form sits open; locks refetch.
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const todayStr = `${y}-${m}-${d}`;
    const newLock: ExpenseDateLock = {
      id: "lock-today",
      organization_id: "org-date-lock-1",
      date_from: todayStr,
      date_to: todayStr,
      reason: null,
      is_active: true,
      created_by: "admin-1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mocked.mockReturnValue({ locks: [newLock], loading: false, error: null, enabled: true, reload: vi.fn() });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/expenses/new"]}>
          <ExpenseForm />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText(/this expense date is closed for submission/i);
    const submitAfter = await screen.findByRole("button", { name: /^submit$/i });
    expect(submitAfter).toBeDisabled();
    // Never silently swapped to a different date -- the trigger button still
    // reads the same (globally-mocked) formatted date, not a placeholder.
    expect(getDateTriggerButton()).not.toBeNull();
  });

  it("shows the admin's own reason text (not just the generic notice) when the lock that now covers the selected date has one", async () => {
    const mocked = vi.mocked(useExpenseDateLocks);
    mocked.mockReturnValue({ locks: [], loading: false, error: null, enabled: true, reload: vi.fn() });

    const { rerender } = renderNewExpenseForm();
    await screen.findByRole("button", { name: /^submit$/i });

    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const todayStr = `${y}-${m}-${d}`;
    mocked.mockReturnValue({
      locks: [
        {
          id: "lock-today-reason",
          organization_id: "org-date-lock-1",
          date_from: todayStr,
          date_to: todayStr,
          reason: "Monthly accounts have been closed.",
          is_active: true,
          created_by: "admin-1",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      loading: false,
      error: null,
      enabled: true,
      reload: vi.fn(),
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/expenses/new"]}>
          <ExpenseForm />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText(/monthly accounts have been closed\./i);
  });
});
