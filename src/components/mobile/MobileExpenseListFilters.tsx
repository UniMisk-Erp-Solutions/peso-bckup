import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ExpenseMonthOption, ExpenseMonthValue } from "@/lib/expenseMonthFilter";

const STATUS_CHIPS = [
  { value: "all", label: "All" },
  { value: "submitted", label: "Submitted" },
  { value: "verified", label: "Verified" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
] as const;

interface Props {
  searchTerm: string;
  onSearchChange: (s: string) => void;
  statusFilter: string;
  onStatusFilterChange: (s: string) => void;
  /** Exact month filter -- applies immediately, same as every other control here. */
  expenseMonth?: ExpenseMonthValue;
  monthOptions?: ExpenseMonthOption[];
  onExpenseMonthChange?: (v: ExpenseMonthValue) => void;
}

export function MobileExpenseListFilters({
  searchTerm,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  expenseMonth = "all",
  monthOptions = [{ value: "all", label: "All months" }],
  onExpenseMonthChange = () => {},
}: Props) {
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          className="pl-9 pr-9 bg-muted/50 border-border rounded-xl h-10"
          placeholder="Search expenses…"
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {searchTerm && (
          <button
            type="button"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            onClick={() => onSearchChange("")}
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        {STATUS_CHIPS.map((chip) => (
          <button
            key={chip.value}
            type="button"
            onClick={() => onStatusFilterChange(chip.value)}
            className={cn(
              "shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium border transition-colors",
              statusFilter === chip.value
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:border-primary/50",
            )}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <Select value={expenseMonth} onValueChange={(v) => onExpenseMonthChange(v as ExpenseMonthValue)}>
        <SelectTrigger className="h-9 text-xs" aria-label="Month">
          <SelectValue placeholder="Month" />
        </SelectTrigger>
        <SelectContent>
          {monthOptions.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
