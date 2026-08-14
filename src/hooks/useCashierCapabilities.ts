import { useAuth } from "@/contexts/auth-context";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";

export function useCashierCapabilities() {
  const { userRole, isAccountantCashier, hasOrganizationFeature } = useAuth();

  const featureEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.cashier_accountant_mode,
  );
  const isCashier = userRole === "cashier";
  const isOperationalCashier = isCashier && !isAccountantCashier;
  const canAccessReports = userRole === "admin" || isAccountantCashier;
  const canWriteCashierOps = isOperationalCashier;
  const canViewApprovedExpenses = userRole === "admin" || isAccountantCashier;
  const canViewTransferHistory =
    userRole === "admin" || isAccountantCashier || isOperationalCashier;

  return {
    featureEnabled,
    isCashier,
    isAccountantCashier,
    isOperationalCashier,
    canAccessReports,
    canWriteCashierOps,
    canViewApprovedExpenses,
    canViewTransferHistory,
  };
}
