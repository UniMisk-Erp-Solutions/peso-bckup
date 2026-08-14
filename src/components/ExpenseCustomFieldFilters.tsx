import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CUSTOM_FIELD_FILTER_ALL,
  isCustomFieldChoiceFilled,
  type FilterableCustomField,
} from "@/lib/expenseCustomFieldFilters";

type ExpenseCustomFieldFiltersProps = {
  fields: FilterableCustomField[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  /** When set, select/checkbox options with no employee data render in red. */
  filledValuesByField?: Record<string, Set<string>>;
  className?: string;
  hint?: string;
  emptyMessage?: string;
};

export function ExpenseCustomFieldFilters({
  fields,
  values,
  onChange,
  filledValuesByField,
  className,
  hint,
  emptyMessage,
}: ExpenseCustomFieldFiltersProps) {
  const showAvailability = Boolean(filledValuesByField);

  if (fields.length === 0) {
    return (
      <div className={className}>
        <Label className="text-sm font-semibold mb-1 block">Custom form fields</Label>
        <p className="text-xs text-muted-foreground">
          {emptyMessage ??
            "No dropdown or checkbox custom fields found. Add them under Categories → Form fields, or submit expenses that use them."}
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <Label className="text-sm font-semibold mb-1 block">Custom form fields</Label>
      {showAvailability && (
        <p className="text-xs text-muted-foreground mb-2">
          {hint ??
            "Red options have no approved expenses for this employee in the selected period."}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {fields.map((field) => (
          <div key={`${field.fieldType}-${field.key}`} className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">{field.label}</Label>
            <Select
              value={values[field.key] ?? CUSTOM_FIELD_FILTER_ALL}
              onValueChange={(next) => onChange({ ...values, [field.key]: next })}
            >
              <SelectTrigger>
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CUSTOM_FIELD_FILTER_ALL}>All</SelectItem>
                {field.choices.map((choice) => {
                  const hasData = isCustomFieldChoiceFilled(
                    field.key,
                    choice.value,
                    filledValuesByField,
                  );
                  return (
                    <SelectItem
                      key={choice.value}
                      value={choice.value}
                      className={
                        showAvailability && !hasData
                          ? "text-red-600 focus:text-red-600 focus:bg-red-50"
                          : undefined
                      }
                    >
                      {choice.label}
                      {showAvailability && !hasData ? " (no data)" : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>
    </div>
  );
}
