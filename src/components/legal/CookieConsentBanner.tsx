import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getConsent, setConsent, hasConsentBeenSet } from "@/lib/consent";

type ConsentContextValue = { openPreferences: () => void };
const ConsentContext = createContext<ConsentContextValue | null>(null);

export function useConsent(): ConsentContextValue | null {
  return useContext(ConsentContext);
}

export function CookieConsentProvider({ children }: { children: React.ReactNode }) {
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const openPreferences = useCallback(() => setCustomizeOpen(true), []);

  return (
    <ConsentContext.Provider value={{ openPreferences }}>
      {children}
      <CookieConsentBannerInner
        customizeOpen={customizeOpen}
        onOpenCustomize={() => setCustomizeOpen(true)}
        onCloseCustomize={() => setCustomizeOpen(false)}
      />
    </ConsentContext.Provider>
  );
}

function CookieConsentBannerInner({
  customizeOpen,
  onOpenCustomize,
  onCloseCustomize,
}: {
  customizeOpen: boolean;
  onOpenCustomize: () => void;
  onCloseCustomize: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    setVisible(!hasConsentBeenSet());
  }, []);

  useEffect(() => {
    if (customizeOpen) {
      const c = getConsent();
      setAnalytics(c?.analytics ?? false);
      setMarketing(c?.marketing ?? false);
    }
  }, [customizeOpen]);

  const acceptAll = useCallback(() => {
    setConsent({ analytics: true, marketing: true });
    setVisible(false);
  }, []);

  const rejectNonEssential = useCallback(() => {
    setConsent({ analytics: false, marketing: false });
    setVisible(false);
  }, []);

  const openCustomize = useCallback(() => {
    onOpenCustomize();
  }, [onOpenCustomize]);

  const saveCustomize = useCallback(() => {
    setConsent({ analytics, marketing });
    setVisible(false);
    onCloseCustomize();
  }, [analytics, marketing, onCloseCustomize]);

  if (!visible && !customizeOpen) return null;

  return (
    <>
      {visible && (
        <div
          className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-card/95 backdrop-blur p-4 shadow-lg"
          role="dialog"
          aria-label="Cookie consent"
        >
          <div className="mx-auto max-w-4xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              We use cookies for necessary site operation and, with your consent, for analytics and
              marketing. See our{" "}
              <Link to="/cookies" className="text-primary underline hover:no-underline">
                Cookie Policy
              </Link>
              .
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={rejectNonEssential}>
                Reject non-essential
              </Button>
              <Button size="sm" variant="outline" onClick={openCustomize}>
                Customize
              </Button>
              <Button size="sm" onClick={acceptAll}>
                Accept all
              </Button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={customizeOpen} onOpenChange={(open) => !open && onCloseCustomize()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cookie preferences</DialogTitle>
            <DialogDescription>
              Choose which cookies you allow. Necessary cookies are always on.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="necessary" className="flex-1 text-sm font-medium">
                Necessary
              </Label>
              <Switch id="necessary" checked disabled className="opacity-70" />
            </div>
            <p className="text-xs text-muted-foreground">
              Required for the site to work. Cannot be disabled.
            </p>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="analytics" className="flex-1 text-sm font-medium">
                Analytics
              </Label>
              <Switch
                id="analytics"
                checked={analytics}
                onCheckedChange={setAnalytics}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Helps us understand how visitors use the site (e.g. page views). We do not run
              analytics by default until you consent.
            </p>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="marketing" className="flex-1 text-sm font-medium">
                Marketing
              </Label>
              <Switch
                id="marketing"
                checked={marketing}
                onCheckedChange={setMarketing}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Used for relevant offers and marketing (e.g. email campaigns).
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onCloseCustomize}>
              Cancel
            </Button>
            <Button onClick={saveCustomize}>Save preferences</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
