/**
 * Features tab (DOC-165): all per-organization feature flags, grouped by category, with
 * search and explicit Save / Cancel. Edits are held in a local draft; Save hands the list
 * of changed flags to onSave, which uses the page's existing saveOrganizationFeature
 * (including the Activity Insights confirmation + audit), so saving semantics are unchanged.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MASTER_ADMIN_FEATURE_DEFINITIONS, type FeatureDefinition } from "@/lib/organizationFeatureKeys";
import {
  FEATURES_TAB_EXCLUDED_KEYS,
  categorizeFeatures,
  computeFeatureChanges,
  filterFeatureGroups,
  type FeatureChange,
} from "@/lib/masterAdminFeatures";

type Props = {
  orgId: string;
  /** Saved flags for this organization (feature_key -> enabled). Missing = off. */
  saved: Record<string, boolean>;
  disabled?: boolean;
  onSave: (changes: FeatureChange[]) => Promise<void>;
};

export function FeaturesTab({ orgId, saved, disabled = false, onSave }: Props) {
  const { t } = useTranslation("master");
  const [draft, setDraft] = useState<Record<string, boolean>>(saved);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  // Re-sync the draft whenever the saved flags (or the organization) change.
  const savedSignature = JSON.stringify(saved);
  useEffect(() => {
    setDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, savedSignature]);

  const allKeys = useMemo(
    () =>
      MASTER_ADMIN_FEATURE_DEFINITIONS.filter((d) => !FEATURES_TAB_EXCLUDED_KEYS.includes(d.key)).map(
        (d) => d.key as string,
      ),
    [],
  );
  const groups = useMemo(() => categorizeFeatures(), []);
  const labelOf = (def: FeatureDefinition) => t(def.labelKey);
  const shownGroups = filterFeatureGroups(groups, query, labelOf);
  const changes = computeFeatureChanges(saved, draft, allKeys);
  const dirty = changes.length > 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(changes);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search features"
          aria-label="Search features"
          className="pl-9"
        />
      </div>

      {shownGroups.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No features match your search.
        </p>
      ) : (
        shownGroups.map((group) => {
          const enabledCount = group.features.filter((f) => draft[f.key] === true).length;
          return (
            <section key={group.id} className="rounded-lg border">
              <header className="flex items-center justify-between gap-3 border-b bg-muted/30 px-4 py-2.5">
                <div>
                  <h3 className="text-sm font-semibold">{group.label}</h3>
                  <p className="text-xs text-muted-foreground">{group.description}</p>
                </div>
                <Badge variant="outline" className="shrink-0 text-xs">
                  {enabledCount} / {group.features.length} on
                </Badge>
              </header>
              <ul className="divide-y">
                {group.features.map((def) => {
                  const id = `${orgId}-feature-${def.key}`;
                  const changed = (saved[def.key] === true) !== (draft[def.key] === true);
                  return (
                    <li key={def.key} className="flex items-start justify-between gap-4 px-4 py-3">
                      <Label htmlFor={id} className="cursor-pointer text-sm font-normal leading-snug">
                        {labelOf(def)}
                        {def.requiresSubdomain ? (
                          <Badge variant="outline" className="ml-2 px-1 py-0 text-[10px]">
                            subdomain
                          </Badge>
                        ) : null}
                        {changed ? (
                          <Badge className="ml-2 px-1.5 py-0 text-[10px]">changed</Badge>
                        ) : null}
                      </Label>
                      <Switch
                        id={id}
                        checked={draft[def.key] === true}
                        onCheckedChange={(v) => setDraft((prev) => ({ ...prev, [def.key]: v === true }))}
                        disabled={disabled || saving}
                        aria-label={labelOf(def)}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}

      <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-between gap-3 rounded-lg border bg-background/95 px-4 py-3 shadow-sm backdrop-blur">
        <p className="text-sm text-muted-foreground">
          {dirty ? `${changes.length} unsaved change${changes.length === 1 ? "" : "s"}` : "No unsaved changes"}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" disabled={!dirty || saving} onClick={() => setDraft(saved)}>
            Cancel
          </Button>
          <Button disabled={!dirty || saving || disabled} onClick={() => void handleSave()}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
