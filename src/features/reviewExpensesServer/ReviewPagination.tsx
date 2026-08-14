/**
 * Pagination (DOC-080 §9–§10).
 *
 * Same visual style as the existing controls — ‹ Prev, numeric buttons, Next ›.
 * Quick links now cover 1/2/3, the last page and the current neighbours, so a
 * 298-page result is navigable without walking every page.
 *
 * A page whose cursor is already cached is reached directly; anything else costs
 * one anchor RPC then one page RPC. The ordinary Next/Previous flow stays a
 * single keyset request — no OFFSET is involved in it.
 *
 * Navigation is disabled while a request is in flight so a double-click cannot
 * queue two jumps.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildPageLinks, validatePageInput } from "./pageLinks";

export function ReviewPagination({
  pageNumber,
  pageSize,
  returned,
  filteredTotal,
  totalPages,
  hasMore,
  canGoPrevious,
  busy,
  jumpEnabled,
  onPrevious,
  onNext,
  onGoToPage,
}: {
  pageNumber: number;
  pageSize: number;
  returned: number;
  filteredTotal: number;
  totalPages: number;
  hasMore: boolean;
  canGoPrevious: boolean;
  busy: boolean;
  /** False when the server has no page-anchor function; jumps stay hidden. */
  jumpEnabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onGoToPage: (page: number) => void;
}) {
  const { t } = useTranslation("admin");
  const [pageInput, setPageInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const from = returned === 0 ? 0 : (pageNumber - 1) * pageSize + 1;
  const to = returned === 0 ? 0 : from + returned - 1;
  const links = jumpEnabled ? buildPageLinks(pageNumber, totalPages) : [pageNumber];

  const submitJump = () => {
    const result = validatePageInput(pageInput, totalPages);
    if (!result.ok) {
      setInputError(t(`review.pageInput.${result.error}`, { total: totalPages }));
      return;
    }
    setInputError(null);
    if (result.page !== pageNumber) onGoToPage(result.page);
  };

  return (
    <div
      className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between text-sm"
      data-testid="review-pagination"
    >
      <p className="text-muted-foreground" data-testid="review-pagination-summary">
        {t("review.showingRange", { from, to, total: filteredTotal })}
      </p>

      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={onPrevious}
          disabled={!canGoPrevious || busy}
          data-testid="review-page-previous"
        >
          ‹ Prev
        </Button>

        {links.map((link, i) =>
          link === "ellipsis" ? (
            <span key={`gap-${i}`} className="px-1 text-muted-foreground">
              …
            </span>
          ) : (
            <Button
              key={link}
              variant={link === pageNumber ? "default" : "outline"}
              size="sm"
              className="h-8 min-w-8 px-1 text-xs"
              onClick={() => link !== pageNumber && onGoToPage(link)}
              disabled={busy}
              aria-current={link === pageNumber ? "page" : undefined}
              data-testid={`review-page-${link}`}
            >
              {link}
            </Button>
          ),
        )}

        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={onNext}
          disabled={!hasMore || busy}
          data-testid="review-page-next"
        >
          Next ›
        </Button>

        {jumpEnabled && totalPages > 1 && (
          <form
            className="ml-2 flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              submitJump();
            }}
          >
            <Label htmlFor="review-page-input" className="text-xs text-muted-foreground">
              {t("review.pageInput.label")}
            </Label>
            <Input
              id="review-page-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={totalPages}
              value={pageInput}
              disabled={busy}
              aria-label={t("review.pageInput.aria", { total: totalPages })}
              aria-invalid={inputError ? true : undefined}
              className="h-8 w-20 text-xs"
              onChange={(e) => {
                setPageInput(e.target.value);
                if (inputError) setInputError(null);
              }}
              data-testid="review-page-input"
            />
            <Button
              // Explicit click handler rather than implicit form submission, so
              // Go behaves identically everywhere. Enter still goes through the
              // form's onSubmit; submitJump is idempotent either way.
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2 text-xs"
              disabled={busy}
              onClick={submitJump}
              data-testid="review-page-go"
            >
              {t("review.pageInput.go")}
            </Button>
          </form>
        )}
      </div>

      {inputError && (
        <p role="alert" className="text-xs text-destructive" data-testid="review-page-input-error">
          {inputError}
        </p>
      )}
    </div>
  );
}
