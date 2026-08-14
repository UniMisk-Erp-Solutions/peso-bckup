/**
 * Employee search control (DOC-080 Phase 12).
 *
 * THE requirement: typing issues zero network requests. The input is bound to
 * `draft`, which nothing observes — no effect watches it, and there is no
 * debounce, because a debounce still fires while typing. The RPC runs only from
 * `onSubmit`, which the Search button and Enter both call.
 */

import { useTranslation } from "react-i18next";
import { Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { EmployeeSearchState } from "./hooks/useDebugEmployeeSearch";
import type { DebugSelectedEmployee } from "./types";

export function DebugEmployeeSearch({
  draft,
  onDraftChange,
  onSubmit,
  onClear,
  state,
  selected,
  submitted,
}: {
  draft: string;
  onDraftChange: (v: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  state: EmployeeSearchState;
  selected: DebugSelectedEmployee | null;
  submitted: string | null;
}) {
  const { t } = useTranslation("debugReview");
  const searching = state === "searching";

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            // Enter inside the input submits the form; this is the ONLY other
            // path to the RPC besides the Search button.
            e.preventDefault();
            onSubmit();
          }}
        >
          <Label htmlFor="debug-employee-search">{t("employeeSearch.label")}</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="debug-employee-search"
              data-testid="debug-employee-search-input"
              value={draft}
              placeholder={t("employeeSearch.placeholder")}
              autoComplete="off"
              onChange={(e) => onDraftChange(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                type="submit"
                data-testid="debug-employee-search-submit"
                disabled={searching}
                className="flex-1 sm:flex-none"
              >
                {searching ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Search className="mr-2 h-4 w-4" />
                )}
                {t("employeeSearch.search")}
              </Button>
              <Button
                type="button"
                variant="outline"
                data-testid="debug-employee-search-clear"
                onClick={onClear}
                className="flex-1 sm:flex-none"
              >
                <X className="mr-2 h-4 w-4" />
                {t("employeeSearch.clear")}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t("employeeSearch.help")}</p>
        </form>

        {searching && (
          <p className="text-sm text-muted-foreground" data-testid="debug-employee-searching">
            {t("employeeSearch.searching")}
          </p>
        )}

        {state === "not_found" && (
          <p className="text-sm text-destructive" data-testid="debug-employee-not-found">
            {t("employeeSearch.notFoundHint", { query: submitted ?? "" })}
          </p>
        )}

        {selected && (
          <div
            className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 p-3"
            data-testid="debug-selected-employee"
          >
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{t("employeeSearch.selected")}</p>
              <p className="truncate font-medium">
                {selected.employee_name}
                {selected.employee_id ? ` · ${selected.employee_id}` : ""}
              </p>
            </div>
            <Badge variant="secondary" data-testid="debug-selected-visible-count">
              {selected.visible_expense_count} {t("employeeSearch.visibleExpenses")}
            </Badge>
            <Badge variant="outline">
              {selected.actionable_expense_count} {t("employeeSearch.actionableExpenses")}
            </Badge>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              data-testid="debug-clear-employee"
              onClick={onClear}
            >
              {t("employeeSearch.clearEmployee")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
