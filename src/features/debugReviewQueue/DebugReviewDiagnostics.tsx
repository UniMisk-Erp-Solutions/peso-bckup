/**
 * Diagnostics panel (DOC-080 Phase 20).
 *
 * Collapsed by default. Everything shown comes from buildRedactedDiagnostics,
 * which masks ids and cannot emit a credential — the copy button therefore
 * produces something safe to paste into a ticket.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { DebugDiagnostics } from "./hooks/useDebugReviewDiagnostics";

export function DebugReviewDiagnostics({
  diagnostics,
  text,
  defaultOpen = false,
}: {
  diagnostics: DebugDiagnostics;
  text: string;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation("debugReview");
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied — the values remain readable on screen.
      setCopied(false);
    }
  };

  return (
    <Card data-testid="debug-diagnostics">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2"
            onClick={() => setOpen((v) => !v)}
            data-testid="debug-diagnostics-toggle"
            aria-expanded={open}
          >
            {open ? (
              <ChevronDown className="mr-1 h-4 w-4" />
            ) : (
              <ChevronRight className="mr-1 h-4 w-4" />
            )}
            {t("diagnostics.title")}
          </Button>

          <Button variant="outline" size="sm" onClick={copy} data-testid="debug-diagnostics-copy">
            <Copy className="mr-1 h-3.5 w-3.5" />
            {copied ? t("diagnostics.copied") : t("diagnostics.copy")}
          </Button>
        </div>

        {open && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">{t("diagnostics.redactionNote")}</p>
            <dl
              className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3"
              data-testid="debug-diagnostics-body"
            >
              {Object.entries(diagnostics).map(([k, v]) => (
                <div key={k} className="flex gap-2 border-b py-1">
                  <dt className="min-w-[9rem] font-mono text-muted-foreground">{k}</dt>
                  <dd className="break-all font-mono">{v === null ? "null" : String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
