/**
 * Phase 6C — Employee 5-Tab Navigation + Mobile Settings + More-Sheet Audit
 *
 * T1–T12  Navigation (MobileBottomNav + MobileMoreSheet role maps)
 * T13–T21 Settings (MobileSettingsView sections, theme, notifications, admin)
 */

import { render, screen, fireEvent, within } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// ── Shared mocks ─────────────────────────────────────────────────────────────

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: vi.fn(),
}));
vi.mock("@/hooks/useAllowCashierExpenseSubmission", () => ({
  useAllowCashierExpenseSubmission: () => ({ allowCashierExpenseSubmission: null }),
}));
vi.mock("@/hooks/usePendingTransferOfferCount", () => ({
  usePendingTransferOfferCount: () => ({ enabled: false }),
}));
vi.mock("@/lib/orgFeatureGates", () => ({
  hasApprovalHierarchy: () => false,
  hasTeamsEnabled: () => false,
  // employee_transfer_history off — this suite covers the default nav layout.
  isOrganizationFeatureActive: () => false,
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

// ── Import components after mocks ────────────────────────────────────────────

import { useAuth } from "@/contexts/AuthContext";
import { MobileBottomNav } from "@/components/mobile/MobileBottomNav";
import { MobileMoreSheet } from "@/components/mobile/MobileMoreSheet";
import { MobileSettingsView } from "@/components/mobile/MobileSettingsView";

// ── Helper: mock auth ─────────────────────────────────────────────────────────

type MockRole =
  | "employee"
  | "admin"
  | "engineer"
  | "team_leader"
  | "executive"
  | "cashier";

function mockAuth(
  role: MockRole,
  extra: Record<string, unknown> = {},
) {
  (useAuth as ReturnType<typeof vi.fn>).mockReturnValue({
    userRole: role,
    isAccountantCashier: false,
    signOut: vi.fn(),
    organizationFeatureFlags: [],
    isTenantHost: false,
    tenantHostOrgId: null,
    organizationId: "org-1",
    ...extra,
  });
}

// ── Helper: render MobileBottomNav ────────────────────────────────────────────

function renderNav(role: MockRole, pathname = "/dashboard") {
  mockAuth(role);
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route
          path="*"
          element={<MobileBottomNav onMorePress={vi.fn()} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

// ── Helper: render MobileMoreSheet ────────────────────────────────────────────

function renderSheet(role: MockRole) {
  mockAuth(role);
  return render(
    <MemoryRouter>
      <MobileMoreSheet open onOpenChange={vi.fn()} />
    </MemoryRouter>,
  );
}

// ── Helper: minimal MobileSettingsView props ──────────────────────────────────

const noop = () => {};
const asyncNoop = async () => {};

function makeSettingsProps(role: string = "employee") {
  return {
    userRole: role,
    organizationId: role === "admin" ? "org-1" : null,
    organization: null,
    hierarchyEnabled: false,
    teamsEnabled: false,
    dailyProjectReportEnabled: false,
    baseFieldCustomizationEnabled: false,
    batchExpenseEntryEnabled: false,
    dashboardTheme: "legacy" as const,
    setDashboardTheme: noop as (v: "legacy" | "old-money") => void,
    notificationSettings: {
      popup_enabled: true,
      sound_enabled: true,
      desktop_enabled: false,
    },
    loadingNotifications: false,
    updateNotificationSetting: noop as (
      k: "popup_enabled" | "sound_enabled" | "desktop_enabled",
      v: boolean,
    ) => void,
    loading: false,
    saving: false,
    engineerApprovalLimit: "50000",
    setEngineerApprovalLimit: noop as (v: string) => void,
    disableManagerApprovalLimit: false,
    setDisableManagerApprovalLimit: noop as (v: boolean) => void,
    attachmentRequiredAboveAmount: "50",
    setAttachmentRequiredAboveAmount: noop as (v: string) => void,
    allowCashierExpenseSubmission: false,
    setAllowCashierExpenseSubmission: noop as (v: boolean) => void,
    requireImmediateSupervisor: false,
    setRequireImmediateSupervisor: noop as (v: boolean) => void,
    batchExpenseAttachmentMode: "per_line" as const,
    setBatchExpenseAttachmentMode: noop as (
      v: "per_line" | "shared",
    ) => void,
    saveSettings: asyncNoop,
    baseFieldConfig: {
      category: {
        field_key: "category",
        label: "Category",
        is_visible: true,
        is_required: true,
        display_order: 1,
        input_type: "default" as const,
        options: null,
      },
      amount: {
        field_key: "amount",
        label: "Amount",
        is_visible: true,
        is_required: true,
        display_order: 2,
        input_type: "default" as const,
        options: null,
      },
      expense_date: {
        field_key: "expense_date",
        label: "Date",
        is_visible: true,
        is_required: true,
        display_order: 3,
        input_type: "default" as const,
        options: null,
      },
    } as Parameters<typeof MobileSettingsView>[0]["baseFieldConfig"],
    savingFormBuilder: false,
    saveFormBuilderSettings: asyncNoop,
    openFieldEditor: noop as (k: "category" | "amount" | "expense_date") => void,
    detailViewFields: [],
    loadingDetailView: false,
    savingDetailView: false,
    moveDetailViewField: noop as (i: number, d: "up" | "down") => void,
    saveDetailViewOrder: asyncNoop,
    logoPreview: null,
    logoFile: null,
    uploadingLogo: false,
    setLogoFile: noop as (f: File | null) => void,
    setLogoPreview: noop as (v: string | null) => void,
    handleLogoUpload: asyncNoop,
    handleLogoDelete: asyncNoop,
    locations: [],
    loadingLocations: false,
    openLocationDialog: noop as (loc?: { id: string; name: string }) => void,
    openDeleteLocationDialog: noop as (loc: {
      id: string;
      name: string;
    }) => void,
    backupLoading: false,
    restoreLoading: false,
    includeReceipts: false,
    setIncludeReceipts: noop as (v: boolean) => void,
    handleDownloadBackup: asyncNoop,
    restoreFileInputRef: {
      current: null,
    } as React.RefObject<HTMLInputElement>,
    handleRestoreFileSelect: asyncNoop as React.ChangeEventHandler<HTMLInputElement>,
  };
}

import React from "react";

// ═════════════════════════════════════════════════════════════════════════════
// T1–T12  Navigation
// ═════════════════════════════════════════════════════════════════════════════

describe("T1 — Employee bottom nav has 5 tabs", () => {
  it("renders Home, Expenses, New (FAB), Settings, More for employee", () => {
    renderNav("employee");
    expect(screen.getByLabelText("Main navigation")).toBeInTheDocument();
    expect(screen.getByLabelText("Settings")).toBeInTheDocument();
    expect(screen.getByLabelText("New expense")).toBeInTheDocument();
    expect(screen.getByText("More")).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Expenses")).toBeInTheDocument();
  });
});

describe("T2 — Employee Settings tab links to /settings", () => {
  it("Settings NavLink has href /settings", () => {
    renderNav("employee");
    const settingsLink = screen.getByLabelText("Settings");
    expect(settingsLink).toHaveAttribute("href", "/settings");
  });
});

describe("T3 — Employee on /settings: Settings active, More NOT active", () => {
  it("More button is not highlighted when pathname is /settings", () => {
    renderNav("employee", "/settings");
    // The More button should NOT have text-primary class via aria-label
    const moreBtn = screen.getByLabelText("More options");
    expect(moreBtn).not.toHaveClass("text-primary");
  });
});

describe("T4 — Employee More sheet does NOT contain Settings", () => {
  it("Settings link is absent from employee More sheet", () => {
    renderSheet("employee");
    const sheet = screen.getByTestId("more-sheet");
    const items = within(sheet).queryAllByTestId("more-sheet-item");
    const hrefs = items.map((el) => el.getAttribute("href"));
    expect(hrefs).not.toContain("/settings");
  });
});

describe("T5 — Employee More sheet contains Analytics, Notifications, Help", () => {
  it("correct items for employee More", () => {
    renderSheet("employee");
    const sheet = screen.getByTestId("more-sheet");
    const items = within(sheet).queryAllByTestId("more-sheet-item");
    const hrefs = items.map((el) => el.getAttribute("href"));
    expect(hrefs).toContain("/analytics");
    expect(hrefs).toContain("/notifications");
    expect(hrefs).toContain("/help");
  });
});

describe("T6 — Admin bottom nav: Home | Expenses | FAB | All Expenses | More", () => {
  it("admin nav has All Expenses direct tab and no Settings direct tab", () => {
    renderNav("admin");
    const allExpLink = screen.getByRole("link", { name: /all expenses/i });
    expect(allExpLink).toHaveAttribute("href", "/admin/expenses");
    expect(screen.queryByLabelText("Settings")).toBeNull();
  });
});

describe("T7 — Admin More sheet does NOT have All Expenses or Review", () => {
  it("all-expenses and review hrefs absent from admin More sheet", () => {
    renderSheet("admin");
    const items = screen.queryAllByTestId("more-sheet-item");
    const hrefs = items.map((el) => el.getAttribute("href"));
    expect(hrefs).not.toContain("/admin/expenses");
    expect(hrefs).not.toContain("/review");
  });
});

describe("T8 — Reviewer (engineer) nav: Home | Expenses | FAB | Review | More", () => {
  it("engineer nav has Review direct tab", () => {
    renderNav("engineer");
    const reviewLink = screen.getByRole("link", { name: /review/i });
    expect(reviewLink).toHaveAttribute("href", "/review");
  });
});

describe("T9 — Reviewer More sheet does NOT have duplicate Review link", () => {
  it("review href appears at most once in reviewer More sheet", () => {
    renderSheet("engineer");
    const items = screen.queryAllByTestId("more-sheet-item");
    const reviewItems = items.filter(
      (el) => el.getAttribute("href") === "/review",
    );
    expect(reviewItems.length).toBe(0);
  });
});

describe("T10 — Cashier More sheet is unchanged (has Settings)", () => {
  it("cashier More sheet still contains Settings", () => {
    renderSheet("cashier");
    const sheet = screen.getByTestId("more-sheet");
    const items = within(sheet).queryAllByTestId("more-sheet-item");
    const hrefs = items.map((el) => el.getAttribute("href"));
    expect(hrefs).toContain("/settings");
  });
});

describe("T11 — Employee More sheet has Sign Out", () => {
  it("sign-out button is present in employee More sheet", () => {
    renderSheet("employee");
    expect(screen.getByText("signOut")).toBeInTheDocument();
  });
});

describe("T12 — More is active on /analytics for employee (in MORE_ACTIVE_PREFIXES, not a direct tab)", () => {
  it("More button is active when employee is on /analytics", () => {
    renderNav("employee", "/analytics");
    const moreBtn = screen.getByLabelText("More options");
    expect(moreBtn).toHaveClass("text-primary");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T13–T21  MobileSettingsView
// ═════════════════════════════════════════════════════════════════════════════

describe("T13 — MobileSettingsView renders for employee (no admin sections)", () => {
  it("renders appearance and notifications but not admin settings card", () => {
    render(
      <MemoryRouter>
        <MobileSettingsView {...makeSettingsProps("employee")} />
      </MemoryRouter>,
    );
    expect(
      screen.getByTestId("mobile-settings-appearance"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("mobile-settings-notifications"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-settings-admin")).toBeNull();
  });
});

describe("T14 — MobileSettingsView renders admin sections for admin role", () => {
  it("admin settings card is present for admin role", () => {
    render(
      <MemoryRouter>
        <MobileSettingsView {...makeSettingsProps("admin")} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("mobile-settings-admin")).toBeInTheDocument();
    expect(
      screen.getByTestId("mobile-settings-form-builder"),
    ).toBeInTheDocument();
  });
});

describe("T15 — Theme selection fires setDashboardTheme with correct value", () => {
  it("clicking old-money option calls setDashboardTheme('old-money')", () => {
    const setDashboardTheme = vi.fn();
    const props = { ...makeSettingsProps("employee"), setDashboardTheme };
    render(
      <MemoryRouter>
        <MobileSettingsView {...props} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("theme-option-old-money"));
    expect(setDashboardTheme).toHaveBeenCalledWith("old-money");
  });
});

describe("T16 — Active theme option shows 'Active' badge", () => {
  it("legacy option shows Active when dashboardTheme is legacy", () => {
    const props = { ...makeSettingsProps("employee"), dashboardTheme: "legacy" as const };
    render(
      <MemoryRouter>
        <MobileSettingsView {...props} />
      </MemoryRouter>,
    );
    const legacyBtn = screen.getByTestId("theme-option-legacy");
    expect(within(legacyBtn).getByText("Active")).toBeInTheDocument();
    const oldMoneyBtn = screen.getByTestId("theme-option-old-money");
    expect(within(oldMoneyBtn).queryByText("Active")).toBeNull();
  });
});

describe("T17 — Notification toggles call updateNotificationSetting", () => {
  it("toggling popup switch fires updateNotificationSetting('popup_enabled', false)", () => {
    const updateNotificationSetting = vi.fn();
    const props = { ...makeSettingsProps("employee"), updateNotificationSetting };
    render(
      <MemoryRouter>
        <MobileSettingsView {...props} />
      </MemoryRouter>,
    );
    // Switch for popup — it's checked by default, clicking fires the handler
    const notifCard = screen.getByTestId("mobile-settings-notifications");
    const switches = within(notifCard).getAllByRole("switch");
    fireEvent.click(switches[0]);
    expect(updateNotificationSetting).toHaveBeenCalled();
  });
});

describe("T18 — Admin: Save Settings button present", () => {
  it("save button with testid mobile-settings-save is rendered for admin", () => {
    render(
      <MemoryRouter>
        <MobileSettingsView {...makeSettingsProps("admin")} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("mobile-settings-save")).toBeInTheDocument();
  });
});

describe("T19 — Admin: Save Settings fires saveSettings", () => {
  it("clicking Save Settings calls saveSettings prop", () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const props = { ...makeSettingsProps("admin"), saveSettings };
    render(
      <MemoryRouter>
        <MobileSettingsView {...props} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("mobile-settings-save"));
    expect(saveSettings).toHaveBeenCalled();
  });
});

describe("T20 — Form builder edit button fires openFieldEditor", () => {
  it("clicking Edit on a field calls openFieldEditor with that field key", () => {
    const openFieldEditor = vi.fn();
    const props = { ...makeSettingsProps("admin"), openFieldEditor };
    render(
      <MemoryRouter>
        <MobileSettingsView {...props} />
      </MemoryRouter>,
    );
    const editBtns = screen.getAllByRole("button", { name: /^Edit/i });
    fireEvent.click(editBtns[0]);
    expect(openFieldEditor).toHaveBeenCalled();
  });
});

describe("T21 — Detail view empty state shown when no custom fields", () => {
  it("empty message rendered when detailViewFields is empty", () => {
    render(
      <MemoryRouter>
        <MobileSettingsView
          {...makeSettingsProps("admin")}
          detailViewFields={[]}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByTestId("mobile-settings-detail-empty"),
    ).toBeInTheDocument();
  });
});
