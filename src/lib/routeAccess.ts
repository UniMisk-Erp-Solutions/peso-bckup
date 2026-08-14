/** Mirrors ProtectedRoute / AuthContext org roles (excludes master_admin on tenant routes). */
export type AppOrgRole =
  | "admin"
  | "engineer"
  | "employee"
  | "cashier"
  | "team_leader"
  | "executive";

/** Roles that use Settings, notifications, and help (matches AppSidebar). */
export const STANDARD_APP_ROLES: AppOrgRole[] = [
  "employee",
  "admin",
  "engineer",
  "cashier",
  "team_leader",
  "executive",
];

export const HIERARCHY_REVIEWER_ROLES: AppOrgRole[] = ["team_leader", "executive"];

export const EXPENSE_SUBMITTER_ROLES: AppOrgRole[] = [
  "employee",
  "admin",
  "engineer",
  "cashier",
  "team_leader",
  "executive",
];

export const EXPENSE_REVIEW_ROLES: AppOrgRole[] = [
  "engineer",
  "team_leader",
  "executive",
];

/** Paths accountant cashiers must not access (mirrors App.tsx blockAccountantCashier routes). */
export const ACCOUNTANT_CASHIER_BLOCKED_PATHS = [
  "/balances",
  "/cashier/transactions",
  "/admin/expenses",
  "/analytics",
  "/transfer-offers",
] as const;

export function isPathBlockedForAccountantCashier(pathname: string): boolean {
  if (/^\/expenses\/[^/]+\/edit$/.test(pathname)) return true;
  if (
    pathname === "/expenses" ||
    pathname === "/expenses/new" ||
    pathname.startsWith("/expenses/batch")
  ) {
    return true;
  }
  return ACCOUNTANT_CASHIER_BLOCKED_PATHS.some(
    (blocked) => pathname === blocked || pathname.startsWith(`${blocked}/`),
  );
}
