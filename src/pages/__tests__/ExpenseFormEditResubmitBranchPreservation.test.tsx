/**
 * Regression test for the production data-integrity incident (2026-09):
 * editing/resubmitting an expense with a cascading custom-field group
 * ("Project Unique ID" -> dependent "Project ID"/"Project Name" fields)
 * used to silently WIPE the already-saved Project ID/Project Name values on
 * save, because ExpenseForm.tsx's edit bootstrap called
 * fetchCategoryFormFields(category) BEFORE loading the expense's saved
 * template values -- so its own preserveFormValues branch-definition-prefetch
 * path never had anything to prefetch, leaving optionBranches permanently
 * empty for that render.
 *
 * This test mounts the REAL ExpenseForm page (via a real react-router
 * MemoryRouter, on the real "/expenses/:id/edit" route) in edit mode for a
 * rejected expense, with a realistic Supabase mock, and drives the actual
 * edit -> resubmit journey end to end:
 *   1. mount -> assert branch DEFINITIONS are prefetched (the fix)
 *   2. assert the previously-saved values are shown in the rendered form
 *   3. click Resubmit -> assert the saved payload still carries every value
 *
 * Mocking stops at three boundaries:
 *   - @/lib/runtimeOptionBranches (the network edge for on-demand branch
 *     definitions) -- the real useOnDemandOptionBranches hook runs unmocked,
 *     so its "isResolvedFor" state machine is exercised for real.
 *   - @/services/ExpenseService.loadBranchFieldValuesForExpense (the one
 *     static method that loads previously-saved branch VALUES) -- every
 *     other ExpenseService method (updateExpense, submitExpense,
 *     replaceExpenseFormFieldValues, and their internal `this.`-called
 *     helpers) runs for REAL against the fake Supabase client below. Grepping
 *     src/services/ExpenseService.ts confirms none of updateExpense,
 *     submitExpense, or replaceExpenseFormFieldValues reference
 *     loadBranchFieldValuesForExpense internally, so partial-mocking the
 *     class via a spread is safe here.
 *   - @/integrations/supabase/client -- a table-dispatching fake standing in
 *     for Postgres, covering every table/RPC touched by the real edit-mode
 *     bootstrap and the real resubmit path (expenses, expense_categories,
 *     expense_category_form_fields, expense_form_field_values, attachments,
 *     organization_settings, organization_memberships, organization_features,
 *     profiles, audit_logs, and the replace_expense_form_field_values RPC).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

import ExpenseForm from "@/pages/ExpenseForm";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { ExpenseService } from "@/services/ExpenseService";
import { fetchRuntimeOptionBranches } from "@/lib/runtimeOptionBranches";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { invalidateOrgSettings } from "@/lib/orgSettingsCache";

// ── shared fixture ids (vi.hoisted so vi.mock factories below, which are
// hoisted above these imports by Vitest, can reference them safely) ─────────
const {
  ORG_ID,
  USER_ID,
  EXPENSE_ID,
  CATEGORY_ID,
  CATEGORY_NAME,
  PROJECT_UID_TEMPLATE_ID,
  PROJECT_ID_BRANCH_ID,
  PROJECT_NAME_BRANCH_ID,
  ASSIGNMENT_ID,
  EXPENSE_TITLE,
} = vi.hoisted(() => ({
  ORG_ID: "org-11111111-1111-1111-1111-111111111111",
  USER_ID: "user-22222222-2222-2222-2222-222222222222",
  EXPENSE_ID: "expense-33333333-3333-3333-3333-333333333333",
  CATEGORY_ID: "cat-1",
  CATEGORY_NAME: "Travel",
  PROJECT_UID_TEMPLATE_ID: "tmpl-project-unique-id",
  PROJECT_ID_BRANCH_ID: "branch-project-id",
  PROJECT_NAME_BRANCH_ID: "branch-project-name",
  ASSIGNMENT_ID: "assign-1",
  EXPENSE_TITLE: "Site visit — CCTV work",
}));

// Restore the REAL react-router-dom for this suite. src/test/setup.ts mocks
// useParams globally as () => ({}), which would break useParams() -> {id}
// on the real edit route. A file-level vi.mock outranks the setup-file one.
// (Same pattern as src/features/reviewExpensesServer/__tests__/reviewReturnStateRoundTrip.test.tsx.)
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
}));

vi.mock("@/components/FileUpload", () => ({
  FileUpload: () => <div data-testid="file-upload">File Upload</div>,
}));

// The network edge for on-demand branch DEFINITIONS. The real
// useOnDemandOptionBranches hook (and its isResolvedFor state machine) runs
// unmocked -- only this fetch is stubbed.
vi.mock("@/lib/runtimeOptionBranches", () => ({
  fetchRuntimeOptionBranches: vi.fn(async (_client, _orgId, templateId, optionValue) => {
    if (templateId === PROJECT_UID_TEMPLATE_ID && optionValue === "PROJ-0001") {
      return {
        branches: [
          {
            id: PROJECT_ID_BRANCH_ID,
            organization_id: ORG_ID,
            parent_template_id: PROJECT_UID_TEMPLATE_ID,
            parent_option_value: "PROJ-0001",
            parent_branch_id: null,
            field_key: "project_id",
            name: "Project ID",
            field_type: "text",
            required: true,
            placeholder: null,
            help_text: null,
            default_value: null,
            validation_rules: null,
            options: null,
            display_order: 0,
          },
          {
            id: PROJECT_NAME_BRANCH_ID,
            organization_id: ORG_ID,
            parent_template_id: PROJECT_UID_TEMPLATE_ID,
            parent_option_value: "PROJ-0001",
            parent_branch_id: null,
            field_key: "project_name",
            name: "Project Name",
            field_type: "text",
            required: true,
            placeholder: null,
            help_text: null,
            default_value: null,
            validation_rules: null,
            options: null,
            display_order: 1,
          },
        ],
        error: false,
      };
    }
    return { branches: [], error: false };
  }),
}));

// Keep every ExpenseService method REAL except loadBranchFieldValuesForExpense
// (the one static method that loads previously-saved branch VALUES, which has
// no test-relevant network shape of its own worth reconstructing). Verified by
// grep that updateExpense / submitExpense / replaceExpenseFormFieldValues
// never call loadBranchFieldValuesForExpense internally, so this partial
// mock cannot silently swallow a `this.`-bound internal call.
//
// IMPORTANT: `{ ...actual.ExpenseService }` (a plain object spread) silently
// drops every static method, because class static methods are defined as
// NON-enumerable own properties — object spread only copies enumerable ones.
// That produced "ExpenseService.updateExpense is not a function" here.
// Copying every own property descriptor (enumerable or not) via
// Object.getOwnPropertyNames + defineProperty preserves them all, and the
// resulting plain object still gets `this` bound to ITSELF on every call
// (`mocked.updateExpense()` sets `this = mocked`), so an internal
// `this.canUserEditExpense(...)` call resolves back onto the same mocked
// object consistently.
vi.mock("@/services/ExpenseService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ExpenseService")>();
  const RealExpenseService = actual.ExpenseService as unknown as Record<string, unknown>;
  const cloned: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(RealExpenseService)) {
    if (name === "length" || name === "name" || name === "prototype") continue;
    const desc = Object.getOwnPropertyDescriptor(RealExpenseService, name);
    if (desc) Object.defineProperty(cloned, name, desc);
  }
  cloned.loadBranchFieldValuesForExpense = vi.fn().mockResolvedValue({
    [PROJECT_ID_BRANCH_ID]: "PID-123",
    [PROJECT_NAME_BRANCH_ID]: "Existing Project",
  });
  return {
    ...actual,
    ExpenseService: cloned,
  };
});

// ── fake Supabase client ─────────────────────────────────────────────────
// A table-dispatching fake standing in for Postgres. Every ExpenseService
// method invoked by this journey (updateExpense, submitExpense, and every
// `this.`-called helper: canUserEditExpense, hasOrgRole, fetchMembershipRole,
// getHierarchyFeatureFlags, isOrganizationFeatureEnabled, logAction, plus the
// module-level getUserOrganizationId/selectFirstProfileRow/
// selectFirstOrgSettingsRow helpers) runs for real against this fake, so the
// resubmit journey is exercised through genuine production code, not a stub.
const EXPENSE_FIXTURE = {
  id: EXPENSE_ID,
  title: EXPENSE_TITLE,
  destination: "Surat",
  trip_start: "2026-08-01",
  trip_end: "2026-08-01",
  purpose: "Site inspection",
  total_amount: 100,
  category: CATEGORY_NAME,
  status: "rejected",
  batch_id: null as string | null,
  user_id: USER_ID,
  organization_id: ORG_ID,
  assigned_engineer_id: null,
  assigned_reviewer_id: null,
  approval_tier: null,
};

const ASSIGNMENT_ROW = {
  id: ASSIGNMENT_ID,
  category_id: CATEGORY_ID,
  organization_id: ORG_ID,
  required: null,
  show_on_submit: null,
  display_order: 0,
  expense_form_field_templates: {
    id: PROJECT_UID_TEMPLATE_ID,
    name: "Project Unique ID",
    field_type: "select",
    required: true,
    show_on_submit: true,
    options: ["PROJ-0001", "PROJ-0002"],
    placeholder: null,
    help_text: null,
    default_value: null,
    validation_rules: null,
  },
};

const ORG_SETTINGS_ROW = {
  organization_id: ORG_ID,
  approval_hierarchy_role_labels: null,
  allow_cashier_expense_submission: false,
  require_immediate_supervisor: false,
  engineer_approval_limit: null,
  // Above the expense's own amount (100) so the "bill photo required" gate
  // never fires and this test doesn't need to fabricate attachment fixtures.
  attachment_required_above_amount: 999999,
  batch_expense_attachment_mode: null,
};

type QueryState = {
  table: string;
  mode: "select" | "insert" | "update" | "upsert" | "delete";
  columns: string;
  filters: Record<string, unknown>;
  inFilters: Record<string, unknown[]>;
  payload: unknown;
};

function shapeResult(rows: unknown[], shape: "array" | "maybeSingle" | "single") {
  if (shape === "array") return { data: rows, error: null };
  if (shape === "maybeSingle") return { data: rows[0] ?? null, error: null };
  return rows.length
    ? { data: rows[0], error: null }
    : { data: null, error: { code: "PGRST116", message: "No rows found" } };
}

function resolveRows(state: QueryState): Record<string, unknown>[] {
  switch (state.table) {
    case "expense_categories": {
      if (state.columns === "id") {
        return state.filters.name === CATEGORY_NAME ? [{ id: CATEGORY_ID }] : [];
      }
      return [{ name: CATEGORY_NAME, active: true }];
    }
    case "user_roles":
      return [];
    case "organization_settings":
      return [ORG_SETTINGS_ROW];
    case "organization_expense_form_fields":
      return [];
    case "expenses": {
      if (state.mode === "update") {
        return [{ ...EXPENSE_FIXTURE, ...(state.payload as Record<string, unknown>) }];
      }
      if (state.columns.includes("user_id") && !state.columns.includes("*")) {
        return [
          {
            user_id: EXPENSE_FIXTURE.user_id,
            status: EXPENSE_FIXTURE.status,
            organization_id: EXPENSE_FIXTURE.organization_id,
          },
        ];
      }
      return [{ ...EXPENSE_FIXTURE }];
    }
    case "expense_form_field_values":
      return [{ template_id: PROJECT_UID_TEMPLATE_ID, field_value: "PROJ-0001" }];
    case "expense_category_form_fields":
      return [ASSIGNMENT_ROW];
    case "attachments":
      return [];
    case "organization_memberships": {
      if (state.columns.includes("organization_id")) return [{ organization_id: ORG_ID }];
      if (state.columns.includes("role")) {
        if ("role" in state.filters) return []; // hasOrgRole(admin/engineer) -> not that role
        return [{ role: "employee" }]; // fetchMembershipRole
      }
      return [];
    }
    case "organization_features":
      return []; // both getHierarchyFeatureFlags (.in) and isOrganizationFeatureEnabled -> nothing configured
    case "profiles":
      return [];
    case "audit_logs":
      return [];
    case "category_usage_tracking":
      return [];
    case "form_field_option_usage_tracking":
      return [];
    default:
      return [];
  }
}

function makeQueryBuilder(table: string) {
  const state: QueryState = {
    table,
    mode: "select",
    columns: "*",
    filters: {},
    inFilters: {},
    payload: null,
  };

  const run = (shape: "array" | "maybeSingle" | "single") =>
    Promise.resolve().then(() => shapeResult(resolveRows(state), shape));

  const builder: Record<string, unknown> = {
    select(cols?: string) {
      state.columns = cols ?? "*";
      return builder;
    },
    insert(payload: unknown) {
      state.mode = "insert";
      state.payload = payload;
      return builder;
    },
    update(payload: unknown) {
      state.mode = "update";
      state.payload = payload;
      return builder;
    },
    upsert(payload: unknown) {
      state.mode = "upsert";
      state.payload = payload;
      return builder;
    },
    delete() {
      state.mode = "delete";
      return builder;
    },
    eq(col: string, val: unknown) {
      state.filters[col] = val;
      return builder;
    },
    in(col: string, vals: unknown[]) {
      state.inFilters[col] = vals;
      return builder;
    },
    not() {
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    maybeSingle() {
      return run("maybeSingle");
    },
    single() {
      return run("single");
    },
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return run("array").then(onFulfilled, onRejected);
    },
  };
  return builder;
}

const rpcMock = vi.fn(async (name: string, params: Record<string, unknown>) => {
  if (name === "replace_expense_form_field_values") {
    const values = (params?.p_values as unknown[]) ?? [];
    return { data: { saved_count: values.length }, error: null };
  }
  return { data: null, error: null };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => makeQueryBuilder(table),
    rpc: (...args: [string, Record<string, unknown>]) => rpcMock(...args),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(),
        remove: vi.fn(),
        getPublicUrl: vi.fn(),
      })),
    },
  },
}));

// ── test wrapper ──────────────────────────────────────────────────────────
function renderEditRoute() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: "/expenses/:id/edit", element: <ExpenseForm /> },
      // Post-resubmit navigation targets — real placeholders so a successful
      // save's navigate() doesn't fall through to React Router's noisy
      // default 404 error boundary.
      { path: "/expenses/:id", element: <div>expense detail</div> },
      { path: "/expenses", element: <div>expenses list</div> },
    ],
    { initialEntries: [`/expenses/${EXPENSE_ID}/edit`] },
  );
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function mockAuthenticatedOwner() {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: USER_ID, email: "owner@example.com" },
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
    organizationFeatureFlags: {
      [ORGANIZATION_FEATURE_KEYS.allow_conditional_dropdown_fields]: true,
    },
    hasOrganizationFeature: vi.fn().mockReturnValue(false),
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
  window.sessionStorage.clear();
  invalidateOrgSettings(ORG_ID);
  mockAuthenticatedOwner();
});

describe("ExpenseForm edit/resubmit — cascading custom-field preservation", () => {
  it("prefetches branch definitions on mount and shows the previously-saved values, then carries them through resubmit", async () => {
    renderEditRoute();

    // Page finishes its edit bootstrap (formReady) once fetchExpense's
    // finally-block runs completeEditBootstrap().
    await screen.findByDisplayValue(EXPENSE_TITLE, {}, { timeout: 5000 });

    // THE FIX: branch DEFINITIONS are prefetched on edit bootstrap now, not
    // left empty until the user re-opens the dropdown.
    await waitFor(() => {
      expect(fetchRuntimeOptionBranches).toHaveBeenCalledWith(
        expect.anything(),
        ORG_ID,
        PROJECT_UID_TEMPLATE_ID,
        "PROJ-0001",
      );
    });

    // Previously-saved values are rendered: Project Unique ID selection and
    // its two dependent branch values.
    await screen.findByText("PROJ-0001");
    expect(screen.getByDisplayValue("PID-123")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Existing Project")).toBeInTheDocument();

    // Resubmit.
    const resubmitButton = await screen.findByRole("button", { name: /resubmit/i });
    expect(resubmitButton).toBeEnabled();
    fireEvent.click(resubmitButton);

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        "replace_expense_form_field_values",
        expect.objectContaining({
          p_expense_id: EXPENSE_ID,
          p_organization_id: ORG_ID,
          p_values: expect.arrayContaining([
            { template_id: PROJECT_UID_TEMPLATE_ID, branch_field_id: null, field_value: "PROJ-0001" },
            { template_id: null, branch_field_id: PROJECT_ID_BRANCH_ID, field_value: "PID-123" },
            { template_id: null, branch_field_id: PROJECT_NAME_BRANCH_ID, field_value: "Existing Project" },
          ]),
        }),
      );
    });
  });

  it("blocks a premature resubmit while the branch definitions are still loading (isResolvedFor gate)", async () => {
    // Control the on-demand fetch by hand: don't let it resolve until the
    // test says so, so the click-before-resolution race is deterministic
    // rather than timing-dependent.
    let releaseFetch: (() => void) | null = null;
    const deferred = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    vi.mocked(fetchRuntimeOptionBranches).mockImplementationOnce(async (_c, _o, templateId, optionValue) => {
      await deferred;
      if (templateId === PROJECT_UID_TEMPLATE_ID && optionValue === "PROJ-0001") {
        return {
          branches: [
            {
              id: PROJECT_ID_BRANCH_ID,
              organization_id: ORG_ID,
              parent_template_id: PROJECT_UID_TEMPLATE_ID,
              parent_option_value: "PROJ-0001",
              parent_branch_id: null,
              field_key: "project_id",
              name: "Project ID",
              field_type: "text",
              required: true,
              placeholder: null,
              help_text: null,
              default_value: null,
              validation_rules: null,
              options: null,
              display_order: 0,
            },
          ],
          error: false,
        };
      }
      return { branches: [], error: false };
    });

    renderEditRoute();

    await screen.findByDisplayValue(EXPENSE_TITLE, {}, { timeout: 5000 });

    // The fetch has started (fired during bootstrap) but is deliberately held
    // open — isResolvedFor(PROJECT_UID_TEMPLATE_ID, "PROJ-0001") must still be
    // false at this point.
    await waitFor(() => {
      expect(fetchRuntimeOptionBranches).toHaveBeenCalledWith(
        expect.anything(),
        ORG_ID,
        PROJECT_UID_TEMPLATE_ID,
        "PROJ-0001",
      );
    });

    const resubmitButton = await screen.findByRole("button", { name: /resubmit/i });
    fireEvent.click(resubmitButton);

    // Give any (incorrect) synchronous submit path a chance to reach the RPC.
    await new Promise((r) => setTimeout(r, 50));
    expect(rpcMock).not.toHaveBeenCalledWith(
      "replace_expense_form_field_values",
      expect.anything(),
    );

    // Now let the fetch resolve and confirm the gate lifts and a subsequent
    // resubmit goes through.
    releaseFetch?.();
    await waitFor(() => {
      expect(screen.getByDisplayValue("PID-123")).toBeInTheDocument();
    });

    fireEvent.click(await screen.findByRole("button", { name: /resubmit/i }));
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        "replace_expense_form_field_values",
        expect.objectContaining({ p_expense_id: EXPENSE_ID }),
      );
    });
  });
});
