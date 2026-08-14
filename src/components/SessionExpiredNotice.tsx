import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { SESSION_EXPIRED_EVENT } from "@/lib/authSession";

/**
 * Shows exactly one "session expired" message when a stale refresh token is
 * cleared. The one-shot latch lives in authSession.ts, so repeated Supabase
 * failures produce a single event and a single toast.
 *
 * It never navigates: clearing auth state makes ProtectedRoute render
 * <Navigate to="/auth" /> on the SAME origin, which is what keeps a tenant user
 * on ml.pesowise.unimisk.com instead of bouncing them to the apex.
 */
export function SessionExpiredNotice() {
  const { toast } = useToast();
  const { t } = useTranslation(["auth"]);

  useEffect(() => {
    const onExpired = () => {
      toast({
        variant: "destructive",
        title: t("auth:sessionExpired"),
      });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [toast, t]);

  return null;
}
