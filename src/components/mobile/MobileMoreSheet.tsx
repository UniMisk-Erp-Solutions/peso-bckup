import { NavLink } from "react-router-dom";
import {
  BarChart3,
  Wallet,
  Receipt,
  Users,
  Tag,
  FileText,
  Bell,
  Settings,
  Users2,
  TrendingUp,
  CircleHelp,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRightLeft,
  ClipboardCheck,
  CheckCircle2,
  LogOut,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import {
  hasApprovalHierarchy,
  hasTeamsEnabled,
  isOrganizationFeatureActive,
} from "@/lib/orgFeatureGates";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { usePendingTransferOfferCount } from "@/hooks/usePendingTransferOfferCount";
import { useAllowCashierExpenseSubmission } from "@/hooks/useAllowCashierExpenseSubmission";
import { EXPENSE_REVIEW_ROLES, type AppOrgRole } from "@/lib/routeAccess";

type SheetItem = {
  href: string;
  Icon: LucideIcon;
  labelKey: string;
};

type SheetSection = {
  /** i18n key for section heading, or empty string for unsectioned roles */
  titleKey: string;
  items: SheetItem[];
};

// ── Item definitions ──────────────────────────────────────────────────────────

const NOTIFICATIONS: SheetItem = { href: "/notifications", Icon: Bell, labelKey: "notifications" };
const SETTINGS: SheetItem = { href: "/settings", Icon: Settings, labelKey: "settings" };
const ANALYTICS: SheetItem = { href: "/analytics", Icon: BarChart3, labelKey: "analytics" };
const REPORTS: SheetItem = { href: "/admin/reports", Icon: FileText, labelKey: "reports" };
const HELP: SheetItem = { href: "/help", Icon: CircleHelp, labelKey: "help" };
const ALL_EXPENSES: SheetItem = { href: "/admin/expenses", Icon: Receipt, labelKey: "allExpenses" };
const BALANCES: SheetItem = { href: "/balances", Icon: Wallet, labelKey: "balances" };
const MANAGE_USERS: SheetItem = { href: "/admin/users", Icon: Users, labelKey: "manageUsers" };
const CATEGORIES: SheetItem = { href: "/admin/categories", Icon: Tag, labelKey: "categories" };
const MY_TEAMS: SheetItem = { href: "/my-teams", Icon: Users2, labelKey: "myTeams" };
const TEAM_REPORTS: SheetItem = { href: "/team-reports", Icon: TrendingUp, labelKey: "teamReports" };
const TRANSFER_HISTORY: SheetItem = {
  href: "/cash-transfer-history",
  Icon: ArrowRightLeft,
  labelKey: "transferHistory",
};
const TRANSFER_OFFERS: SheetItem = {
  href: "/transfer-offers",
  Icon: CheckCircle2,
  labelKey: "transferOffers",
};
const BALANCE_HISTORY: SheetItem = {
  href: "/balance-history",
  Icon: ArrowDownToLine,
  labelKey: "balanceHistory",
};
const TRANSACTIONS: SheetItem = {
  href: "/cashier/transactions",
  Icon: ArrowLeftRight,
  labelKey: "transactionHistory",
};
const APPROVED: SheetItem = {
  href: "/accountant/expenses",
  Icon: ClipboardCheck,
  labelKey: "approvedExpenses",
};

// ── Section builder ───────────────────────────────────────────────────────────

function buildSections(
  role: string | null | undefined,
  isAccountantCashier: boolean,
  showMyTeams: boolean,
  showTransferOffers: boolean,
  allowCashierExpense: boolean | null,
  showBalanceHistory: boolean,
): SheetSection[] {
  if (role === "master_admin") return [];

  if (isAccountantCashier) {
    return [
      {
        titleKey: "",
        items: [
          APPROVED,
          REPORTS,
          TRANSFER_HISTORY,
          SETTINGS,
          HELP,
        ],
      },
    ];
  }

  if (role === "admin") {
    const workspaceItems: SheetItem[] = [
      NOTIFICATIONS,
      REPORTS,
      ANALYTICS,
      ...(showMyTeams ? [MY_TEAMS, TEAM_REPORTS] : []),
    ];

    const administrationItems: SheetItem[] = [
      BALANCES,
      MANAGE_USERS,
      CATEGORIES,
      SETTINGS,
    ];

    return [
      { titleKey: "sectionWorkspace", items: workspaceItems },
      { titleKey: "sectionAdministration", items: administrationItems },
      { titleKey: "sectionAccount", items: [HELP] },
    ];
  }

  if (role === "cashier") {
    const items: SheetItem[] = [];
    if (allowCashierExpense) {
      items.push(BALANCES);
      items.push(TRANSACTIONS);
    }
    items.push(TRANSFER_HISTORY);
    if (showTransferOffers) items.push(TRANSFER_OFFERS);
    items.push(ANALYTICS);
    items.push(NOTIFICATIONS);
    items.push(SETTINGS);
    items.push(HELP);
    return [{ titleKey: "", items }];
  }

  const isReviewer = EXPENSE_REVIEW_ROLES.includes(role as AppOrgRole);
  if (isReviewer) {
    const items: SheetItem[] = [];
    if (showMyTeams) {
      items.push(MY_TEAMS);
      items.push(TEAM_REPORTS);
    }
    items.push(NOTIFICATIONS);
    items.push(SETTINGS);
    items.push(HELP);
    return [{ titleKey: "", items }];
  }

  // employee (default) — Settings is a direct nav tab, so not duplicated here.
  // DOC-087: Balance History joins the sheet rather than displacing a primary tab.
  return [
    {
      titleKey: "",
      items: [
        ...(showBalanceHistory ? [BALANCE_HISTORY] : []),
        ANALYTICS,
        NOTIFICATIONS,
        HELP,
      ],
    },
  ];
}

// ── Component ─────────────────────────────────────────────────────────────────

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function MobileMoreSheet({ open, onOpenChange }: Props) {
  const { t } = useTranslation("nav");
  const {
    userRole,
    isAccountantCashier,
    signOut,
    organizationFeatureFlags,
    isTenantHost,
    tenantHostOrgId,
    organizationId,
  } = useAuth();

  const { enabled: transferOffersEnabled } = usePendingTransferOfferCount();
  const { allowCashierExpenseSubmission } = useAllowCashierExpenseSubmission();

  const featureCtx = {
    featureFlags: organizationFeatureFlags ?? {},
    isTenantHost: isTenantHost ?? false,
    tenantHostOrgId: tenantHostOrgId ?? null,
    organizationId: organizationId ?? null,
  };
  const showMyTeams = hasTeamsEnabled(featureCtx) && hasApprovalHierarchy(featureCtx);
  const showTransferOffers = !!transferOffersEnabled;
  const showBalanceHistory =
    userRole === "employee" &&
    isOrganizationFeatureActive(
      ORGANIZATION_FEATURE_KEYS.employee_transfer_history,
      featureCtx,
    );

  const sections = buildSections(
    userRole,
    isAccountantCashier,
    showMyTeams,
    showTransferOffers,
    allowCashierExpenseSubmission,
    showBalanceHistory,
  );

  const hasMultipleSections = sections.length > 1;

  const linkClass = (isActive: boolean) =>
    [
      "flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors",
      isActive ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted",
    ].join(" ");

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      shouldScaleBackground={false}
      aria-label="More navigation"
    >
      <DrawerContent className="max-h-[85dvh]" data-testid="more-sheet">
        <DrawerHeader className="pb-2">
          <DrawerTitle className="text-base">Menu</DrawerTitle>
        </DrawerHeader>

        <div className="overflow-y-auto px-3 pb-3">
          {sections.map((section, si) => (
            <div key={si}>
              {hasMultipleSections && section.titleKey && (
                <p className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t(section.titleKey)}
                </p>
              )}

              {section.items.map((item) => (
                <NavLink
                  key={item.href}
                  to={item.href}
                  onClick={() => onOpenChange(false)}
                  className={({ isActive }) => linkClass(isActive)}
                  data-testid="more-sheet-item"
                >
                  <item.Icon className="h-5 w-5 shrink-0" />
                  <span>{t(item.labelKey)}</span>
                </NavLink>
              ))}

              {/* divider between sections */}
              {hasMultipleSections && si < sections.length - 1 && (
                <div className="my-1 border-t border-border" />
              )}
            </div>
          ))}

          {/* Sign Out — always last, below all sections */}
          <div className="mt-2 border-t border-border" />
          <button
            onClick={async () => {
              onOpenChange(false);
              await signOut();
            }}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
          >
            <LogOut className="h-5 w-5 shrink-0" />
            <span>{t("signOut")}</span>
          </button>
        </div>

        {/* safe-area bottom clearance */}
        <div aria-hidden style={{ height: "env(safe-area-inset-bottom, 0px)" }} />
      </DrawerContent>
    </Drawer>
  );
}
