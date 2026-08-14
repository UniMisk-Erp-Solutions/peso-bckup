import { NavLink, useNavigate, useLocation } from "react-router-dom";
import {
  Home,
  Receipt,
  ClipboardCheck,
  MoreHorizontal,
  Plus,
  Bell,
  Wallet,
  ArrowLeftRight,
  LayoutDashboard,
  Settings as SettingsTabIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useAllowCashierExpenseSubmission } from "@/hooks/useAllowCashierExpenseSubmission";
import { EXPENSE_REVIEW_ROLES, type AppOrgRole } from "@/lib/routeAccess";

type LinkTab = { kind: "link"; href: string; Icon: LucideIcon; label: string; ariaLabel?: string };
type MoreTab = { kind: "more"; Icon: LucideIcon; label: string };
type FabSlot = { kind: "fab" };
type Tab = LinkTab | MoreTab | FabSlot;

// Paths that cause the More button to show as active
const MORE_ACTIVE_PREFIXES = [
  "/notifications",
  "/settings",
  "/analytics",
  "/admin/users",
  "/admin/categories",
  "/admin/reports",
  "/balances",
  "/cashier/transactions",
  "/transfer-offers",
  "/cash-transfer-history",
  "/balance-history",
  "/my-teams",
  "/team-reports",
  "/help",
  "/accountant",
];

// directHrefs: the hrefs of all direct-link tabs in the current role's tab list.
// If the current path is already handled by a direct tab, More should not be active
// even if the path appears in MORE_ACTIVE_PREFIXES (e.g. /settings for employee).
function isMoreActivePath(pathname: string, directHrefs: string[]): boolean {
  if (directHrefs.some((h) => pathname === h || pathname.startsWith(h + "/"))) {
    return false;
  }
  return MORE_ACTIVE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

function buildTabs(
  role: string | null | undefined,
  isAccountantCashier: boolean,
  allowCashierExpense: boolean | null,
): Tab[] {
  const home: Tab = { kind: "link", href: "/dashboard", Icon: Home, label: "Home" };
  const fab: Tab = { kind: "fab" };
  const more: Tab = { kind: "more", Icon: MoreHorizontal, label: "More" };
  const expenses: Tab = { kind: "link", href: "/expenses", Icon: Receipt, label: "Expenses" };
  const review: Tab = {
    kind: "link",
    href: "/review",
    Icon: ClipboardCheck,
    label: "Review",
  };

  if (role === "admin") {
    const allExpenses: Tab = {
      kind: "link",
      href: "/admin/expenses",
      Icon: Receipt,
      label: "All\nExpenses",
      ariaLabel: "All Expenses",
    };
    return [home, expenses, fab, allExpenses, more];
  }

  if (role === "master_admin") {
    return [
      { kind: "link", href: "/master", Icon: LayoutDashboard, label: "Master" },
      { kind: "link", href: "/settings", Icon: LayoutDashboard, label: "Settings" },
      more,
    ];
  }

  if (isAccountantCashier) {
    return [
      home,
      { kind: "link", href: "/accountant/expenses", Icon: Receipt, label: "Approved" },
      { kind: "link", href: "/notifications", Icon: Bell, label: "Notifications" },
      more,
    ];
  }

  if (role === "cashier") {
    if (allowCashierExpense) {
      return [home, expenses, fab, more];
    }
    return [
      home,
      { kind: "link", href: "/balances", Icon: Wallet, label: "Balances" },
      {
        kind: "link",
        href: "/cashier/transactions",
        Icon: ArrowLeftRight,
        label: "Transactions",
      },
      more,
    ];
  }

  // Reviewer roles (engineer / team_leader / executive):
  // 5-item layout — Home | Expenses | [FAB] | Review | More
  // Admin: Review lives inside the More sheet, so admin uses the 4-item layout.
  const hasReviewNav = EXPENSE_REVIEW_ROLES.includes(role as AppOrgRole);
  if (hasReviewNav) {
    return [home, expenses, fab, review, more];
  }

  // Regular employee: 5-item — Home | Expenses | [FAB] | Settings | More
  const settingsTab: Tab = {
    kind: "link",
    href: "/settings",
    Icon: SettingsTabIcon,
    label: "Settings",
    ariaLabel: "Settings",
  };
  return [home, expenses, fab, settingsTab, more];
}

// Base class shared by all tappable nav slots
const TAB_BASE =
  "flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 py-2";

type Props = { onMorePress: () => void };

export function MobileBottomNav({ onMorePress }: Props) {
  const { userRole, isAccountantCashier } = useAuth();
  const { allowCashierExpenseSubmission } = useAllowCashierExpenseSubmission();
  const navigate = useNavigate();
  const location = useLocation();

  const tabs = buildTabs(userRole, isAccountantCashier, allowCashierExpenseSubmission);
  const directHrefs = tabs
    .filter((t): t is LinkTab => t.kind === "link")
    .map((t) => t.href);
  const moreIsActive = isMoreActivePath(location.pathname, directHrefs);

  return (
    <nav
      className="shrink-0 flex flex-col overflow-visible bg-background/90 backdrop-blur-md border-t border-border"
      aria-label="Main navigation"
    >
      <div className="h-[76px] flex items-center w-full">
        {tabs.map((tab) => {
          if (tab.kind === "fab") {
            return (
              <div
                key="fab"
                className="flex-1 min-w-0 flex flex-col items-center justify-center overflow-visible"
              >
                <button
                  onClick={() => navigate("/expenses/new")}
                  className="-mt-5 w-[54px] h-[54px] rounded-[18px] bg-primary text-primary-foreground flex items-center justify-center mobile-fab-shadow"
                  aria-label="New expense"
                >
                  <Plus className="h-6 w-6" strokeWidth={2.5} />
                </button>
                <span className="text-[10px] font-medium text-primary mt-0.5">New</span>
              </div>
            );
          }

          if (tab.kind === "more") {
            return (
              <button
                key="more"
                onClick={onMorePress}
                className={`${TAB_BASE} ${
                  moreIsActive
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground transition-colors"
                }`}
                aria-label="More options"
              >
                <tab.Icon className="h-5 w-5 shrink-0" />
                <span className="text-[10px] font-medium truncate max-w-full">
                  {tab.label}
                </span>
              </button>
            );
          }

          return (
            <NavLink
              key={tab.href}
              to={tab.href}
              end={tab.href === "/dashboard"}
              aria-label={tab.ariaLabel}
              className={({ isActive }) =>
                `${TAB_BASE} ${
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground transition-colors"
                }`
              }
              aria-current={undefined}
            >
              {({ isActive }) => (
                <>
                  <tab.Icon className="h-5 w-5 shrink-0" />
                  {tab.label.includes("\n") ? (
                    <span className="text-[10px] font-medium text-center leading-tight max-w-full">
                      {tab.label.split("\n").map((line, i) => (
                        <span key={i} className="block">{line}</span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-[10px] font-medium truncate max-w-full">
                      {tab.label}
                    </span>
                  )}
                  {isActive && <span className="sr-only">(current page)</span>}
                </>
              )}
            </NavLink>
          );
        })}
      </div>
      {/* safe-area spacer */}
      <div aria-hidden style={{ height: "env(safe-area-inset-bottom, 0px)" }} />
    </nav>
  );
}
