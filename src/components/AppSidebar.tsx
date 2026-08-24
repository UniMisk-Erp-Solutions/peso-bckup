import { useEffect } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Receipt,
  Users,
  UserRoundSearch,
  FileText,
  LogOut,
  BarChart3,
  Bell,
  Tag,
  Settings as SettingsIcon,
  Clock,
  ShieldCheck,
  Wallet,
  CircleHelp,
  ArrowDownToLine,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { useAuth } from "@/contexts/AuthContext";
import { OrganizationLogo } from "@/components/OrganizationLogo";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { hasApprovalHierarchy, hasTeamsEnabled } from "@/lib/orgFeatureGates";
import { useAllowCashierExpenseSubmission } from "@/hooks/useAllowCashierExpenseSubmission";
import { useCashierCapabilities } from "@/hooks/useCashierCapabilities";
import { Button } from "@/components/ui/button";
import { useUnreadNotifications } from "@/hooks/useUnreadNotifications";
import { usePendingTransferOfferCount } from "@/hooks/usePendingTransferOfferCount";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "react-i18next";
import { useDashboardTheme } from "@/hooks/useDashboardTheme";

export function AppSidebar() {
  const { userRole, signOut, organization, user, userProfile, hasOrganizationFeature, organizationId, organizationFeatureFlags, isTenantHost, tenantHostOrgId } = useAuth();
  const [dashboardTheme] = useDashboardTheme();
  const isOldMoney = dashboardTheme === "old-money";
  const memberName = userProfile?.name || user?.email?.split("@")[0] || "Member";
  const memberInitials = memberName.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "PW";
  const memberRole = (userRole || "member").replace(/_/g, " ");
  const teamsEnabled = hasOrganizationFeature(ORGANIZATION_FEATURE_KEYS.teams_enabled);
  const approvalHierarchyEnabled = hasApprovalHierarchy({
    featureFlags: organizationFeatureFlags,
    isTenantHost,
    tenantHostOrgId,
    organizationId,
  });
  const myTeamsNavEnabled = teamsEnabled || approvalHierarchyEnabled;
  const balanceHistoryEnabled =
    userRole === "employee" &&
    hasOrganizationFeature(ORGANIZATION_FEATURE_KEYS.employee_transfer_history);
  const { isAccountantCashier, isOperationalCashier } = useCashierCapabilities();
  const { isMobile, setOpenMobile } = useSidebar();
  const location = useLocation();
  const { allowCashierExpenseSubmission } = useAllowCashierExpenseSubmission();
  const { unreadCount } = useUnreadNotifications();
  const { count: pendingTransferOffers, enabled: transferOffersEnabled } =
    usePendingTransferOfferCount();
  const { t } = useTranslation("nav");

  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [location.pathname, isMobile, setOpenMobile]);

  const withTransferOffersNav = <T extends { titleKey: string; url: string; icon: typeof LayoutDashboard }>(
    list: T[],
  ): T[] => {
    if (!transferOffersEnabled) return list;
    const transferItem = {
      titleKey: "transferOffers",
      url: "/transfer-offers",
      icon: Wallet,
    } as T;
    const notifIdx = list.findIndex((i) => i.titleKey === "notifications");
    const at = notifIdx >= 0 ? notifIdx : list.length;
    return [...list.slice(0, at), transferItem, ...list.slice(at)];
  };

  const employeeItems = [
    { titleKey: "dashboard", url: "/dashboard", icon: LayoutDashboard },
    { titleKey: "myExpenses", url: "/expenses", icon: Receipt },
    // DOC-087 — only when the org has employee_transfer_history enabled.
    ...(balanceHistoryEnabled
      ? [{ titleKey: "balanceHistory", url: "/balance-history", icon: ArrowDownToLine }]
      : []),
    { titleKey: "analytics", url: "/analytics", icon: BarChart3 },
    { titleKey: "notifications", url: "/notifications", icon: Bell },
    { titleKey: "settings", url: "/settings", icon: SettingsIcon },
  ];

  const engineerItems = [
    { titleKey: "dashboard", url: "/dashboard", icon: LayoutDashboard },
    { titleKey: "myExpenses", url: "/expenses", icon: Receipt },
    { titleKey: "reviewExpenses", url: "/review", icon: FileText },
    { titleKey: "notifications", url: "/notifications", icon: Bell },
    { titleKey: "settings", url: "/settings", icon: SettingsIcon },
  ];

  const adminItems = [
    { titleKey: "dashboard", url: "/dashboard", icon: LayoutDashboard },
    { titleKey: "myExpenses", url: "/expenses", icon: FileText },
    { titleKey: "allExpenses", url: "/admin/expenses", icon: Receipt },
    { titleKey: "balances", url: "/balances", icon: FileText },
    { titleKey: "manageUsers", url: "/admin/users", icon: Users },
    { titleKey: "submitForEmployee", url: "/admin/submit-expense", icon: UserRoundSearch },
    { titleKey: "categories", url: "/admin/categories", icon: Tag },
    { titleKey: "reports", url: "/admin/reports", icon: FileText },
    { titleKey: "analytics", url: "/analytics", icon: BarChart3 },
    { titleKey: "notifications", url: "/notifications", icon: Bell },
    { titleKey: "settings", url: "/settings", icon: SettingsIcon },
  ];

  const cashierOperationalItems = [
    { titleKey: "dashboard", url: "/dashboard", icon: LayoutDashboard },
    ...(allowCashierExpenseSubmission === true
      ? [{ titleKey: "myExpenses", url: "/expenses", icon: Receipt }]
      : []),
    { titleKey: "balances", url: "/balances", icon: FileText },
    { titleKey: "transactionHistory", url: "/cashier/transactions", icon: Clock },
    { titleKey: "analytics", url: "/analytics", icon: BarChart3 },
    { titleKey: "notifications", url: "/notifications", icon: Bell },
    { titleKey: "settings", url: "/settings", icon: SettingsIcon },
  ];

  const cashierAccountantItems = [
    { titleKey: "dashboard", url: "/dashboard", icon: LayoutDashboard },
    { titleKey: "approvedExpenses", url: "/accountant/expenses", icon: Receipt },
    { titleKey: "reports", url: "/admin/reports", icon: FileText },
    { titleKey: "transferHistory", url: "/cash-transfer-history", icon: Wallet },
    { titleKey: "notifications", url: "/notifications", icon: Bell },
    { titleKey: "settings", url: "/settings", icon: SettingsIcon },
    { titleKey: "help", url: "/help", icon: CircleHelp },
  ];

  const cashierItemsBase = isAccountantCashier ? cashierAccountantItems : cashierOperationalItems;

  const masterAdminItems = [
    { titleKey: "masterDashboard", url: "/master", icon: ShieldCheck },
    { titleKey: "settings", url: "/settings", icon: SettingsIcon },
  ];

  const hierarchyReviewerItems = [
    { titleKey: "dashboard", url: "/dashboard", icon: LayoutDashboard },
    { titleKey: "myExpenses", url: "/expenses", icon: Receipt },
    { titleKey: "reviewExpenses", url: "/review", icon: FileText },
    { titleKey: "notifications", url: "/notifications", icon: Bell },
    { titleKey: "settings", url: "/settings", icon: SettingsIcon },
  ];

  const MY_TEAMS_ROLES = new Set(["admin", "engineer", "team_leader", "executive"]);

  const withMyTeamsNav = <T extends { titleKey: string; url: string; icon: typeof LayoutDashboard }>(
    list: T[],
  ): T[] => {
    if (!myTeamsNavEnabled || !userRole || !MY_TEAMS_ROLES.has(userRole)) return list;
    const myTeamsItem = {
      titleKey: "myTeams",
      url: "/my-teams",
      icon: Users,
    } as T;
    const teamReportsItem = {
      titleKey: "teamReports",
      url: "/team-reports",
      icon: FileText,
    } as T;
    const insertItems =
      userRole === "admin" ? [myTeamsItem] : [myTeamsItem, teamReportsItem];
    const reviewIdx = list.findIndex((i) => i.titleKey === "reviewExpenses");
    if (reviewIdx >= 0) {
      return [
        ...list.slice(0, reviewIdx + 1),
        ...insertItems,
        ...list.slice(reviewIdx + 1),
      ];
    }
    const usersIdx = list.findIndex((i) => i.titleKey === "manageUsers");
    if (usersIdx >= 0) {
      return [...list.slice(0, usersIdx), myTeamsItem, ...list.slice(usersIdx)];
    }
    const settingsIdx = list.findIndex((i) => i.titleKey === "settings");
    const at = settingsIdx >= 0 ? settingsIdx : list.length;
    return [...list.slice(0, at), myTeamsItem, ...list.slice(at)];
  };

  const baseItemsRaw =
    userRole === "master_admin"
      ? masterAdminItems
      : userRole === "admin"
        ? adminItems
        : userRole === "engineer"
          ? engineerItems
          : userRole === "team_leader" || userRole === "executive"
            ? hierarchyReviewerItems
            : userRole === "cashier"
              ? cashierItemsBase
              : employeeItems;

  // /debug/review-expenses nav removed — consolidated into the single /review page.
  const baseItems = withMyTeamsNav(baseItemsRaw);

  const items =
    userRole === "cashier" && isAccountantCashier
      ? baseItems
      : withTransferOffersNav(baseItems);

  return (
    <Sidebar className="border-r-0 sm:border-r">
      <SidebarContent className="px-2 sm:px-0">
        <div className="px-4 sm:px-6 py-3 sm:py-4">
          <div className="flex items-center gap-2">
            <OrganizationLogo
              logoUrl={organization?.logo_url}
              alt={organization?.name || "PesoWise"}
              className="h-8 sm:h-10 w-auto flex-shrink-0 object-contain max-w-[180px]"
            />
          </div>
        </div>

        <SidebarGroup>
          <SidebarGroupLabel className="px-4 sm:px-6 text-xs sm:text-sm">
            {t("navigation", { defaultValue: "Navigation" })}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="px-2 sm:px-0">
              {items.map((item) => {
                const title = t(item.titleKey);
                return (
                  <SidebarMenuItem key={item.url + item.titleKey}>
                    <NavLink
                      to={item.url}
                      end={item.url === "/dashboard"}
                      onClick={() => {
                        if (isMobile) setOpenMobile(false);
                      }}
                      className={({ isActive }) => {
                        const baseClasses =
                          "flex items-center gap-3 px-3 py-3 rounded-lg text-base font-medium transition-colors min-h-[48px] md:py-2.5 md:rounded-md md:text-sm md:min-h-[44px]";
                        if (isActive) {
                          return `${baseClasses} bg-gray-200 text-gray-900 font-semibold`;
                        }
                        return `${baseClasses} text-sidebar-foreground hover:bg-gray-100 hover:text-gray-900`;
                      }}
                    >
                      <div className="relative flex-shrink-0">
                        <item.icon className="h-4 w-4" />
                        {item.titleKey === "notifications" && unreadCount > 0 && (
                          <span className="absolute -top-1 -right-1 h-2.5 w-2.5 bg-red-500 rounded-full border-2 border-white dark:border-gray-900" />
                        )}
                        {item.titleKey === "transferOffers" && pendingTransferOffers > 0 && (
                          <span className="absolute -top-1 -right-1 h-2.5 w-2.5 bg-red-500 rounded-full border-2 border-white dark:border-gray-900" />
                        )}
                      </div>
                      <span className="truncate flex-1">{title}</span>
                      {item.titleKey === "notifications" && unreadCount > 0 && (
                        <Badge
                          variant="destructive"
                          className="ml-auto h-5 min-w-5 px-1.5 text-xs flex items-center justify-center"
                        >
                          {unreadCount > 99 ? "99+" : unreadCount}
                        </Badge>
                      )}
                      {item.titleKey === "transferOffers" && pendingTransferOffers > 0 && (
                        <Badge
                          variant="destructive"
                          className="ml-auto h-5 min-w-5 px-1.5 text-xs flex items-center justify-center"
                        >
                          {pendingTransferOffers > 99 ? "99+" : pendingTransferOffers}
                        </Badge>
                      )}
                    </NavLink>
                  </SidebarMenuItem>
                );
              })}

              <SidebarMenuItem className="block sm:hidden mt-2">
                <Button
                  variant="ghost"
                  className="w-full justify-start h-10 text-sm"
                  onClick={() => signOut()}
                >
                  <LogOut className="mr-2 h-4 w-4 flex-shrink-0" />
                  <span className="truncate">{t("signOut")}</span>
                </Button>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-2 sm:px-0 hidden sm:block">
        {isOldMoney && (
          <div className="om-rail-profile">
            <div className="om-rail-ava">{memberInitials}</div>
            <div className="om-rail-id">
              <b>{memberName}</b>
              <small>{memberRole}</small>
            </div>
          </div>
        )}
        <Button
          variant="ghost"
          className="w-full justify-start h-10 sm:h-9 text-sm"
          onClick={() => signOut()}
        >
          <LogOut className="mr-2 h-4 w-4 flex-shrink-0" />
          <span className="truncate">{t("signOut")}</span>
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
