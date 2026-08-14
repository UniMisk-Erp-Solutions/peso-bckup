/**
 * Ambiguous-match popover (DOC-080 §8).
 *
 * A compact list anchored directly under the search field — not a second large
 * section. Nothing loads until a human picks, because merging candidates
 * automatically is how the wrong employee's rows appeared in the first place.
 *
 * The last row is always the escape hatch: treat the text as an expense search.
 */

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { formatEmployeeIdentity } from "@/features/reviewQueueServer/types";
import type { ReviewEmployeeMatch } from "@/features/reviewQueueServer/types";

export function ReviewEmployeeResultsPopover({
  matches,
  submitted,
  onSelect,
  onSearchExpensesInstead,
  onDismiss,
}: {
  matches: ReviewEmployeeMatch[];
  submitted: string | null;
  onSelect: (m: ReviewEmployeeMatch) => void;
  onSearchExpensesInstead: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("admin");
  if (matches.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label={t("review.employeeMatches")}
      className="absolute z-40 mt-1 w-full rounded-md border bg-popover shadow-md"
      data-testid="review-employee-popover"
      onKeyDown={(e) => {
        if (e.key === "Escape") onDismiss();
      }}
    >
      <p className="px-3 pt-2 text-xs text-muted-foreground">{t("review.multipleEmployees")}</p>
      <ul className="max-h-64 overflow-y-auto py-1">
        {matches.map((m) => {
          const identity = formatEmployeeIdentity(m);
          return (
            <li key={m.user_id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => onSelect(m)}
                data-testid={`review-employee-option-${m.user_id}`}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{identity.primary}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {m.employee_id ? `${t("review.employeeIdShort")} ${m.employee_id}` : ""}
                  </span>
                </span>
                {/* No expense count here: the disambiguation picker chooses an
                    IDENTITY, and the employee-search response's count is not the
                    filtered Review result — showing it risks a confidently-wrong
                    number (§6). */}
                <span className="shrink-0 text-xs font-medium text-primary">
                  {t("review.select")}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="border-t p-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start text-xs"
          onClick={onSearchExpensesInstead}
          data-testid="review-search-expenses-instead"
        >
          {t("review.searchExpensesInstead", { term: submitted ?? "" })}
        </Button>
      </div>
    </div>
  );
}
