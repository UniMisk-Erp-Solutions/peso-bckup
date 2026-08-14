import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type PwaInstallDialogsProps = {
  t: (key: string) => string;
  iosGuideOpen: boolean;
  setIosGuideOpen: (open: boolean) => void;
  manualGuideOpen: boolean;
  setManualGuideOpen: (open: boolean) => void;
};

export function PwaInstallDialogs({
  t,
  iosGuideOpen,
  setIosGuideOpen,
  manualGuideOpen,
  setManualGuideOpen,
}: PwaInstallDialogsProps) {
  return (
    <>
      <AlertDialog open={iosGuideOpen} onOpenChange={setIosGuideOpen}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pwa.iosInstallTitle")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground mt-2">
                <li>{t("pwa.iosStep1")}</li>
                <li>{t("pwa.iosStep2")}</li>
                <li>{t("pwa.iosStep3")}</li>
              </ol>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setIosGuideOpen(false)}>
              {t("pwa.iosGotIt")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={manualGuideOpen} onOpenChange={setManualGuideOpen}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pwa.manualInstallTitle")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground mt-2">
                <p>{t("pwa.installUnavailableHint")}</p>
                <ol className="list-decimal list-inside space-y-2">
                  <li>{t("pwa.chromeStep1")}</li>
                  <li>{t("pwa.chromeStep2")}</li>
                  <li>{t("pwa.androidStep1")}</li>
                </ol>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setManualGuideOpen(false)}>
              {t("pwa.iosGotIt")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
