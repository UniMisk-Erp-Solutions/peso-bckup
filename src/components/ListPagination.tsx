import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getVisiblePageNumbers, getPaginationRange, getTotalPages } from "@/lib/listPagination";
import { useTranslation } from "@/i18n";

export type PageSizeOption = 10 | 25 | 50 | 100;
export const PAGE_SIZE_OPTIONS: PageSizeOption[] = [10, 25, 50, 100];

interface ListPaginationProps {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: PageSizeOption[];
  className?: string;
}

export function ListPagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
  className = "",
}: ListPaginationProps) {
  const { t } = useTranslation("common");
  const totalPages = getTotalPages(totalItems, pageSize);
  const { from, to, total } = getPaginationRange(page, pageSize, totalItems);
  const visiblePages = getVisiblePageNumbers(page, totalPages);

  if (totalItems === 0) return null;

  return (
    <div className={`flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t ${className}`}>
      {/* Rows per page + range label */}
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="hidden sm:inline whitespace-nowrap">
          {t("pagination.rowsPerPage", { defaultValue: "Rows per page" })}
        </span>
        <Select value={String(pageSize)} onValueChange={(v) => { onPageSizeChange(Number(v)); onPageChange(1); }}>
          <SelectTrigger className="h-8 w-[72px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent side="top">
            {pageSizeOptions.map((s) => (
              <SelectItem key={s} value={String(s)}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="whitespace-nowrap">
          {t("pagination.showing", {
            defaultValue: "{{from}}–{{to}} of {{total}}",
            from,
            to,
            total,
          })}
        </span>
      </div>

      {/* Page buttons */}
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={page <= 1}
          onClick={() => onPageChange(1)}
          aria-label={t("pagination.firstPage", { defaultValue: "First page" })}
        >
          <ChevronFirst className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label={t("pagination.previousPage", { defaultValue: "Previous page" })}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        {visiblePages.map((p, i) =>
          p === -1 ? (
            <span key={`ellipsis-${i}`} className="px-1 text-muted-foreground text-sm select-none">…</span>
          ) : (
            <Button
              key={p}
              variant={p === page ? "default" : "outline"}
              size="icon"
              className="h-8 w-8 text-sm"
              onClick={() => onPageChange(p)}
              aria-current={p === page ? "page" : undefined}
            >
              {p}
            </Button>
          ),
        )}

        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label={t("pagination.nextPage", { defaultValue: "Next page" })}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={page >= totalPages}
          onClick={() => onPageChange(totalPages)}
          aria-label={t("pagination.lastPage", { defaultValue: "Last page" })}
        >
          <ChevronLast className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
