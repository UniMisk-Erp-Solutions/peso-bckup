/**
 * Expense date locking -- "show the reason" UX pass (2026-10-01), proven on
 * the real ExpenseBatchForm page for its shared trip date. ExpenseForm's
 * identical behavior has its own, more extensive suite
 * (`ExpenseFormDateLockGating.test.tsx`); this file only proves the ONE
 * thing specific to the batch form: the admin's lock reason is shown for
 * the shared date, through the real page, not just the shared
 * `getExpenseDateLockMessage` helper (already unit-tested on its own in
 * `src/lib/__tests__/expenseDateLocks.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import ExpenseBatchForm from "@/pages/ExpenseBatchForm";
import { useAuth } from "@/contexts/AuthContext";
import { useExpenseDateLocks } from "@/hooks/useExpenseDateLocks";
import { invalidateOrgSettings } from "@/lib/orgSettingsCache";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";

const ORG_ID = "org-batch-date-lock-1";
const USER_ID = "user-batch-date-lock-1";

vi.mock("@/hooks/useExpenseDateLocks", () => ({
  useExpenseDateLocks: vi.fn(),
}));

vi.mock("@/hooks/useBatchExpenseEntry", () => ({
  useBatchExpenseEntry: () => ({ batchExpenseEntryEnabled: true, batchEntryLoading: false }),
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
  const rowsFor = (): Record<string, unknown>[] => {
    switch (table) {
      case "organization_settings":
        return [ORG_SETTINGS_ROW];
      default:
        return [];
    }
  };
  const builder: Record<string, unknown> = {
    select() {
      return builder;
    },
    eq() {
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
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

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  invalidateOrgSettings(ORG_ID);
  mockAuthenticatedUser();
});

describe("ExpenseBatchForm -- shared trip date shows the admin's lock reason", () => {
  it("shows the admin's reason text for the shared date once a lock covering it is loaded", async () => {
    const todayLock = (() => {
      const today = new Date();
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, "0");
      const d = String(today.getDate()).padStart(2, "0");
      const todayStr = `${y}-${m}-${d}`;
      return {
        id: "lock-batch-today",
        organization_id: ORG_ID,
        date_from: todayStr,
        date_to: todayStr,
        reason: "Year-end closing in progress.",
        is_active: true,
        created_by: "admin-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    })();
    vi.mocked(useExpenseDateLocks).mockReturnValue({
      locks: [todayLock],
      loading: false,
      error: null,
      enabled: true,
      reload: vi.fn(),
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/expenses/batch/new"]}>
          <ExpenseBatchForm />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText(/year-end closing in progress\./i);
  });
});
