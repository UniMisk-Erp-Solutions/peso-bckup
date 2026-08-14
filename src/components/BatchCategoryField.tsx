import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { RecommendedSelectOptions } from "@/components/RecommendedSelectOptions";

type BatchCategoryFieldProps = {
  label: string;
  required?: boolean;
  value: string;
  categories: string[];
  recommendedCategories: string[];
  onChange: (category: string) => void;
  compact?: boolean;
};

export function BatchCategoryField({
  label,
  required,
  value,
  categories,
  recommendedCategories,
  onChange,
  compact = false,
}: BatchCategoryFieldProps) {
  const topThree = recommendedCategories.slice(0, 3);

  return (
    <div className={cn("space-y-2", compact && "min-w-[140px]")}>
      <Label className={compact ? "text-xs" : undefined}>
        {label}
        {required ? " *" : ""}
      </Label>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger className={compact ? "h-9 text-sm" : undefined}>
          <SelectValue placeholder="Select category" />
        </SelectTrigger>
        <SelectContent>
          {categories.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RecommendedSelectOptions
        options={topThree}
        selectedValue={value}
        onSelect={onChange}
        compact={compact}
      />
    </div>
  );
}
