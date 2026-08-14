import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { format, subDays, subMonths, startOfDay } from "date-fns";
import { Calendar, ChevronDown, Filter, X, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { type DateBasis, type DatePreset, type Granularity } from "@/lib/analytics/expenseAnalytics";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalyticsFilters {
  preset: DatePreset;
  dateFrom: string;
  dateTo: string;
  dateBasis: DateBasis;
  granularity: Granularity;
  compareEnabled: boolean;
  statuses: string[];
  categories: string[];
  selectedEmployeeId: string | null;
  selectedDestination: string | null;
}

export interface AnalyticsFilterBarProps {
  filters: AnalyticsFilters;
  onChange: (filters: AnalyticsFilters) => void;
  /** Available values for dropdowns — derived from loaded data */
  availableCategories: string[];
  availableDestinations: string[];
  availableEmployees: Array<{ user_id: string; name: string; employee_id?: string | null }>;
  /** Only admins see the employee filter */
  isAdmin: boolean;
  disabled?: boolean;
}

const ALL_STATUSES = [
  "submitted",
  "under_review",
  "level_1_verified",
  "level_2_verified",
  "verified",
  "edited",
  "approved",
  "paid",
  "rejected",
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function today(): string {
  return format(new Date(), "yyyy-MM-dd");
}

export function presetToRange(preset: DatePreset): { dateFrom: string; dateTo: string } {
  const to = today();
  const now = new Date();
  if (preset === "7d") return { dateFrom: format(subDays(now, 6), "yyyy-MM-dd"), dateTo: to };
  if (preset === "30d") return { dateFrom: format(subDays(now, 29), "yyyy-MM-dd"), dateTo: to };
  if (preset === "90d") return { dateFrom: format(subDays(now, 89), "yyyy-MM-dd"), dateTo: to };
  if (preset === "6m") return { dateFrom: format(subMonths(now, 6), "yyyy-MM-dd"), dateTo: to };
  if (preset === "12m") return { dateFrom: format(subMonths(now, 12), "yyyy-MM-dd"), dateTo: to };
  return { dateFrom: format(subDays(now, 29), "yyyy-MM-dd"), dateTo: to };
}

export function defaultFilters(): AnalyticsFilters {
  const { dateFrom, dateTo } = presetToRange("30d");
  return {
    preset: "30d",
    dateFrom,
    dateTo,
    dateBasis: "expense_date",
    granularity: "auto",
    compareEnabled: false,
    statuses: [],
    categories: [],
    selectedEmployeeId: null,
    selectedDestination: null,
  };
}

export function countActiveFilters(f: AnalyticsFilters): number {
  let n = 0;
  if (f.statuses.length > 0) n++;
  if (f.categories.length > 0) n++;
  if (f.selectedEmployeeId) n++;
  if (f.selectedDestination) n++;
  if (f.dateBasis !== "expense_date") n++;
  if (f.granularity !== "auto") n++;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preset selector (desktop pill row)
// ─────────────────────────────────────────────────────────────────────────────

const PRESETS: Array<{ key: DatePreset; labelKey: string }> = [
  { key: "7d", labelKey: "filters.last7Days" },
  { key: "30d", labelKey: "filters.last30Days" },
  { key: "90d", labelKey: "filters.last90Days" },
  { key: "6m", labelKey: "filters.last6Months" },
  { key: "12m", labelKey: "filters.last12Months" },
  { key: "custom", labelKey: "filters.custom" },
];

function PresetPills({
  current,
  onChange,
  disabled,
}: {
  current: DatePreset;
  onChange: (p: DatePreset) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("analytics");
  return (
    <div className="flex flex-wrap gap-1.5">
      {PRESETS.map(({ key, labelKey }) => (
        <button
          key={key}
          disabled={disabled}
          onClick={() => onChange(key)}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-medium transition-colors border",
            current === key
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        >
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom date range inputs (shown when preset === "custom")
// ─────────────────────────────────────────────────────────────────────────────

function CustomDateRange({
  dateFrom,
  dateTo,
  onChange,
  disabled,
}: {
  dateFrom: string;
  dateTo: string;
  onChange: (from: string, to: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("analytics");
  return (
    <div className="flex flex-wrap gap-2 items-center">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs text-muted-foreground whitespace-nowrap">{t("filters.from")}</Label>
        <Input
          type="date"
          value={dateFrom}
          max={dateTo}
          disabled={disabled}
          className="h-7 text-xs w-36"
          onChange={(e) => onChange(e.target.value, dateTo)}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <Label className="text-xs text-muted-foreground whitespace-nowrap">{t("filters.to")}</Label>
        <Input
          type="date"
          value={dateTo}
          min={dateFrom}
          max={today()}
          disabled={disabled}
          className="h-7 text-xs w-36"
          onChange={(e) => onChange(dateFrom, e.target.value)}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-select dropdown (statuses / categories)
// ─────────────────────────────────────────────────────────────────────────────

function MultiSelectDropdown({
  label,
  allLabel,
  items,
  selected,
  onToggle,
  onClear,
  disabled,
}: {
  label: string;
  allLabel: string;
  items: string[];
  selected: string[];
  onToggle: (v: string) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const active = selected.length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={active ? "default" : "outline"}
          size="sm"
          disabled={disabled}
          className="h-7 gap-1 text-xs"
        >
          {label}
          {active && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px] leading-none ml-0.5">
              {selected.length}
            </Badge>
          )}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel className="text-xs">{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ScrollArea className="max-h-56">
          {items.map((item) => (
            <DropdownMenuCheckboxItem
              key={item}
              checked={selected.includes(item)}
              onCheckedChange={() => onToggle(item)}
              className="text-xs"
            >
              {item}
            </DropdownMenuCheckboxItem>
          ))}
        </ScrollArea>
        {active && (
          <>
            <DropdownMenuSeparator />
            <button
              onClick={onClear}
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" /> {allLabel}
            </button>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-select dropdown (employee / destination)
// ─────────────────────────────────────────────────────────────────────────────

function SingleSelectDropdown({
  label,
  allLabel,
  items,
  selected,
  onSelect,
  searchPlaceholder,
  disabled,
}: {
  label: string;
  allLabel: string;
  items: Array<{ value: string; label: string }>;
  selected: string | null;
  onSelect: (v: string | null) => void;
  searchPlaceholder?: string;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const filtered = search
    ? items.filter((i) => i.label.toLowerCase().includes(search.toLowerCase()))
    : items;
  const active = !!selected;
  const displayLabel = selected ? (items.find((i) => i.value === selected)?.label ?? label) : label;

  return (
    <DropdownMenu onOpenChange={(o) => { if (!o) setSearch(""); }}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={active ? "default" : "outline"}
          size="sm"
          disabled={disabled}
          className="h-7 gap-1 text-xs max-w-[160px]"
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronDown className="h-3 w-3 opacity-60 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <div className="p-1">
          <Input
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs"
          />
        </div>
        <DropdownMenuSeparator />
        <ScrollArea className="max-h-52">
          <DropdownMenuRadioGroup
            value={selected ?? ""}
            onValueChange={(v) => onSelect(v === "" ? null : v)}
          >
            <DropdownMenuRadioItem value="" className="text-xs text-muted-foreground">
              {allLabel}
            </DropdownMenuRadioItem>
            {filtered.map((item) => (
              <DropdownMenuRadioItem key={item.value} value={item.value} className="text-xs">
                {item.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main filter bar
// ─────────────────────────────────────────────────────────────────────────────

export function AnalyticsFilterBar({
  filters,
  onChange,
  availableCategories,
  availableDestinations,
  availableEmployees,
  isAdmin,
  disabled = false,
}: AnalyticsFilterBarProps) {
  const { t } = useTranslation("analytics");

  const update = useCallback(
    (partial: Partial<AnalyticsFilters>) => onChange({ ...filters, ...partial }),
    [filters, onChange],
  );

  const handlePreset = useCallback(
    (preset: DatePreset) => {
      if (preset === "custom") {
        update({ preset });
      } else {
        update({ preset, ...presetToRange(preset) });
      }
    },
    [update],
  );

  const toggleStatus = useCallback(
    (s: string) => {
      const next = filters.statuses.includes(s)
        ? filters.statuses.filter((x) => x !== s)
        : [...filters.statuses, s];
      update({ statuses: next });
    },
    [filters.statuses, update],
  );

  const toggleCategory = useCallback(
    (c: string) => {
      const next = filters.categories.includes(c)
        ? filters.categories.filter((x) => x !== c)
        : [...filters.categories, c];
      update({ categories: next });
    },
    [filters.categories, update],
  );

  const handleReset = useCallback(() => onChange(defaultFilters()), [onChange]);

  const activeCount = countActiveFilters(filters);
  const employeeItems = availableEmployees.map((e) => ({
    value: e.user_id,
    label: e.employee_id ? `${e.name} (${e.employee_id})` : e.name,
  }));
  const destinationItems = availableDestinations.map((d) => ({
    value: d,
    label: d,
  }));

  return (
    <div className="flex flex-col gap-2">
      {/* Row 1: Date presets + compare toggle */}
      <div className="flex flex-wrap items-center gap-2">
        <PresetPills current={filters.preset} onChange={handlePreset} disabled={disabled} />

        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor="compare-toggle" className="text-xs text-muted-foreground cursor-pointer">
            {t("filters.compare")}
          </Label>
          <Switch
            id="compare-toggle"
            checked={filters.compareEnabled}
            onCheckedChange={(v) => update({ compareEnabled: v })}
            disabled={disabled}
          />
        </div>
      </div>

      {/* Custom date range — shown only when preset === "custom" */}
      {filters.preset === "custom" && (
        <CustomDateRange
          dateFrom={filters.dateFrom}
          dateTo={filters.dateTo}
          onChange={(from, to) => update({ dateFrom: from, dateTo: to })}
          disabled={disabled}
        />
      )}

      {/* Row 2: Granularity | Date basis | dimension filters | More (Sheet) */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Granularity */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={disabled} className="h-7 gap-1 text-xs">
              {t(`filters.${filters.granularity}`)}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="text-xs">{t("filters.granularity")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={filters.granularity}
              onValueChange={(v) => update({ granularity: v as Granularity })}
            >
              {(["auto", "daily", "weekly", "monthly"] as Granularity[]).map((g) => (
                <DropdownMenuRadioItem key={g} value={g} className="text-xs">
                  {t(`filters.${g}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Date basis */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={filters.dateBasis !== "expense_date" ? "default" : "outline"}
              size="sm"
              disabled={disabled}
              className="h-7 gap-1 text-xs"
            >
              <Calendar className="h-3 w-3" />
              {t(`filters.${filters.dateBasis === "expense_date" ? "expenseDate" : "submittedDate"}`)}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="text-xs">{t("filters.dateBasis")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={filters.dateBasis}
              onValueChange={(v) => update({ dateBasis: v as DateBasis })}
            >
              <DropdownMenuRadioItem value="expense_date" className="text-xs">
                {t("filters.expenseDate")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="submitted_date" className="text-xs">
                {t("filters.submittedDate")}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Separator orientation="vertical" className="h-5" />

        {/* Status multi-select */}
        <MultiSelectDropdown
          label={t("filters.status")}
          allLabel={t("filters.allStatuses")}
          items={ALL_STATUSES}
          selected={filters.statuses}
          onToggle={toggleStatus}
          onClear={() => update({ statuses: [] })}
          disabled={disabled}
        />

        {/* Category multi-select */}
        {availableCategories.length > 0 && (
          <MultiSelectDropdown
            label={t("filters.category")}
            allLabel={t("filters.allCategories")}
            items={availableCategories}
            selected={filters.categories}
            onToggle={toggleCategory}
            onClear={() => update({ categories: [] })}
            disabled={disabled}
          />
        )}

        {/* Employee (admin only) */}
        {isAdmin && availableEmployees.length > 0 && (
          <SingleSelectDropdown
            label={t("filters.employee")}
            allLabel={t("filters.allEmployees")}
            items={employeeItems}
            selected={filters.selectedEmployeeId}
            onSelect={(v) => update({ selectedEmployeeId: v })}
            searchPlaceholder={t("filters.searchEmployees")}
            disabled={disabled}
          />
        )}

        {/* Destination */}
        {availableDestinations.length > 0 && (
          <SingleSelectDropdown
            label={t("filters.destination")}
            allLabel={t("filters.allDestinations")}
            items={destinationItems}
            selected={filters.selectedDestination}
            onSelect={(v) => update({ selectedDestination: v })}
            searchPlaceholder={t("filters.searchDestinations")}
            disabled={disabled}
          />
        )}

        {/* Mobile: all detail filters in a Sheet */}
        <Sheet>
          <SheetTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              className="h-7 gap-1 text-xs sm:hidden"
            >
              <Filter className="h-3 w-3" />
              {t("filters.filtersTitle")}
              {activeCount > 0 && (
                <Badge variant="secondary" className="h-4 px-1 text-[10px] leading-none">
                  {activeCount}
                </Badge>
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="h-[80dvh] flex flex-col">
            <SheetHeader className="shrink-0">
              <SheetTitle className="text-sm">{t("filters.filtersTitle")}</SheetTitle>
            </SheetHeader>
            <ScrollArea className="flex-1 py-2">
              <MobileFilterContent
                filters={filters}
                update={update}
                availableCategories={availableCategories}
                availableDestinations={availableDestinations}
                availableEmployees={availableEmployees}
                isAdmin={isAdmin}
              />
            </ScrollArea>
            <div className="shrink-0 pt-2 border-t flex justify-between gap-2">
              <Button variant="outline" size="sm" onClick={handleReset}>
                <RotateCcw className="h-3 w-3 mr-1" />
                {t("filters.reset")}
              </Button>
            </div>
          </SheetContent>
        </Sheet>

        {/* Reset — desktop */}
        {activeCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={disabled}
            className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground hidden sm:flex"
          >
            <RotateCcw className="h-3 w-3" />
            {t("filters.reset")}
          </Button>
        )}
      </div>

      {/* Active filter chips */}
      {activeCount > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {filters.statuses.map((s) => (
            <Badge
              key={s}
              variant="secondary"
              className="gap-1 cursor-pointer text-xs"
              onClick={() => toggleStatus(s)}
            >
              {s} <X className="h-2.5 w-2.5" />
            </Badge>
          ))}
          {filters.categories.map((c) => (
            <Badge
              key={c}
              variant="secondary"
              className="gap-1 cursor-pointer text-xs"
              onClick={() => toggleCategory(c)}
            >
              {c} <X className="h-2.5 w-2.5" />
            </Badge>
          ))}
          {filters.selectedEmployeeId && (
            <Badge
              variant="secondary"
              className="gap-1 cursor-pointer text-xs"
              onClick={() => update({ selectedEmployeeId: null })}
            >
              {employeeItems.find((e) => e.value === filters.selectedEmployeeId)?.label ??
                filters.selectedEmployeeId}{" "}
              <X className="h-2.5 w-2.5" />
            </Badge>
          )}
          {filters.selectedDestination && (
            <Badge
              variant="secondary"
              className="gap-1 cursor-pointer text-xs"
              onClick={() => update({ selectedDestination: null })}
            >
              {filters.selectedDestination} <X className="h-2.5 w-2.5" />
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile sheet content
// ─────────────────────────────────────────────────────────────────────────────

function MobileFilterContent({
  filters,
  update,
  availableCategories,
  availableDestinations,
  availableEmployees,
  isAdmin,
}: {
  filters: AnalyticsFilters;
  update: (p: Partial<AnalyticsFilters>) => void;
  availableCategories: string[];
  availableDestinations: string[];
  availableEmployees: Array<{ user_id: string; name: string; employee_id?: string | null }>;
  isAdmin: boolean;
}) {
  const { t } = useTranslation("analytics");
  const [destSearch, setDestSearch] = useState("");
  const [empSearch, setEmpSearch] = useState("");

  return (
    <div className="flex flex-col gap-5 px-1">
      {/* Date basis */}
      <div>
        <p className="text-xs font-semibold mb-2">{t("filters.dateBasis")}</p>
        <div className="flex gap-2">
          {(["expense_date", "submitted_date"] as DateBasis[]).map((b) => (
            <button
              key={b}
              onClick={() => update({ dateBasis: b })}
              className={cn(
                "rounded-full px-3 py-1 text-xs border transition-colors",
                filters.dateBasis === b
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground",
              )}
            >
              {t(b === "expense_date" ? "filters.expenseDate" : "filters.submittedDate")}
            </button>
          ))}
        </div>
      </div>

      {/* Granularity */}
      <div>
        <p className="text-xs font-semibold mb-2">{t("filters.granularity")}</p>
        <div className="flex flex-wrap gap-2">
          {(["auto", "daily", "weekly", "monthly"] as Granularity[]).map((g) => (
            <button
              key={g}
              onClick={() => update({ granularity: g })}
              className={cn(
                "rounded-full px-3 py-1 text-xs border transition-colors",
                filters.granularity === g
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground",
              )}
            >
              {t(`filters.${g}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Compare */}
      <div className="flex items-center gap-3">
        <Switch
          id="mobile-compare"
          checked={filters.compareEnabled}
          onCheckedChange={(v) => update({ compareEnabled: v })}
        />
        <Label htmlFor="mobile-compare" className="text-xs">
          {t("filters.compare")}
        </Label>
      </div>

      {/* Status */}
      <div>
        <p className="text-xs font-semibold mb-2">{t("filters.status")}</p>
        <div className="flex flex-wrap gap-1.5">
          {ALL_STATUSES.map((s) => {
            const sel = filters.statuses.includes(s);
            return (
              <button
                key={s}
                onClick={() => {
                  const next = sel
                    ? filters.statuses.filter((x) => x !== s)
                    : [...filters.statuses, s];
                  update({ statuses: next });
                }}
                className={cn(
                  "rounded-full px-3 py-1 text-xs border transition-colors",
                  sel
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground",
                )}
              >
                {s}
              </button>
            );
          })}
        </div>
      </div>

      {/* Category */}
      {availableCategories.length > 0 && (
        <div>
          <p className="text-xs font-semibold mb-2">{t("filters.category")}</p>
          <div className="flex flex-wrap gap-1.5">
            {availableCategories.map((c) => {
              const sel = filters.categories.includes(c);
              return (
                <button
                  key={c}
                  onClick={() => {
                    const next = sel
                      ? filters.categories.filter((x) => x !== c)
                      : [...filters.categories, c];
                    update({ categories: next });
                  }}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs border transition-colors",
                    sel
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Destination */}
      {availableDestinations.length > 0 && (
        <div>
          <p className="text-xs font-semibold mb-2">{t("filters.destination")}</p>
          <Input
            placeholder={t("filters.searchDestinations")}
            value={destSearch}
            onChange={(e) => setDestSearch(e.target.value)}
            className="h-7 text-xs mb-2"
          />
          <div className="flex flex-wrap gap-1.5">
            {availableDestinations
              .filter((d) => !destSearch || d.toLowerCase().includes(destSearch.toLowerCase()))
              .slice(0, 30)
              .map((d) => {
                const sel = filters.selectedDestination === d;
                return (
                  <button
                    key={d}
                    onClick={() => update({ selectedDestination: sel ? null : d })}
                    className={cn(
                      "rounded-full px-3 py-1 text-xs border transition-colors",
                      sel
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {d}
                  </button>
                );
              })}
          </div>
        </div>
      )}

      {/* Employee (admin only) */}
      {isAdmin && availableEmployees.length > 0 && (
        <div>
          <p className="text-xs font-semibold mb-2">{t("filters.employee")}</p>
          <Input
            placeholder={t("filters.searchEmployees")}
            value={empSearch}
            onChange={(e) => setEmpSearch(e.target.value)}
            className="h-7 text-xs mb-2"
          />
          <div className="flex flex-col gap-1">
            {availableEmployees
              .filter(
                (e) =>
                  !empSearch ||
                  e.name.toLowerCase().includes(empSearch.toLowerCase()) ||
                  e.employee_id?.toLowerCase().includes(empSearch.toLowerCase()),
              )
              .slice(0, 20)
              .map((e) => {
                const sel = filters.selectedEmployeeId === e.user_id;
                return (
                  <button
                    key={e.user_id}
                    onClick={() => update({ selectedEmployeeId: sel ? null : e.user_id })}
                    className={cn(
                      "text-left rounded px-2 py-1.5 text-xs border transition-colors",
                      sel
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {e.employee_id ? `${e.name} (${e.employee_id})` : e.name}
                  </button>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
