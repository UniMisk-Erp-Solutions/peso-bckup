import { useAuth } from "@/contexts/AuthContext";
import { useAllowCashierExpenseSubmission } from "@/hooks/useAllowCashierExpenseSubmission";
import { EXPENSE_SUBMITTER_ROLES, type AppOrgRole } from "@/lib/routeAccess";

/** Whether this org role may create their own expenses (single or batch). */
export function canRoleSubmitOwnExpenses(
  userRole: string | null | undefined,
  allowCashierExpenseSubmission: boolean | null,
): boolean {
  if (!userRole || !EXPENSE_SUBMITTER_ROLES.includes(userRole as AppOrgRole)) {
    return false;
  }
  if (userRole === "cashier") {
    return allowCashierExpenseSubmission === true;
  }
  return true;
}

export function useCanSubmitOwnExpenses() {
  const { userRole } = useAuth();
  const { allowCashierExpenseSubmission, loading: cashierLoading } =
    useAllowCashierExpenseSubmission();

  const canSubmitExpenses = canRoleSubmitOwnExpenses(
    userRole,
    allowCashierExpenseSubmission,
  );

  return {
    canSubmitExpenses,
    loading: userRole === "cashier" ? cashierLoading : false,
  };
}
