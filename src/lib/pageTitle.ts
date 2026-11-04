export const PAGE_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/expenses": "My Expenses",
  "/expenses/new": "New Expense",
  "/expenses/batch/new": "New Batch",
  "/admin/expenses": "All Expenses",
  "/admin/users": "User Management",
  "/admin/reports": "Reports",
  "/admin/pwtally": "Tally integration setup",
  "/admin/categories": "Categories",
  "/accountant/expenses": "Approved Expenses",
  "/my-teams": "My Teams",
  "/team-reports": "Team Reports",
  "/settings": "Settings",
  "/review": "Review Expenses",
  "/analytics": "Analytics",
  "/cashier/transactions": "Transactions",
  "/cash-transfer-history": "Transfer History",
  "/transfer-offers": "Transfer Offers",
  "/notifications": "Notifications",
  "/balances": "Balances",
  "/master": "Master Admin",
  "/help": "Help & Tutorial",
  "/notification-settings": "Notification Settings",
};

export function getPageTitle(pathname: string): string {
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];
  if (/^\/expenses\/[^/]+\/edit$/.test(pathname)) return "Edit Expense";
  if (/^\/expenses\/batch\/[^/]+\/review$/.test(pathname)) return "Review Batch";
  if (/^\/expenses\/[^/]+$/.test(pathname)) return "Expense Details";
  return "PesoWise";
}
