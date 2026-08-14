import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  isLocalDevHost,
  setStoredDevTenantSubdomain,
  type DevTenantOrgOption,
} from "@/lib/devTenantOverride";
import { getDevTenantSubdomainOverride } from "@/lib/tenantContext";
import { Loader2 } from "lucide-react";

const APEX_VALUE = "__apex__";

type DevTenantSelectorProps = {
  onTenantChange?: () => void;
};

function normalizeTenantLabel(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/**
 * Localhost-only: pick which tenant subdomain to simulate (replaces editing .env each time).
 */
export function DevTenantSelector({ onTenantChange }: DevTenantSelectorProps) {
  const [orgs, setOrgs] = useState<DevTenantOrgOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [manualSubdomain, setManualSubdomain] = useState("");
  const [selected, setSelected] = useState<string>(() => {
    const override = getDevTenantSubdomainOverride();
    return override || APEX_VALUE;
  });

  const envLocked = Boolean(
    (import.meta.env.VITE_DEV_TENANT_SUBDOMAIN as string | undefined)?.trim(),
  );

  const loadOrgs = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await supabase.rpc("list_organizations_for_dev_login");
      if (error) {
        const msg = error.message || "Failed to load organizations";
        if (msg.includes("list_organizations_for_dev_login")) {
          throw new Error(
            "Database function missing. Run migration 20260524190000_list_organizations_for_dev_login.sql (and 20260524190100_fix_dev_tenant_list_use_slug.sql) on Supabase.",
          );
        }
        throw new Error(msg);
      }
      const rows = (data || []) as DevTenantOrgOption[];
      const mapped = rows
        .map((o) => {
          const label = normalizeTenantLabel(o.subdomain || o.slug || "");
          if (!label) return null;
          return { ...o, subdomain: label };
        })
        .filter((o): o is DevTenantOrgOption => o !== null);
      setOrgs(mapped);
      if (mapped.length === 0) {
        setLoadError(
          "No organizations found. Add orgs in Supabase or set subdomain/slug on organizations.",
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not load tenants";
      console.warn("DevTenantSelector:", msg, e);
      setLoadError(msg);
      setOrgs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLocalDevHost()) return;
    void loadOrgs();
  }, [loadOrgs]);

  if (!isLocalDevHost()) return null;

  const applyTenant = (value: string | null) => {
    setStoredDevTenantSubdomain(value);
    onTenantChange?.();
    window.location.reload();
  };

  const handleSelectChange = (value: string) => {
    setSelected(value);
    applyTenant(value === APEX_VALUE ? null : value);
  };

  const handleManualApply = () => {
    const label = normalizeTenantLabel(manualSubdomain);
    if (!label) return;
    setSelected(label);
    applyTenant(label);
  };

  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 space-y-2">
      <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
        Local dev: tenant
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="dev-tenant-select" className="text-xs text-muted-foreground">
          Simulate subdomain
        </Label>
        {envLocked ? (
          <p className="text-xs text-muted-foreground font-mono">
            Locked by VITE_DEV_TENANT_SUBDOMAIN
          </p>
        ) : (
          <>
            <Select value={selected} onValueChange={handleSelectChange} disabled={loading}>
              <SelectTrigger id="dev-tenant-select" className="h-9 bg-background">
                {loading ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading tenants…
                  </span>
                ) : (
                  <SelectValue placeholder="Choose tenant" />
                )}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={APEX_VALUE}>Apex (no tenant)</SelectItem>
                {orgs.map((o) => (
                  <SelectItem key={o.id} value={o.subdomain}>
                    {o.name} ({o.subdomain})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {loadError ? (
              <p className="text-xs text-destructive leading-snug">{loadError}</p>
            ) : null}
            {!loading && orgs.length === 0 ? (
              <div className="space-y-2 pt-1">
                <Label htmlFor="dev-tenant-manual" className="text-xs text-muted-foreground">
                  Or type tenant label manually
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="dev-tenant-manual"
                    className="h-9 font-mono text-sm"
                    placeholder="e.g. ml or mistryandshah"
                    value={manualSubdomain}
                    onChange={(e) => setManualSubdomain(e.target.value)}
                  />
                  <Button type="button" size="sm" variant="secondary" onClick={handleManualApply}>
                    Apply
                  </Button>
                </div>
              </div>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void loadOrgs()}
              disabled={loading}
            >
              Refresh list
            </Button>
          </>
        )}
        <p className="text-[11px] text-muted-foreground leading-snug">
          Uses each org&apos;s <span className="font-mono">subdomain</span> or{" "}
          <span className="font-mono">slug</span> as the host label. Changing tenant reloads the
          page.
        </p>
      </div>
    </div>
  );
}
