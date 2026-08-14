import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useCashierCapabilities } from "@/hooks/useCashierCapabilities";
import { useToast } from "@/hooks/use-toast";

/** Redirect accountant cashiers away from operational cashier pages. */
export function useRequireOperationalCashier() {
  const { isAccountantCashier, isCashier } = useCashierCapabilities();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation("cashier");

  useEffect(() => {
    if (isCashier && isAccountantCashier) {
      toast({
        variant: "destructive",
        title: t("accountantReadOnlyTitle"),
        description: t("accountantReadOnlyDescription"),
      });
      navigate("/dashboard", { replace: true });
    }
  }, [isAccountantCashier, isCashier, navigate, toast, t]);

  return { blocked: isCashier && isAccountantCashier };
}
