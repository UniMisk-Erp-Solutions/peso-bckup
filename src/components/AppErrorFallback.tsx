import { useTranslation } from "react-i18next";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type AppErrorFallbackProps = {
  error?: Error;
  resetError: () => void;
};

export function AppErrorFallback({ error, resetError }: AppErrorFallbackProps) {
  const { t } = useTranslation("common");

  return (
    <div className="min-h-app flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 text-center shadow-sm">
        <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-destructive" aria-hidden />
        <h1 className="text-lg font-semibold text-foreground">{t("errorBoundary.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("errorBoundary.description")}</p>
        {error?.message ? (
          <p className="mt-3 rounded-md bg-muted px-3 py-2 text-left text-xs text-muted-foreground break-words">
            {error.message}
          </p>
        ) : null}
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button type="button" onClick={resetError}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t("errorBoundary.tryAgain")}
          </Button>
          <Button type="button" variant="outline" onClick={() => window.location.reload()}>
            {t("errorBoundary.reload")}
          </Button>
        </div>
      </div>
    </div>
  );
}
