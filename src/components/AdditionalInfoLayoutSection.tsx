/**
 * AdditionalInfoLayoutSection
 *
 * Settings card for configuring how Additional Information (custom form-field templates)
 * are displayed in the Expense Review dialog and Expense Detail page.
 *
 * Reads/writes `organization_expense_field_layout_items`.
 * Degrades gracefully if the migration has not yet been applied.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { useToast } from "@/hooks/use-toast";
import { ChevronUp, ChevronDown, Save, LayoutList } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FieldLayoutContext } from "@/lib/formBuilder/subFieldPresets";

// ── Types ──────────────────────────────────────────────────────────────────────

type TemplateRow = {
  id: string;
  name: string;
  field_type: string;
};

type LayoutEntry = {
  templateId: string;
  name: string;
  fieldType: string;
  displayOrder: number;
  isVisible: boolean;
};

type LayoutState = {
  review: LayoutEntry[];
  detail: LayoutEntry[];
};

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchTemplates(organizationId: string): Promise<TemplateRow[]> {
  const { data, error } = await supabase
    .from("expense_form_field_templates")
    .select("id, name, field_type")
    .eq("organization_id", organizationId)
    .order("name");
  if (error || !data) return [];
  return data as TemplateRow[];
}

type RawLayoutItem = {
  parent_template_id: string;
  context: string;
  display_order: number;
  is_visible: boolean;
};

async function fetchLayoutItems(
  organizationId: string,
): Promise<{ items: RawLayoutItem[]; tableAvailable: boolean }> {
  const { data, error } = await (supabase as any)
    .from("organization_expense_field_layout_items")
    .select("parent_template_id, context, display_order, is_visible")
    .eq("organization_id", organizationId)
    .is("parent_template_id", null) // null = base template layout (not sub-field layout)
    .not("parent_template_id", "is", null); // Actually we want records where parent_template_id IS set

  // If the table doesn't exist the error code is 42P01
  if (error) {
    const isAbsent =
      error.code === "42P01" ||
      error.message?.includes("does not exist") ||
      error.message?.includes("relation") ||
      error.code === "PGRST116";
    return { items: [], tableAvailable: !isAbsent };
  }
  return { items: (data ?? []) as RawLayoutItem[], tableAvailable: true };
}

async function fetchLayoutItemsForTemplates(
  organizationId: string,
  templateIds: string[],
): Promise<{ items: RawLayoutItem[]; tableAvailable: boolean }> {
  if (templateIds.length === 0) return { items: [], tableAvailable: true };
  const { data, error } = await (supabase as any)
    .from("organization_expense_field_layout_items")
    .select("parent_template_id, context, display_order, is_visible")
    .eq("organization_id", organizationId)
    .in("parent_template_id", templateIds);
  if (error) {
    const isAbsent =
      error.code === "42P01" ||
      error.message?.includes("does not exist") ||
      error.message?.includes("relation") ||
      error.code === "PGRST116";
    return { items: [], tableAvailable: !isAbsent };
  }
  return { items: (data ?? []) as RawLayoutItem[], tableAvailable: true };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function buildLayoutState(templates: TemplateRow[], items: RawLayoutItem[]): LayoutState {
  const indexByContextAndTemplate = new Map<string, RawLayoutItem>();
  for (const item of items) {
    indexByContextAndTemplate.set(`${item.context}:${item.parent_template_id}`, item);
  }

  const makeEntries = (context: FieldLayoutContext): LayoutEntry[] => {
    return templates
      .map((t, i) => {
        const saved = indexByContextAndTemplate.get(`${context}:${t.id}`);
        return {
          templateId: t.id,
          name: t.name,
          fieldType: t.field_type,
          displayOrder: saved?.display_order ?? (i + 1) * 10,
          isVisible: saved?.is_visible ?? true,
        };
      })
      .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
  };

  return {
    review: makeEntries("review"),
    detail: makeEntries("detail"),
  };
}

function moveEntry(entries: LayoutEntry[], index: number, dir: "up" | "down"): LayoutEntry[] {
  const target = dir === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= entries.length) return entries;
  const next = [...entries];
  [next[index], next[target]] = [next[target], next[index]];
  return next.map((e, i) => ({ ...e, displayOrder: (i + 1) * 10 }));
}

// ── Sub-component: layout list for one context ────────────────────────────────

function ContextLayoutList({
  entries,
  onMove,
  onToggle,
  compact,
}: {
  entries: LayoutEntry[];
  onMove: (index: number, dir: "up" | "down") => void;
  onToggle: (index: number, visible: boolean) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation("settings");

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("additionalInfoLayout.noFields", { defaultValue: "No custom fields found. Add fields via Category > Form Fields first." })}
      </p>
    );
  }

  return (
    <div className="rounded-lg border divide-y">
      {entries.map((entry, index) => (
        <div
          key={entry.templateId}
          className={cn(
            "flex items-center gap-3 px-3",
            compact ? "py-2" : "py-2.5",
            !entry.isVisible && "opacity-50",
          )}
        >
          <span className="w-5 text-center text-xs font-medium text-muted-foreground select-none shrink-0">
            {index + 1}
          </span>
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium truncate">{entry.name}</span>
            <Badge variant="secondary" className="ml-2 text-[10px] px-1.5 py-0 align-middle">
              {entry.fieldType}
            </Badge>
          </div>
          <Switch
            checked={entry.isVisible}
            onCheckedChange={(v) => onToggle(index, v)}
            aria-label={t(
              entry.isVisible ? "additionalInfoLayout.ariaHide" : "additionalInfoLayout.ariaShow",
              { name: entry.name, defaultValue: `${entry.isVisible ? "Hide" : "Show"} ${entry.name}` },
            )}
          />
          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className={compact ? "h-8 w-8" : "h-7 w-7"}
              disabled={index === 0}
              onClick={() => onMove(index, "up")}
              title={t("additionalInfoLayout.moveUp", { defaultValue: "Move up" })}
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={compact ? "h-8 w-8" : "h-7 w-7"}
              disabled={index === entries.length - 1}
              onClick={() => onMove(index, "down")}
              title={t("additionalInfoLayout.moveDown", { defaultValue: "Move down" })}
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type Props = {
  organizationId: string;
  compact?: boolean;
};

export function AdditionalInfoLayoutSection({ organizationId, compact }: Props) {
  const { t } = useTranslation("settings");
  const { toast } = useToast();
  const [loadState, setLoadState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [tableAvailable, setTableAvailable] = useState<boolean | null>(null);
  const [layout, setLayout] = useState<LayoutState>({ review: [], detail: [] });

  const {
    progress: saveProgress,
    startOperation: startSave,
    completeOperation: completeSave,
    failOperation: failSave,
  } = useOperationProgress();

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const templates = await fetchTemplates(organizationId);
      if (templates.length === 0) {
        setLayout({ review: [], detail: [] });
        setTableAvailable(true);
        setLoadState("success");
        return;
      }

      const { items, tableAvailable: avail } = await fetchLayoutItemsForTemplates(
        organizationId,
        templates.map((t) => t.id),
      );
      setTableAvailable(avail);
      setLayout(buildLayoutState(templates, items));
      setLoadState("success");
    } catch {
      setLoadState("error");
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleMove = (context: FieldLayoutContext, index: number, dir: "up" | "down") => {
    setLayout((prev) => ({
      ...prev,
      [context]: moveEntry(prev[context], index, dir),
    }));
  };

  const handleToggle = (context: FieldLayoutContext, index: number, visible: boolean) => {
    setLayout((prev) => {
      const next = [...prev[context]];
      next[index] = { ...next[index], isVisible: visible };
      return { ...prev, [context]: next };
    });
  };

  const handleSave = async (context: FieldLayoutContext) => {
    if (!tableAvailable) return;
    const entries = layout[context];
    startSave(
      t("additionalInfoLayout.progressSaving", { context, defaultValue: `Saving ${context} layout…` }),
      { description: t("additionalInfoLayout.progressDesc", { defaultValue: "Writing field order and visibility" }) },
    );
    try {
      const rows = entries.map((e) => ({
        organization_id: organizationId,
        context,
        parent_template_id: e.templateId,
        field_path: "template",
        display_order: e.displayOrder,
        is_visible: e.isVisible,
        display_style: "standard" as const,
      }));
      const { error } = await (supabase as any)
        .from("organization_expense_field_layout_items")
        .upsert(rows, { onConflict: "organization_id,context,parent_template_id,field_path" });
      if (error) throw error;
      completeSave(
        context === "review"
          ? t("additionalInfoLayout.progressSavedReview", { defaultValue: "Review layout saved" })
          : t("additionalInfoLayout.progressSavedDetail", { defaultValue: "Detail layout saved" }),
      );
      toast({
        title: t("additionalInfoLayout.savedTitle", { defaultValue: "Layout saved" }),
        description: t("additionalInfoLayout.savedDesc", { context, defaultValue: `Additional Information layout for the ${context} context has been updated.` }),
      });
    } catch (e: any) {
      failSave(t("additionalInfoLayout.saveFailedTitle", { defaultValue: "Failed to save layout" }));
      toast({
        variant: "destructive",
        title: t("additionalInfoLayout.saveFailedTitle", { defaultValue: "Failed to save layout" }),
        description: e?.message || t("additionalInfoLayout.saveFailedDesc", { defaultValue: "Please try again." }),
      });
    }
  };

  const isSaving = saveProgress.status === "running";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <LayoutList className="h-5 w-5" />
          <CardTitle>{t("additionalInfoLayout.cardTitle", { defaultValue: "Additional Information Layout" })}</CardTitle>
        </div>
        <CardDescription>
          {t("additionalInfoLayout.cardDescription", { defaultValue: "Control the order and visibility of custom fields in the expense review dialog and detail page. Changes affect all users in your organization." })}
          {tableAvailable === false && (
            <span className="block mt-1 text-amber-600 text-xs">
              {t("additionalInfoLayout.migrationWarning", { defaultValue: "The layout table is not yet available — apply the migration first. Showing default order." })}
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loadState === "loading" || loadState === "idle" ? (
          <AsyncOperationProgress status="running" title={t("additionalInfoLayout.loading", { defaultValue: "Loading layout…" })} compact />
        ) : loadState === "error" ? (
          <AsyncOperationProgress
            status="error"
            title={t("additionalInfoLayout.loadFailed", { defaultValue: "Failed to load layout" })}
            retryLabel={t("additionalInfoLayout.retry", { defaultValue: "Retry" })}
            onRetry={load}
            compact
          />
        ) : (
          <Tabs defaultValue="review">
            <TabsList className="mb-4">
              <TabsTrigger value="review">{t("additionalInfoLayout.tabReview", { defaultValue: "Review view" })}</TabsTrigger>
              <TabsTrigger value="detail">{t("additionalInfoLayout.tabDetail", { defaultValue: "Detail page" })}</TabsTrigger>
            </TabsList>

            {(["review", "detail"] as FieldLayoutContext[]).map((ctx) => (
              <TabsContent key={ctx} value={ctx} className="space-y-4 mt-0">
                <ContextLayoutList
                  entries={layout[ctx]}
                  onMove={(i, d) => handleMove(ctx, i, d)}
                  onToggle={(i, v) => handleToggle(ctx, i, v)}
                  compact={compact}
                />

                {saveProgress.status !== "idle" && (
                  <AsyncOperationProgress
                    status={saveProgress.status}
                    title={saveProgress.phase}
                    showSuccess={saveProgress.status === "success"}
                    compact
                  />
                )}

                <Button
                  onClick={() => handleSave(ctx)}
                  disabled={isSaving || tableAvailable === false || layout[ctx].length === 0}
                  className="gap-2"
                >
                  <Save className="h-4 w-4" />
                  {isSaving
                    ? t("additionalInfoLayout.saving", { defaultValue: "Saving…" })
                    : ctx === "review"
                      ? t("additionalInfoLayout.saveReview", { defaultValue: "Save Review Layout" })
                      : t("additionalInfoLayout.saveDetail", { defaultValue: "Save Detail Layout" })}
                </Button>
              </TabsContent>
            ))}
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}
