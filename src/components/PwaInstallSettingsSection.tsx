import { useTranslation } from "react-i18next";
import { Download, Loader2, Smartphone, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { usePwaInstallFlow } from "@/hooks/usePwaInstallFlow";
import { PwaInstallDialogs } from "@/components/PwaInstallDialogs";

/** Install app card on Settings — available to every user, same flow as the one-time prompt. */
export function PwaInstallSettingsSection() {
  const { t: tSettings } = useTranslation("settings");
  const flow = usePwaInstallFlow();

  if (flow.isStandalone) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-green-600" />
            {tSettings("pwa.installedTitle")}
          </CardTitle>
          <CardDescription>{tSettings("pwa.installedDescription")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5" />
            {tSettings("pwa.cardTitle")}
          </CardTitle>
          <CardDescription>{tSettings("pwa.cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{flow.description}</p>
          <Button
            className="gap-2"
            disabled={flow.installing}
            onClick={() => void flow.handleInstall()}
          >
            {flow.installing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {flow.installing ? flow.t("pwa.installPreparing") : flow.t("pwa.installAction")}
          </Button>
          {flow.isIos ? (
            <p className="text-xs text-muted-foreground">{tSettings("pwa.iosHint")}</p>
          ) : null}
        </CardContent>
      </Card>

      <PwaInstallDialogs
        t={flow.t}
        iosGuideOpen={flow.iosGuideOpen}
        setIosGuideOpen={flow.setIosGuideOpen}
        manualGuideOpen={flow.manualGuideOpen}
        setManualGuideOpen={flow.setManualGuideOpen}
      />
    </>
  );
}
