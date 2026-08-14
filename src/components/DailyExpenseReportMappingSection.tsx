import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { FileSpreadsheet, Save, Wand2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchExpenseCategoryNames } from "@/lib/fetchExpenseCategoryNames";
import {
  DAILY_REPORT_BASE_FIELD_KEYS,
  DAILY_REPORT_COST_COLUMNS,
  encodeBaseFieldSource,
  encodeBranchSource,
  emptyDailyExpenseReportConfig,
  fetchOrganizationDailyReportConfig,
  saveOrganizationDailyReportConfig,
  suggestDefaultCategoryMappings,
  suggestDefaultFieldMappings,
  validateDailyExpenseReportConfig,
  type DailyExpenseReportConfig,
  type DailyReportCostColumnKey,
  type DailyReportFieldSourceId,
} from "@/lib/dailyExpenseReportConfig";
import { DEFAULT_BASE_FIELD_CONFIG, resolveBaseFieldConfig } from "@/lib/expenseFormConfig";

type FormTemplate = {
  id: string;
  name: string;
  field_key: string | null;
  field_type: string;
};

type FormBranch = {
  id: string;
  name: string;
  field_key: string | null;
  field_type: string;
};

const NONE = "__none__";

function isConfigEmpty(config: DailyExpenseReportConfig): boolean {
  const { fieldMappings, categoryMappings } = config;
  const fieldsUnset =
    !fieldMappings.projectId && !fieldMappings.projectName && !fieldMappings.location;
  const categoriesUnset = DAILY_REPORT_COST_COLUMNS.every(
    ({ key }) => categoryMappings[key].length === 0,
  );
  return fieldsUnset && categoriesUnset;
}

