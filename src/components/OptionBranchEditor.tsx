import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import type { BranchFieldType } from "@/lib/conditionalFormFieldTypes";
import {
  createDraftBranch,
  type DraftOptionBranch,
} from "@/lib/optionBranchPersistence";
import { slugifyFieldKey } from "@/lib/conditionalFormFields";

type OptionBranchEditorProps = {
  options: string[];
  drafts: DraftOptionBranch[];
  onChange: (drafts: DraftOptionBranch[]) => void;
  allowNested: boolean;
};

export function OptionBranchEditor({
  options,
  drafts,
  onChange,
  allowNested,
}: OptionBranchEditorProps) {
  const cleanedOptions = options.map((o) => o.trim()).filter(Boolean);

  const updateDraft = (localId: string, patch: Partial<DraftOptionBranch>) => {
    onChange(
      drafts.map((d) => {
        if (d.localId !== localId) return d;
        const next = { ...d, ...patch };
        if (patch.name && !patch.field_key) {
          next.field_key = slugifyFieldKey(patch.name);
        }
        return next;
      }),
    );
  };

  const removeDraft = (localId: string) => {
    const toRemove = new Set<string>([localId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of drafts) {
        if (d.parent_branch_local_id && toRemove.has(d.parent_branch_local_id) && !toRemove.has(d.localId)) {
          toRemove.add(d.localId);
          changed = true;
        }
      }
    }
    onChange(drafts.filter((d) => !toRemove.has(d.localId)));
  };

  const addRootBranch = (optionValue: string) => {
    const siblings = drafts.filter(
      (d) => d.parent_option_value === optionValue && !d.parent_branch_local_id,
    );
    onChange([...drafts, createDraftBranch(optionValue, null, siblings.length)]);
  };

  const addNestedBranch = (parentBranch: DraftOptionBranch, optionValue: string) => {
    const siblings = drafts.filter(
      (d) =>
        d.parent_branch_local_id === parentBranch.localId &&
        d.parent_option_value === optionValue,
    );
    onChange([
      ...drafts,
      createDraftBranch(optionValue, parentBranch.localId, siblings.length),
    ]);
  };

  if (cleanedOptions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Add dropdown options above to configure conditional fields per option.
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <p className="text-sm font-medium">Fields when option is selected</p>
      <p className="text-xs text-muted-foreground">
        Add sub-fields shown only when the user picks each dropdown option.
      </p>
      {cleanedOptions.map((optionValue) => (
        <OptionSection
          key={optionValue}
          optionValue={optionValue}
          rootDrafts={drafts.filter(
            (d) => d.parent_option_value === optionValue && !d.parent_branch_local_id,
          )}
          allDrafts={drafts}
          allowNested={allowNested}
          onAddRoot={() => addRootBranch(optionValue)}
          onAddNested={addNestedBranch}
          onUpdate={updateDraft}
          onRemove={removeDraft}
        />
      ))}
    </div>
  );
}

