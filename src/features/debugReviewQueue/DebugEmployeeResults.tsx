/**
 * Ambiguous-match picker (DOC-080 Phase 12).
 *
 * Shown only when the search returned more than one candidate. No expenses load
 * until a human picks one — merging candidates automatically is what produced
 * the wrong-employee results this page exists to disprove.
 */

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatEmployeeIdentity } from "./types";
import type { DebugEmployeeMatch } from "./types";

const KNOWN_MATCH_TYPES = new Set([
  "exact_employee_id",
  "exact_employee_name",
  "name_prefix",
  "name_contains",
  "exact_email",
]);

export function DebugEmployeeResults({
  matches,
  onSelect,
}: {
  matches: DebugEmployeeMatch[];
  onSelect: (m: DebugEmployeeMatch) => void;
}) {
  const { t } = useTranslation("debugReview");
  if (matches.length === 0) return null;

  return (
    <Card data-testid="debug-employee-results">
      <CardContent className="space-y-3 p-4">
        <div>
          <p className="font-medium">{t("employeeSearch.multipleFound")}</p>
          <p className="text-xs text-muted-foreground">{t("employeeSearch.multipleFoundHint")}</p>
        </div>

        <ul className="space-y-2">
          {matches.map((m) => {
            const identity = formatEmployeeIdentity(m);
            const matchKey = KNOWN_MATCH_TYPES.has(m.match_type) ? m.match_type : "unknown";
            return (
              <li
                key={m.user_id}
                className="flex flex-wrap items-center gap-3 rounded-md border p-3"
                data-testid={`debug-employee-result-${m.user_id}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{identity.primary}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {m.employee_id ? `ID ${m.employee_id}` : null}
                    {m.employee_id && m.employee_email ? " · " : null}
                    {m.employee_email}
                  </p>
                </div>
                <Badge variant="secondary">
                  {m.visible_expense_count} {t("employeeSearch.visibleExpenses")}
                </Badge>
                <Badge variant="outline">
                  {m.actionable_expense_count} {t("employeeSearch.actionableExpenses")}
                </Badge>
                <Badge variant="outline" className="font-normal">
                  {t(`employeeSearch.matchType.${matchKey}`)}
                </Badge>
                <Button
                  size="sm"
                  data-testid={`debug-employee-select-${m.user_id}`}
                  onClick={() => onSelect(m)}
                >
                  {t("employeeSearch.select")}
                </Button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