function FieldSourceSelect({
  label,
  value,
  baseOptions,
  templates,
  branches,
  onChange,
  selectPlaceholder,
  baseGroupLabel,
  customGroupLabel,
  branchGroupLabel,
}: {
  label: string;
  value: DailyReportFieldSourceId | null;
  baseOptions: { id: string; label: string }[];
  templates: FormTemplate[];
  branches: FormBranch[];
  onChange: (value: string) => void;
  selectPlaceholder: string;
  baseGroupLabel: string;
  customGroupLabel: string;
  branchGroupLabel: string;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value ?? NONE} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder={selectPlaceholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{selectPlaceholder}</SelectItem>
          {baseOptions.length > 0 && (
            <SelectGroup>
              <SelectLabel>{baseGroupLabel}</SelectLabel>
              {baseOptions.map((opt) => (
                <SelectItem key={opt.id} value={opt.id}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {templates.length > 0 && (
            <SelectGroup>
              <SelectLabel>{customGroupLabel}</SelectLabel>
              {templates.map((tpl) => (
                <SelectItem key={tpl.id} value={`template:${tpl.id}`}>
                  {tpl.name}
                  {tpl.field_key ? ` (${tpl.field_key})` : ""}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {branches.length > 0 && (
            <SelectGroup>
              <SelectLabel>{branchGroupLabel}</SelectLabel>
              {branches.map((branch) => (
                <SelectItem key={branch.id} value={encodeBranchSource(branch.id)}>
                  {branch.name}
                  {branch.field_key ? ` (${branch.field_key})` : ""}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

export function DailyExpenseReportMappingSection() {
  const { t } = useTranslation("settings");
  const { organizationId } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [schemaMissing, setSchemaMissing] = useState(false);
  const [templates, setTemplates] = useState<FormTemplate[]>([]);
  const [branches, setBranches] = useState<FormBranch[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [resolvedBaseFields, setResolvedBaseFields] = useState(
    () => resolveBaseFieldConfig(null),
  );
  const [config, setConfig] = useState<DailyExpenseReportConfig>(emptyDailyExpenseReportConfig());

  const validation = useMemo(() => validateDailyExpenseReportConfig(config), [config]);

  const baseOptions = useMemo(
    () =>
      [...DAILY_REPORT_BASE_FIELD_KEYS]
        .sort(
          (a, b) =>
            (resolvedBaseFields[a]?.display_order ?? 0) -
            (resolvedBaseFields[b]?.display_order ?? 0),
        )
        .map((key) => ({
          id: encodeBaseFieldSource(key),
          label: resolvedBaseFields[key]?.label || DEFAULT_BASE_FIELD_CONFIG[key].label,
        })),
    [resolvedBaseFields],
  );

  const applySuggestedDefaults = useCallback(
    (tpls: FormTemplate[], cats: string[], current: DailyExpenseReportConfig) => {
      if (!isConfigEmpty(current)) return current;
      return {
        fieldMappings: suggestDefaultFieldMappings(tpls),
        categoryMappings: suggestDefaultCategoryMappings(cats),
      };
    },
    [],
  );

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setSchemaMissing(false);
    try {
      const [tplRes, branchRes, catNames, savedResult, baseFieldsRes] = await Promise.all([
        supabase
          .from("expense_form_field_templates")
          .select("id, name, field_key, field_type")
          .eq("organization_id", organizationId)
          .order("name", { ascending: true }),
        supabase
          .from("expense_form_field_option_branches")
          .select("id, name, field_key, field_type")
          .eq("organization_id", organizationId)
          .order("name", { ascending: true }),
        fetchExpenseCategoryNames(organizationId),
        fetchOrganizationDailyReportConfig(organizationId),
        (supabase as any)
          .from("organization_expense_form_fields")
          .select("*")
          .eq("organization_id", organizationId),
      ]);

      if (tplRes.error) throw tplRes.error;
      const tplList = (tplRes.data || []) as FormTemplate[];
      setTemplates(tplList);
      if (!branchRes.error) {
        setBranches((branchRes.data || []) as FormBranch[]);
      } else {
        setBranches([]);
      }
      setCategories(catNames);
      setSchemaMissing(Boolean(savedResult.needsMigration));

      if (!baseFieldsRes.error && baseFieldsRes.data) {
        setResolvedBaseFields(resolveBaseFieldConfig(baseFieldsRes.data));
      } else {
        setResolvedBaseFields(resolveBaseFieldConfig(null));
      }

      const merged = applySuggestedDefaults(tplList, catNames, savedResult.config);
      setConfig(merged);
    } catch (e) {
      console.error("DailyExpenseReportMappingSection load", e);
      toast({
        variant: "destructive",
        title: t("dailyReport.loadFailed"),
      });
    } finally {
      setLoading(false);
    }
  }, [organizationId, t, toast, applySuggestedDefaults]);

  useEffect(() => {
    void load();
  }, [load]);

  const setFieldMapping = (
    key: keyof DailyExpenseReportConfig["fieldMappings"],
    sourceId: string,
  ) => {
    setConfig((prev) => ({
      ...prev,
      fieldMappings: {
        ...prev.fieldMappings,
        [key]: sourceId === NONE ? null : sourceId,
      },
    }));
  };

  const toggleCategory = (column: DailyReportCostColumnKey, category: string, checked: boolean) => {
    setConfig((prev) => {
      const current = prev.categoryMappings[column];
      const next = checked ? [...current, category] : current.filter((c) => c !== category);
      return {
        ...prev,
        categoryMappings: {
          ...prev.categoryMappings,
          [column]: next,
        },
      };
    });
  };

  const handleApplyDefaults = () => {
    setConfig({
      fieldMappings: suggestDefaultFieldMappings(templates),
      categoryMappings: suggestDefaultCategoryMappings(categories),
    });
    toast({ title: t("dailyReport.defaultsApplied") });
  };

  const handleSave = async () => {
    if (!organizationId) return;
    const v = validateDailyExpenseReportConfig(config);
    if (!v.valid) {
      toast({
        variant: "destructive",
        title: t("dailyReport.validationFailed"),
        description: t("dailyReport.validationFailedHint"),
      });
      return;
    }
    setSaving(true);
    const result = await saveOrganizationDailyReportConfig(organizationId, config);
    setSaving(false);
    if (!result.ok) {
      if (result.needsMigration) setSchemaMissing(true);
      toast({
        variant: "destructive",
        title: t("saveFailed"),
        description: result.needsMigration
          ? t("dailyReport.schemaMigrationRequired")
          : result.error,
      });
      return;
    }
    setSchemaMissing(false);
    toast({ title: t("dailyReport.saved") });
  };

  if (!organizationId) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5" />
          <CardTitle>{t("dailyReport.title")}</CardTitle>
        </div>
        <CardDescription>{t("dailyReport.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {schemaMissing && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {t("dailyReport.schemaMigrationRequired")}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">{t("dailyReport.loading")}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={handleApplyDefaults}>
                <Wand2 className="mr-2 h-4 w-4" />
                {t("dailyReport.applyDefaults")}
              </Button>
            </div>

            <div className="space-y-4">
              <h3 className="text-sm font-semibold">{t("dailyReport.fieldMappingsTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("dailyReport.fieldMappingsHint")}</p>
              <div className="grid gap-4 md:grid-cols-3">
                <FieldSourceSelect
                  label={t("dailyReport.projectIdField")}
                  value={config.fieldMappings.projectId}
                  baseOptions={baseOptions}
                  templates={templates}
                  branches={branches}
                  onChange={(v) => setFieldMapping("projectId", v)}
                  selectPlaceholder={t("dailyReport.selectField")}
                  baseGroupLabel={t("dailyReport.baseFieldsGroup")}
                  customGroupLabel={t("dailyReport.customFieldsGroup")}
                  branchGroupLabel={t("dailyReport.branchFieldsGroup")}
                />
                <FieldSourceSelect
                  label={t("dailyReport.projectNameField")}
                  value={config.fieldMappings.projectName}
                  baseOptions={baseOptions}
                  templates={templates}
                  branches={branches}
                  onChange={(v) => setFieldMapping("projectName", v)}
                  selectPlaceholder={t("dailyReport.selectField")}
                  baseGroupLabel={t("dailyReport.baseFieldsGroup")}
                  customGroupLabel={t("dailyReport.customFieldsGroup")}
                  branchGroupLabel={t("dailyReport.branchFieldsGroup")}
                />
                <FieldSourceSelect
                  label={t("dailyReport.locationField")}
                  value={config.fieldMappings.location}
                  baseOptions={baseOptions}
                  templates={templates}
                  branches={branches}
                  onChange={(v) => setFieldMapping("location", v)}
                  selectPlaceholder={t("dailyReport.selectField")}
                  baseGroupLabel={t("dailyReport.baseFieldsGroup")}
                  customGroupLabel={t("dailyReport.customFieldsGroup")}
                  branchGroupLabel={t("dailyReport.branchFieldsGroup")}
                />
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="text-sm font-semibold">{t("dailyReport.categoryMappingsTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("dailyReport.categoryMappingsHint")}</p>
              {categories.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("dailyReport.noCategories")}</p>
              ) : (
                <div className="space-y-4">
                  {DAILY_REPORT_COST_COLUMNS.map(({ key, label }) => (
                    <div key={key} className="rounded-lg border p-3 space-y-2">
                      <Label className="font-medium">{label}</Label>
                      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                        {categories.map((cat) => {
                          const checked = config.categoryMappings[key].includes(cat);
                          const assignedElsewhere = DAILY_REPORT_COST_COLUMNS.some(
                            ({ key: otherKey }) =>
                              otherKey !== key && config.categoryMappings[otherKey].includes(cat),
                          );
                          return (
                            <label
                              key={`${key}-${cat}`}
                              className="flex items-center gap-2 text-sm cursor-pointer"
                            >
                              <Checkbox
                                checked={checked}
                                disabled={assignedElsewhere && !checked}
                                onCheckedChange={(v) => toggleCategory(key, cat, v === true)}
                              />
                              <span
                                className={
                                  assignedElsewhere && !checked ? "text-muted-foreground" : ""
                                }
                              >
                                {cat}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {!validation.valid && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                {t("dailyReport.incompleteMappings")}
              </p>
            )}

            <Button onClick={() => void handleSave()} disabled={saving || !validation.valid}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? t("dailyReport.saving") : t("dailyReport.saveMappings")}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
