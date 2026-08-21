/**
 * Save-as-set / Apply-set popovers for reusable dependent-field presets.
 * Extracted to its own module (not defined inline in
 * FormFieldTemplateEditorDialog.tsx) so both the create-mode local-draft
 * flow (DependentFieldsPanel) and the server-paged flow
 * (ServerPagedParentOptionsSection, DOC-099) can import it without a
 * circular dependency between those two component files.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Save, BookOpen, RefreshCw } from "lucide-react";
import {
  getUnconfiguredOptions,
  type ApplyPresetMode,
  type PresetSummary,
  type ReusableSubFieldSet,
} from "@/lib/formBuilder/subFieldPresets";
import type { DraftOptionBranch } from "@/lib/optionBranchPersistence";

export function PresetToolbar({
  selectedParentOption,
  allOptions,
  branchDrafts,
  savedPresets,
  presetSummaries,
  presetsLoadState,
  hasSavedTemplate,
  onSavePreset,
  onApplyPreset,
}: {
  selectedParentOption: string;
  allOptions: string[];
  branchDrafts: DraftOptionBranch[];
  savedPresets: ReusableSubFieldSet[];
  presetSummaries: PresetSummary[];
  presetsLoadState: "idle" | "loading" | "success" | "error";
  hasSavedTemplate: boolean;
  onSavePreset: (name: string, description: string, includeOptions: boolean) => Promise<void>;
  onApplyPreset: (preset: ReusableSubFieldSet, targetOptions: string[], mode: ApplyPresetMode) => void;
}) {
  const { t } = useTranslation("admin");
  const [saveOpen, setSaveOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);

  const rootDraftCount = branchDrafts.filter(
    (d) => d.parent_branch_local_id === null && d.parent_option_value === selectedParentOption && d.name.trim(),
  ).length;
  const saveDisabled = rootDraftCount === 0 || !hasSavedTemplate;

  return (
    <div className="flex items-center gap-1">
      {/* Save current structure as preset */}
      <Popover open={saveOpen} onOpenChange={setSaveOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            disabled={saveDisabled}
            title={
              !hasSavedTemplate
                ? t("presets.saveAsSetNeedsTemplate", {
                    defaultValue: "Save the template first, then create reusable sets from the Edit view",
                  })
                : rootDraftCount === 0
                  ? t("presets.saveAsSetDisabled", { defaultValue: "Configure at least one field first" })
                  : t("presets.saveAsSetEnabled", { defaultValue: "Save current structure as a reusable set" })
            }
          >
            <Save className="h-3 w-3" />
            {t("presets.saveAsSet", { defaultValue: "Save as set" })}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-0">
          <SavePresetForm
            onSave={async (name, description, includeOptions) => {
              await onSavePreset(name, description, includeOptions);
              setSaveOpen(false);
            }}
            onCancel={() => setSaveOpen(false)}
          />
        </PopoverContent>
      </Popover>

      {/* Apply a saved preset */}
      <Popover open={applyOpen} onOpenChange={setApplyOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            title={t("presets.applySetTitle", { defaultValue: "Apply a saved set to options" })}
          >
            <BookOpen className="h-3 w-3" />
            {t("presets.applySet", { defaultValue: "Apply set" })}
            {presetSummaries.length > 0 && (
              <Badge variant="secondary" className="h-4 text-xs ml-0.5 px-1">
                {presetSummaries.length}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0">
          <ApplyPresetPanel
            savedPresets={savedPresets}
            presetSummaries={presetSummaries}
            presetsLoadState={presetsLoadState}
            selectedParentOption={selectedParentOption}
            allOptions={allOptions}
            branchDrafts={branchDrafts}
            onApply={(preset, targetOptions, mode) => {
              onApplyPreset(preset, targetOptions, mode);
              setApplyOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ─── SavePresetForm (inline in popover) ───────────────────────────────────────

function SavePresetForm({
  onSave,
  onCancel,
}: {
  onSave: (name: string, description: string, includeOptions: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation("admin");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [includeOptions, setIncludeOptions] = useState(false);
  const [saving, setSaving] = useState(false);

  return (
    <div className="p-3 space-y-3">
      <p className="text-sm font-medium">{t("presets.saveForm.heading", { defaultValue: "Save structure as reusable set" })}</p>
      <div className="space-y-1.5">
        <Label htmlFor="preset-name" className="text-xs">{t("presets.saveForm.nameLabel", { defaultValue: "Set name" })} <span className="text-destructive">*</span></Label>
        <Input
          id="preset-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("presets.saveForm.namePlaceholder", { defaultValue: "e.g., Project Details" })}
          className="h-8 text-sm"
          autoFocus
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="preset-desc" className="text-xs">{t("presets.saveForm.descriptionLabel", { defaultValue: "Description (optional)" })}</Label>
        <Input
          id="preset-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("presets.saveForm.descriptionPlaceholder", { defaultValue: "What fields does this set contain?" })}
          className="h-8 text-sm"
        />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="preset-opts" className="text-xs">{t("presets.saveForm.includeChoicesLabel", { defaultValue: "Include dropdown choices" })}</Label>
        <Switch
          id="preset-opts"
          checked={includeOptions}
          onCheckedChange={setIncludeOptions}
          className="scale-75"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {includeOptions
          ? t("presets.saveForm.includeChoicesOnHint", { defaultValue: "Choices will be copied to options that don't already have choices." })
          : t("presets.saveForm.includeChoicesOffHint", { defaultValue: "Only field structure is saved — each option keeps its own choices." })}
      </p>
      <div className="flex gap-2 justify-end pt-1">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>{t("presets.saveForm.cancel", { defaultValue: "Cancel" })}</Button>
        <Button
          size="sm"
          disabled={!name.trim() || saving}
          onClick={async () => {
            setSaving(true);
            try { await onSave(name, description, includeOptions); }
            finally { setSaving(false); }
          }}
        >
          {saving ? <RefreshCw className="h-3 w-3 animate-spin mr-1" /> : null}
          {t("presets.saveForm.save", { defaultValue: "Save set" })}
        </Button>
      </div>
    </div>
  );
}

// ─── ApplyPresetPanel (inline in popover) ────────────────────────────────────

function ApplyPresetPanel({
  savedPresets,
  presetSummaries,
  presetsLoadState,
  selectedParentOption,
  allOptions,
  branchDrafts,
  onApply,
}: {
  savedPresets: ReusableSubFieldSet[];
  presetSummaries: PresetSummary[];
  presetsLoadState: "idle" | "loading" | "success" | "error";
  selectedParentOption: string;
  allOptions: string[];
  branchDrafts: DraftOptionBranch[];
  onApply: (preset: ReusableSubFieldSet, targetOptions: string[], mode: ApplyPresetMode) => void;
}) {
  const { t } = useTranslation("admin");
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [mode, setMode] = useState<ApplyPresetMode>("merge");
  const [applyTo, setApplyTo] = useState<"current" | "unconfigured" | "all">("current");

  const unconfiguredCount = useMemo(
    () => getUnconfiguredOptions(allOptions, branchDrafts).length,
    [allOptions, branchDrafts],
  );

  const selectedPreset = savedPresets.find((p) => p.id === selectedPresetId) ?? null;

  if (presetsLoadState === "loading") {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        <RefreshCw className="h-3.5 w-3.5 animate-spin mx-auto mb-1.5" />
        {t("presets.applyPanel.loading", { defaultValue: "Loading saved sets…" })}
      </div>
    );
  }

  if (presetsLoadState === "error") {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        {t("presets.applyPanel.unavailable", { defaultValue: "Preset storage unavailable." })}
        <br />{t("presets.applyPanel.unavailableHint", { defaultValue: "Run the pending database migration to enable this feature." })}
      </div>
    );
  }

  if (presetSummaries.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        {t("presets.applyPanel.empty", { defaultValue: "No saved sets yet." })}
        <br />{t("presets.applyPanel.emptyHint", { defaultValue: "Configure some fields and click \"Save as set\"." })}
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3">
      <p className="text-sm font-medium">{t("presets.applyPanel.heading", { defaultValue: "Apply a saved set" })}</p>

      {/* Preset selector */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("presets.applyPanel.selectSetLabel", { defaultValue: "Select set" })}</Label>
        <Select value={selectedPresetId} onValueChange={setSelectedPresetId}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder={t("presets.applyPanel.selectSetPlaceholder", { defaultValue: "Choose a set…" })} />
          </SelectTrigger>
          <SelectContent>
            {presetSummaries.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
                <span className="ml-1 text-xs text-muted-foreground">({p.fieldCount} fields)</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Apply scope */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("presets.applyPanel.applyToLabel", { defaultValue: "Apply to" })}</Label>
        <Select value={applyTo} onValueChange={(v) => setApplyTo(v as typeof applyTo)}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="current">{t("presets.applyPanel.currentOnly", { defaultValue: "Current option only" })}</SelectItem>
            <SelectItem value="unconfigured">
              {t("presets.applyPanel.unconfigured", { count: unconfiguredCount, defaultValue: `Unconfigured options (${unconfiguredCount})` })}
            </SelectItem>
            <SelectItem value="all">{t("presets.applyPanel.allOptions", { count: allOptions.length, defaultValue: `All options (${allOptions.length})` })}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Apply mode */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("presets.applyPanel.whenExistLabel", { defaultValue: "When fields already exist" })}</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as ApplyPresetMode)}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="merge">{t("presets.applyPanel.modeMerge", { defaultValue: "Merge — add missing fields only" })}</SelectItem>
            <SelectItem value="sync">{t("presets.applyPanel.modeSync", { defaultValue: "Sync — update names, types, and order" })}</SelectItem>
            <SelectItem value="replace">{t("presets.applyPanel.modeReplace", { defaultValue: "Replace — remove existing, apply set" })}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {mode === "merge" && t("presets.applyPanel.mergeHint", { defaultValue: "Skips options that already have all fields from this set." })}
          {mode === "sync" && t("presets.applyPanel.syncHint", { defaultValue: "Updates field names and types from the set; keeps each option's own dropdown choices." })}
          {mode === "replace" && t("presets.applyPanel.replaceHint", { defaultValue: "Removes all existing dependent fields for affected options, then applies the set. Cannot be undone." })}
        </p>
      </div>

      <Button
        size="sm"
        className="w-full"
        disabled={!selectedPreset}
        onClick={() => {
          if (!selectedPreset) return;
          const targets =
            applyTo === "current"
              ? [selectedParentOption]
              : applyTo === "unconfigured"
                ? getUnconfiguredOptions(allOptions, branchDrafts)
                : allOptions;
          onApply(selectedPreset, targets, mode);
        }}
      >
        {t("presets.applyPanel.apply", { defaultValue: "Apply set" })}
      </Button>
    </div>
  );
}