function OptionSection({
  optionValue,
  rootDrafts,
  allDrafts,
  allowNested,
  onAddRoot,
  onAddNested,
  onUpdate,
  onRemove,
}: {
  optionValue: string;
  rootDrafts: DraftOptionBranch[];
  allDrafts: DraftOptionBranch[];
  allowNested: boolean;
  onAddRoot: () => void;
  onAddNested: (parent: DraftOptionBranch, nestedOption: string) => void;
  onUpdate: (localId: string, patch: Partial<DraftOptionBranch>) => void;
  onRemove: (localId: string) => void;
}) {
  const [open, setOpen] = useState(rootDrafts.length > 0);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border rounded-md bg-background">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium hover:bg-muted/50">
        <span>
          When &quot;{optionValue}&quot; is selected
          {rootDrafts.length > 0 && (
            <span className="text-muted-foreground font-normal ml-2">
              ({rootDrafts.length} field{rootDrafts.length === 1 ? "" : "s"})
            </span>
          )}
        </span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3 space-y-3">
        {rootDrafts.map((draft) => (
          <DraftBranchCard
            key={draft.localId}
            draft={draft}
            allDrafts={allDrafts}
            allowNested={allowNested}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onAddNested={onAddNested}
          />
        ))}
        <Button type="button" variant="outline" size="sm" onClick={onAddRoot}>
          <Plus className="h-4 w-4 mr-1" />
          Add field
        </Button>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DraftBranchCard({
  draft,
  allDrafts,
  allowNested,
  onUpdate,
  onRemove,
  onAddNested,
}: {
  draft: DraftOptionBranch;
  allDrafts: DraftOptionBranch[];
  allowNested: boolean;
  onUpdate: (localId: string, patch: Partial<DraftOptionBranch>) => void;
  onRemove: (localId: string) => void;
  onAddNested: (parent: DraftOptionBranch, nestedOption: string) => void;
}) {
  const nestedDrafts = allDrafts.filter((d) => d.parent_branch_local_id === draft.localId);
  const selectOptions = draft.options.map((o) => o.trim()).filter(Boolean);

  return (
    <div className="border rounded-md p-3 space-y-3 bg-muted/20">
      <div className="flex justify-between items-start gap-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Conditional field
        </span>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => onRemove(draft.localId)}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Label *</Label>
          <Input
            value={draft.name}
            onChange={(e) => onUpdate(draft.localId, { name: e.target.value })}
            placeholder="e.g. Travel mode"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Type</Label>
          <Select
            value={draft.field_type}
            onValueChange={(v: BranchFieldType) => onUpdate(draft.localId, { field_type: v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="number">Number</SelectItem>
              <SelectItem value="date">Date</SelectItem>
              <SelectItem value="textarea">Textarea</SelectItem>
              <SelectItem value="select">Dropdown</SelectItem>
              <SelectItem value="checkbox">Checkbox</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <Label className="text-xs">Required</Label>
        <Switch
          checked={draft.required}
          onCheckedChange={(c) => onUpdate(draft.localId, { required: c })}
        />
      </div>

      {(draft.field_type === "select" || draft.field_type === "checkbox") && (
        <BranchFieldOptionsEditor
          options={draft.options}
          onChange={(options) => onUpdate(draft.localId, { options })}
        />
      )}

      {allowNested && draft.field_type === "select" && selectOptions.length > 0 && (
        <div className="space-y-2 pl-2 border-l-2 border-primary/20">
          <p className="text-xs font-medium">Nested fields per sub-option</p>
          {selectOptions.map((subOpt) => {
            const children = nestedDrafts.filter((d) => d.parent_option_value === subOpt);
            return (
              <div key={subOpt} className="space-y-2">
                <p className="text-xs text-muted-foreground">If &quot;{subOpt}&quot;:</p>
                {children.map((child) => (
                  <DraftBranchCard
                    key={child.localId}
                    draft={child}
                    allDrafts={allDrafts}
                    allowNested={allowNested}
                    onUpdate={onUpdate}
                    onRemove={onRemove}
                    onAddNested={onAddNested}
                  />
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onAddNested(draft, subOpt)}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add nested field
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BranchFieldOptionsEditor({
  options,
  onChange,
}: {
  options: string[];
  onChange: (options: string[]) => void;
}) {
  const [newOption, setNewOption] = useState("");

  const addOption = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (options.some((o) => o.toLowerCase() === trimmed.toLowerCase())) return;
    onChange([...options, trimmed]);
    setNewOption("");
  };

  const updateOptionAt = (index: number, value: string) => {
    const next = [...options];
    next[index] = value;
    onChange(next);
  };

  const removeOptionAt = (index: number) => {
    onChange(options.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      <Label className="text-xs">Dropdown options *</Label>
      <p className="text-xs text-muted-foreground">
        Add each choice below. Press Enter or click Add option.
      </p>
      {options.length > 0 && (
        <ul className="space-y-2">
          {options.map((opt, index) => (
            <li key={`opt-${index}`} className="flex items-center gap-2">
              <Input
                value={opt}
                onChange={(e) => updateOptionAt(index, e.target.value)}
                placeholder={`Option ${index + 1}`}
                className="h-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0"
                onClick={() => removeOptionAt(index)}
                aria-label={`Remove option ${index + 1}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={newOption}
          onChange={(e) => setNewOption(e.target.value)}
          placeholder="Type option and press Enter"
          className="h-9"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addOption(newOption);
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 h-9"
          onClick={() => addOption(newOption)}
          disabled={!newOption.trim()}
        >
          <Plus className="h-4 w-4 mr-1" />
          Add option
        </Button>
      </div>
    </div>
  );
}
