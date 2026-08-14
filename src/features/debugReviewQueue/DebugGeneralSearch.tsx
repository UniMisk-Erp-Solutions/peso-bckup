/**
 * Expense search (DOC-080 Phase 13).
 *
 * A second, fully independent control. Typing issues no request; submit is the
 * Search button or Enter. Clearing it removes ONLY the expense search — the
 * selected employee survives, so "employee 6174 + CCTV" narrows to that
 * employee's CCTV expenses and clearing the text restores all 24.
 */

import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

export function DebugGeneralSearch({
  draft,
  onDraftChange,
  onSubmit,
  onClear,
}: {
  draft: string;
  onDraftChange: (v: string) => void;
  onSubmit: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation("debugReview");

  return (
    <Card>
      <CardContent className="p-4">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <Label htmlFor="debug-general-search">{t("generalSearch.label")}</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="debug-general-search"
              data-testid="debug-general-search-input"
              value={draft}
              placeholder={t("generalSearch.placeholder")}
              autoComplete="off"
              onChange={(e) => onDraftChange(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                type="submit"
                data-testid="debug-general-search-submit"
                className="flex-1 sm:flex-none"
              >
                <Search className="mr-2 h-4 w-4" />
                {t("generalSearch.search")}
              </Button>
              <Button
                type="button"
                variant="outline"
                data-testid="debug-general-search-clear"
                onClick={onClear}
                className="flex-1 sm:flex-none"
              >
                <X className="mr-2 h-4 w-4" />
                {t("generalSearch.clear")}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t("generalSearch.help")}</p>
        </form>
      </CardContent>
    </Card>
  );
}
