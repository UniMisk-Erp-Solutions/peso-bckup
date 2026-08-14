import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelectField } from "@/components/SearchableSelectField";
import { Badge } from "@/components/ui/badge";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";
import type { VisibleBranch } from "@/lib/conditionalFormFields";
import { cn } from "@/lib/utils";
import { fieldRecKey } from "@/lib/recommendedFormFieldOptions";

type BranchFieldInputsProps = {
  visibleBranches: VisibleBranch[];
  branchValues: Record<string, string>;
  onBranchChange: (branchId: string, value: string) => void;
  idPrefix?: string;
  recommendedByKey?: Record<string, string[]>;
};

export function BranchFieldInputs({
  visibleBranches,
  branchValues,
  onBranchChange,
  idPrefix = "branch",
  recommendedByKey = {},
}: BranchFieldInputsProps) {
  if (visibleBranches.length === 0) return null;

  return (
    <div className="space-y-3 pl-3 border-l-2 border-primary/20">
      {visibleBranches.map(({ branch, depth }) => (
        <BranchFieldRow
          key={branch.id}
          branch={branch}
          depth={depth}
          value={branchValues[branch.id] ?? ""}
          onChange={(val) => onBranchChange(branch.id, val)}
          idPrefix={idPrefix}
          recommendedOptions={recommendedByKey[fieldRecKey("branch", branch.id)] ?? []}
        />
      ))}
    </div>
  );
}

function BranchFieldRow({
  branch,
  depth,
  value,
  onChange,
  idPrefix,
  recommendedOptions = [],
}: {
  branch: OptionBranchDefinition;
  depth: number;
  value: string;
  onChange: (value: string) => void;
  idPrefix: string;
  recommendedOptions?: string[];
}) {
  const fieldId = `${idPrefix}-${branch.id}`;
  const isRequired = branch.required;

  return (
    <div className={cn("space-y-1.5", depth > 1 && "ml-2")}>
      <Label htmlFor={fieldId} className="text-sm">
        {branch.name}
        {isRequired && <span className="text-destructive ml-1">*</span>}
        {depth > 1 && (
          <Badge variant="outline" className="ml-2 text-[10px] py-0">
            Level {depth}
          </Badge>
        )}
      </Label>

      {branch.field_type === "text" && (
        <Input
          id={fieldId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={branch.placeholder || ""}
          required={isRequired}
        />
      )}

      {branch.field_type === "number" && (
        <Input
          id={fieldId}
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={branch.placeholder || ""}
          required={isRequired}
        />
      )}

      {branch.field_type === "date" && (
        <Input
          id={fieldId}
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={isRequired}
        />
      )}

      {branch.field_type === "textarea" && (
        <Textarea
          id={fieldId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={branch.placeholder || ""}
          required={isRequired}
          rows={2}
        />
      )}

      {branch.field_type === "select" && (
        <SearchableSelectField
          id={fieldId}
          value={value}
          onValueChange={onChange}
          options={branch.options || []}
          recentOptions={recommendedOptions}
          placeholder={branch.placeholder || "Select an option"}
        />
      )}

      {branch.field_type === "checkbox" && (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id={fieldId}
            checked={value === "true"}
            onChange={(e) => onChange(e.target.checked ? "true" : "false")}
            className="rounded"
          />
          <Label htmlFor={fieldId} className="font-normal cursor-pointer">
            {branch.placeholder || "Yes"}
          </Label>
        </div>
      )}

      {branch.help_text && (
        <p className="text-xs text-muted-foreground">{branch.help_text}</p>
      )}
    </div>
  );
}

