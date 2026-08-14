/**
 * The filter row (DOC-080 §11).
 *
 * Same widths, same order, same Select styling as EngineerReview. The only
 * change is that every predicate now travels to the server instead of filtering
 * rows already in the browser — which is what made "filters only search loaded
 * expenses" true in V1.
 *
 * Sort is a single explicit enum here rather than a field + direction toggle,
 * because the server contract needs one value and a mismatched pair is how a
 * cursor ends up pointing into a different ordering.
 */

import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { REVIEW_QUEUE_SORTS } from "@/features/reviewQueueServer/types";
import type { ReviewQueueSort, ReviewTimePeriod } from "@/features/reviewQueueServer/types";

const ALL = "all";

export function ReviewFilters({
  status,
  onStatus,
  sort,
  onSort,
  timePeriod,
  onTimePeriod,
  categories,
  category,
  onCategory,
}: {
  status: string;
  onStatus: (v: string) => void;
  sort: ReviewQueueSort;
  onSort: (v: ReviewQueueSort) => void;
  timePeriod: ReviewTimePeriod;
  onTimePeriod: (v: ReviewTimePeriod) => void;
  categories: string[];
  category: string;
  onCategory: (v: string) => void;
}) {
  const { t } = useTranslation(["admin", "expenses"]);

  return (
    <>
      <div className="w-full sm:w-40">
        <Select value={status} onValueChange={onStatus}>
          <SelectTrigger data-testid="review-filter-status">
            <SelectValue placeholder="All Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Status</SelectItem>
            <SelectItem value="submitted">Submitted</SelectItem>
            <SelectItem value="edited">Adjusted</SelectItem>
            <SelectItem value="under_review">Under Review</SelectItem>
            <SelectItem value="level_1_verified">
              {t("expenses:status.level1Verified")}
            </SelectItem>
            <SelectItem value="level_2_verified">
              {t("expenses:status.level2Verified")}
            </SelectItem>
            <SelectItem value="verified">Verified</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="w-full sm:w-52">
        <Select value={sort} onValueChange={(v) => onSort(v as ReviewQueueSort)}>
          <SelectTrigger data-testid="review-filter-sort">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            {REVIEW_QUEUE_SORTS.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`admin:review.sorts.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="w-full sm:w-40">
        <Select value={timePeriod} onValueChange={(v) => onTimePeriod(v as ReviewTimePeriod)}>
          <SelectTrigger data-testid="review-filter-period">
            <SelectValue placeholder="Time Period" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Time</SelectItem>
            <SelectItem value="week">Past Week</SelectItem>
            <SelectItem value="month">Past Month</SelectItem>
            <SelectItem value="year">Past Year</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {categories.length > 0 && (
        <div className="w-full sm:w-40">
          <Select value={category} onValueChange={onCategory}>
            <SelectTrigger data-testid="review-filter-category">
              <SelectValue placeholder={t("admin:review.allCategories")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("admin:review.allCategories")}</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </>
  );
}
