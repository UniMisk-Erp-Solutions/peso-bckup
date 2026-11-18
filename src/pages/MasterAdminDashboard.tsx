import { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ORG_BLOCKED_MESSAGE, ORG_BLOCK_MESSAGE_MAX, validateBlockMessage } from "@/lib/orgBlocked";
import { Label } from "@/components/ui/label";
import {
  Building2,
  Mail,
  Database,
  HardDrive,
  Users,
  MessageSquare,
  RefreshCw,
  Copy,
  Download,
  ShieldAlert,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { fetchFullBackup, downloadFullBackup, downloadFullBackupWithReceipts, fetchOrgBackup, downloadBackup, downloadBackupWithReceipts, fetchReceiptBlobs } from "@/lib/backupData";
import { MASTER_ADMIN_FEATURE_DEFINITIONS, ORGANIZATION_FEATURE_KEYS, STRATEGY_OPTIONS_FALLBACK } from "@/lib/organizationFeatureKeys";
import { getAppBaseDomain } from "@/lib/tenantContext";
import { SystemMaintenanceCard } from "@/components/SystemMaintenanceCard";
import { SystemBroadcastCard } from "@/components/SystemBroadcastCard";
import { SYSTEM_STATUS_CONTROL_ENABLED } from "@/config/systemStatusFeature";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function SystemStatusDisabledCard() {
  return (
    <Card className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
      <CardHeader>
        <CardTitle className="text-amber-800 dark:text-amber-200 text-base">
          System notices temporarily disabled
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-amber-700 dark:text-amber-300 space-y-1.5">
        <p>
          Maintenance scheduling and broadcast announcements are temporarily unavailable
          while the storage provider is being changed.
        </p>
        <ul className="list-disc list-inside space-y-1 mt-2">
          <li>No maintenance status is currently being read.</li>
          <li>No users will be blocked by the maintenance system.</li>
          <li>Existing implementation has been retained for future reactivation.</li>
        </ul>
      </CardContent>
    </Card>
  );
}

interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: string | null;
  payment_status: string | null;
  is_blocked: boolean | null;
  last_activity_at: string | null;
  created_at: string;
  max_users: number | null;
  subdomain?: string | null;
  strategy_slug?: string;
}

interface ContactLead {
  id: string;
  full_name: string;
  work_email: string;
  company: string;
  phone: string | null;
  role: string | null;
  team_size: string | null;
  multi_level: boolean;
  balance: boolean;
  multi_location: boolean;
  receipts: boolean;
  message: string | null;
  consent_marketing: boolean;
  created_at: string;
}

interface StorageMetrics {
  database_size_gb?: number;
  storage_size_gb?: number;
  total_size_gb?: number;
}

export default function MasterAdminDashboard() {
  const { t } = useTranslation("master");
  const { userRole } = useAuth();
  const { toast } = useToast();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [contactLeads, setContactLeads] = useState<ContactLead[]>([]);
  const [storageMetrics, setStorageMetrics] = useState<StorageMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatingOrgId, setUpdatingOrgId] = useState<string | null>(null);
  const [backupFullLoading, setBackupFullLoading] = useState(false);
  const [backupOrgLoading, setBackupOrgLoading] = useState(false);
  const [selectedOrgIdForBackup, setSelectedOrgIdForBackup] = useState<string>("");
  const [includeReceiptsFull, setIncludeReceiptsFull] = useState(false);
  const [includeReceiptsOrg, setIncludeReceiptsOrg] = useState(false);
  const [memberCountByOrgId, setMemberCountByOrgId] = useState<Record<string, number>>({});
  const [strategiesList, setStrategiesList] = useState<{ slug: string; label: string }[]>([]);
  const [featuresByOrgId, setFeaturesByOrgId] = useState<Record<string, Record<string, boolean>>>({});
  /** DB has organizations.subdomain + strategy_slug (tenant migrations applied). */
  const [tenantOrgColumnsMigrated, setTenantOrgColumnsMigrated] = useState(false);
  /** public.strategies exists (REST not 404). */
  const [strategiesTableMigrated, setStrategiesTableMigrated] = useState(false);
  /** public.organization_features exists. */
  const [featuresTableMigrated, setFeaturesTableMigrated] = useState(false);
  const migrationNoticeShown = useRef(false);

  /** Pending enable-request for user_activity_insights that needs admin confirmation. */
  const [activityEnablePending, setActivityEnablePending] = useState<{
    orgId: string;
    orgName: string;
  } | null>(null);
  const [activityEnableChecked, setActivityEnableChecked] = useState(false);

  /** Pending "block organization" confirmation: Master Admin writes the message users will see. */
  const [blockPending, setBlockPending] = useState<{ orgId: string; orgName: string } | null>(null);
  const [blockMessage, setBlockMessage] = useState("");
  const [blockSaving, setBlockSaving] = useState(false);

  const openBlockDialog = async (orgId: string, orgName: string) => {
    setBlockMessage(ORG_BLOCKED_MESSAGE);
    setBlockPending({ orgId, orgName });
    // Prefill with the message saved last time (best effort: column may not exist yet).
    try {
      const { data } = await (supabase as any)
        .from("organizations")
        .select("block_message")
        .eq("id", orgId)
        .maybeSingle();
      const saved = (data as { block_message?: string | null } | null)?.block_message;
      if (saved && saved.trim()) setBlockMessage(saved);
    } catch {
      /* keep the default text */
    }
  };

  const confirmBlockOrganization = async () => {
    if (!blockPending) return;
    const checked = validateBlockMessage(blockMessage);
    if (checked.ok === false) {
      toast({ variant: "destructive", title: "Message required", description: checked.error });
      return;
    }
    setBlockSaving(true);
    try {
      const { error } = await (supabase as any)
        .from("organizations")
        .update({ block_message: checked.message })
        .eq("id", blockPending.orgId);
      if (error) {
        toast({
          variant: "destructive",
          title: "Could not save the message",
          description:
            "Apply supabase/migrations/20261118120000_organization_block_message.sql, then try again. " +
            (error.message ?? ""),
        });
        return;
      }
      await saveOrganizationFeature(blockPending.orgId, ORGANIZATION_FEATURE_KEYS.org_blocked, true);
      setBlockPending(null);
    } finally {
      setBlockSaving(false);
    }
  };

  const PLAN_OPTIONS = ["starter", "free-trial", "pro"] as const;
  const PAYMENT_OPTIONS = ["active", "pending", "overdue", "suspended", "cancelled"] as const;
  const appBaseDomain = getAppBaseDomain();
  const showTenantSubdomain = tenantOrgColumnsMigrated;
  const showTenantStrategy = tenantOrgColumnsMigrated && strategiesTableMigrated;
  const showTenantFeatures = featuresTableMigrated;
  const orgTableColSpan =
    8 + (showTenantSubdomain ? 1 : 0) + (showTenantStrategy ? 1 : 0) + (showTenantFeatures ? 1 : 0);

  const updateOrganization = async (
    orgId: string,
    updates: {
      plan?: string | null;
      payment_status?: string | null;
      max_users?: number | null;
      subdomain?: string | null;
      strategy_slug?: string;
    },
  ) => {
    if (
      (updates.subdomain !== undefined || updates.strategy_slug !== undefined) &&
      !tenantOrgColumnsMigrated
    ) {
      toast({
        variant: "destructive",
        title: "Migration required",
        description:
          "Apply tenant migrations (organizations subdomain/strategy columns). See supabase/migrations/20260513120100_organizations_subdomain_strategy.sql",
      });
      return;
    }
    if (updates.strategy_slug !== undefined && !strategiesTableMigrated) {
      toast({
        variant: "destructive",
        title: "Migration required",
        description: "Apply strategies migration: supabase/migrations/20260513120000_strategies_tenant.sql",
      });
      return;
    }
    setUpdatingOrgId(orgId);
    try {
      const { error } = await (supabase as any)
        .from("organizations")
        .update(updates)
        .eq("id", orgId);
      if (error) throw error;
      setOrganizations((prev) =>
        prev.map((o) =>
          o.id === orgId ? { ...o, ...updates } : o
        )
      );
      toast({ title: "Updated", description: "Organization updated successfully." });
    } catch (e) {
      console.error("Update organization error:", e);
      toast({
        variant: "destructive",
        title: "Update failed",
        description: e instanceof Error ? e.message : "Please try again.",
      });
    } finally {
      setUpdatingOrgId(null);
    }
  };

  const saveOrganizationFeature = async (orgId: string, featureKey: string, enabled: boolean) => {
    if (!featuresTableMigrated) {
      toast({
        variant: "destructive",
        title: "Migration required",
        description:
          "Apply organization_features migration: supabase/migrations/20260513120200_organization_features.sql",
      });
      return;
    }
    setUpdatingOrgId(orgId);
    try {
      const { error } = await supabase.from("organization_features").upsert(
        {
          organization_id: orgId,
          feature_key: featureKey,
          enabled,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id,feature_key" },
      );
      if (error) throw error;
      setFeaturesByOrgId((prev) => ({
        ...prev,
        [orgId]: { ...(prev[orgId] || {}), [featureKey]: enabled },
      }));
      toast({ title: "Feature updated", description: featureKey });
    } catch (e) {
      console.error("Feature update error:", e);
      toast({
        variant: "destructive",
        title: "Update failed",
        description: e instanceof Error ? e.message : "Please try again.",
      });
    } finally {
      setUpdatingOrgId(null);
    }
  };

  const load = async () => {
    const ORG_FULL =
      "id, name, slug, plan, payment_status, is_blocked, last_activity_at, created_at, max_users, subdomain, strategy_slug";
    const ORG_LEGACY =
      "id, name, slug, plan, payment_status, is_blocked, last_activity_at, created_at, max_users";

    try {
      let orgRes = await supabase.from("organizations").select(ORG_FULL).order("created_at", { ascending: false });
      let tenantCols = true;
      if (orgRes.error) {
        orgRes = await supabase.from("organizations").select(ORG_LEGACY).order("created_at", { ascending: false });
        if (orgRes.error) throw orgRes.error;
        tenantCols = false;
      }
      setTenantOrgColumnsMigrated(tenantCols);

      const mapped: Organization[] = (orgRes.data ?? []).map((row: Record<string, unknown>) => {
        const r = row as Organization;
        if (!tenantCols) {
          return { ...r, subdomain: null, strategy_slug: undefined };
        }
        return {
          ...r,
          subdomain: (r.subdomain as string | null | undefined) ?? null,
          strategy_slug: (r.strategy_slug as string | undefined) ?? "standard",
        };
      });
      setOrganizations(mapped);

      const [leadsRes, metricsRes, countsRes, stratRes, featRes] = await Promise.all([
        supabase
          .from("contact_leads")
          .select(
            "id, full_name, work_email, company, phone, role, team_size, multi_level, balance, multi_location, receipts, message, consent_marketing, created_at",
          )
          .order("created_at", { ascending: false })
          .limit(100),
        supabase.rpc("get_storage_metrics"),
        supabase.rpc("get_organization_member_counts"),
        supabase.from("strategies").select("slug, label").order("slug"),
        supabase.from("organization_features").select("organization_id, feature_key, enabled"),
      ]);

      if (leadsRes.error) {
        console.warn("Master admin: contact_leads unavailable:", leadsRes.error.message);
        setContactLeads([]);
      } else {
        setContactLeads((leadsRes.data ?? []) as ContactLead[]);
      }

      if (countsRes.error) {
        console.warn("Master admin: member counts unavailable:", countsRes.error.message);
        setMemberCountByOrgId({});
      } else if (countsRes.data && Array.isArray(countsRes.data)) {
        const byId: Record<string, number> = {};
        for (const row of countsRes.data as { organization_id: string; member_count: number }[]) {
          byId[row.organization_id] = Number(row.member_count);
        }
        setMemberCountByOrgId(byId);
      } else {
        setMemberCountByOrgId({});
      }

      if (metricsRes.error) {
        console.warn("Storage metrics not available:", metricsRes.error.message);
      }
      setStorageMetrics((metricsRes.data ?? null) as StorageMetrics | null);

      const stratOk = !stratRes.error;
      setStrategiesTableMigrated(stratOk);
      setStrategiesList(
        stratOk && Array.isArray(stratRes.data) && stratRes.data.length > 0
          ? (stratRes.data as { slug: string; label: string }[])
          : STRATEGY_OPTIONS_FALLBACK,
      );

      const featOk = !featRes.error;
      setFeaturesTableMigrated(featOk);
      if (featOk && featRes.data) {
        const byOrg: Record<string, Record<string, boolean>> = {};
        for (const row of featRes.data as { organization_id: string; feature_key: string; enabled: boolean }[]) {
          if (!byOrg[row.organization_id]) byOrg[row.organization_id] = {};
          byOrg[row.organization_id][row.feature_key] = row.enabled;
        }
        setFeaturesByOrgId(byOrg);
      } else {
        setFeaturesByOrgId({});
      }

      const needsMigrationNotice = !tenantCols || !stratOk || !featOk;
      if (needsMigrationNotice && !migrationNoticeShown.current) {
        migrationNoticeShown.current = true;
        toast({
          title: "Tenant migrations not applied on database",
          description:
            "Run the SQL files in order: 20260513120000_strategies_tenant.sql → 20100 → 20200 → 20300 → 20400 (supabase/migrations). Then refresh.",
          duration: 14000,
        });
      }
    } catch (e) {
      console.error("Master admin load error:", e);
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === "object" && e !== null && "message" in e
            ? String((e as { message: unknown }).message)
            : JSON.stringify(e);
      toast({
        variant: "destructive",
        title: "Error loading data",
        description: msg || "Please try again.",
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (userRole === "master_admin") {
      load();
    }
  }, [userRole]);

  const handleRefresh = () => {
    setRefreshing(true);
    load();
  };

  const handleDownloadFullBackup = async () => {
    try {
      setBackupFullLoading(true);
      const payload = await fetchFullBackup(supabase);
      if (includeReceiptsFull) {
        const receiptsByOrg: Record<string, Awaited<ReturnType<typeof fetchReceiptBlobs>>> = {};
        for (const orgId of Object.keys(payload.dataByOrganization)) {
          const atts = payload.dataByOrganization[orgId]?.attachments ?? [];
          receiptsByOrg[orgId] = await fetchReceiptBlobs(supabase, atts);
        }
        await downloadFullBackupWithReceipts(payload, receiptsByOrg);
        toast({ title: "Full backup downloaded", description: "All organizations, data, and receipt files saved (ZIP)." });
      } else {
        downloadFullBackup(payload);
        toast({ title: "Full backup downloaded", description: "All organizations and data have been saved." });
      }
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Backup failed",
        description: e instanceof Error ? e.message : "Failed to prepare full backup.",
      });
    } finally {
      setBackupFullLoading(false);
    }
  };

  const handleDownloadOrgBackup = async () => {
    if (!selectedOrgIdForBackup) {
      toast({ variant: "destructive", title: "Select an organization", description: "Choose an organization to download." });
      return;
    }
    try {
      setBackupOrgLoading(true);
      const payload = await fetchOrgBackup(supabase, selectedOrgIdForBackup);
      if (includeReceiptsOrg && payload.attachments.length > 0) {
        const receiptBlobs = await fetchReceiptBlobs(supabase, payload.attachments);
        await downloadBackupWithReceipts(payload, receiptBlobs);
        toast({ title: "Backup downloaded", description: `Data and ${receiptBlobs.length} receipt(s) for ${organizations.find((o) => o.id === selectedOrgIdForBackup)?.name ?? "organization"} saved.` });
      } else {
        downloadBackup(payload);
        toast({ title: "Backup downloaded", description: `Data for ${organizations.find((o) => o.id === selectedOrgIdForBackup)?.name ?? "organization"} saved.` });
      }
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Backup failed",
        description: e instanceof Error ? e.message : "Failed to prepare organization backup.",
      });
    } finally {
      setBackupOrgLoading(false);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied", description: `${label} copied to clipboard.` });
    } catch {
      toast({
        variant: "destructive",
        title: "Copy failed",
        description: "Could not copy to clipboard.",
      });
    }
  };

  if (userRole !== "master_admin") {
    return (
      <div className="space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">Access Denied</h1>
          <p className="text-muted-foreground">Only master admins can access this page.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 rounded-xl border bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Master Admin</h1>
            <p className="text-muted-foreground">Organizations, contact leads, and system metrics</p>
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {SYSTEM_STATUS_CONTROL_ENABLED ? (
        <>
          <SystemMaintenanceCard />
          <SystemBroadcastCard />
        </>
      ) : (
        <SystemStatusDisabledCard />
      )}

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-l-4 border-l-blue-500 shadow-sm transition-shadow hover:shadow-md">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Organizations</CardTitle>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
              <Building2 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{organizations.length}</div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-emerald-500 shadow-sm transition-shadow hover:shadow-md">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Contact Leads</CardTitle>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
              <MessageSquare className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{contactLeads.length}</div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-violet-500 shadow-sm transition-shadow hover:shadow-md">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Storage (total)</CardTitle>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-100 dark:bg-violet-900/30">
              <HardDrive className="h-4 w-4 text-violet-600 dark:text-violet-400" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {storageMetrics?.total_size_gb != null
                ? `${storageMetrics.total_size_gb} GB`
                : "—"}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Organizations */}
      <Card className="shadow-sm">
        <CardHeader className="border-b bg-muted/30">
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            Organizations
          </CardTitle>
          <CardDescription>
            All organizations. Shared app host:{" "}
            <span className="font-mono text-foreground">{appBaseDomain}</span>. Tenant URLs:{" "}
            <span className="font-mono">{"{subdomain}." + appBaseDomain}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          {(!tenantOrgColumnsMigrated || !strategiesTableMigrated || !featuresTableMigrated) && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
              <strong>Tenant controls are limited.</strong> Your API returned missing tables/columns (apply migrations
              20260513120000–204 in <span className="font-mono">supabase/migrations</span> on this project), then reload
              schema if needed (Dashboard → Settings → API → Reload schema).
            </div>
          )}
          <div className="overflow-hidden rounded-lg border">
            <Table noScrollWrapper className="table-fixed [&_td]:px-2 [&_th]:px-2">
              <TableHeader className="bg-muted/50 [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide">
                <TableRow>
                  <TableHead className="w-[20%]">Organization</TableHead>
                  {showTenantSubdomain || showTenantStrategy ? (
                    <TableHead className="w-[15%]">Tenant / Strategy</TableHead>
                  ) : null}
                  {showTenantFeatures ? <TableHead className="w-[31%]">Features</TableHead> : null}
                  <TableHead className="w-[12%]">Plan / Payment</TableHead>
                  <TableHead className="w-[9%]">Users</TableHead>
                  <TableHead className="w-[13%]">Activity / Blocked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {organizations.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={orgTableColSpan} className="text-center text-muted-foreground">
                      No organizations
                    </TableCell>
                  </TableRow>
                ) : (
                  organizations.map((org) => {
                    const memberCount = memberCountByOrgId[org.id] ?? 0;
                    return (
                    <TableRow key={org.id} className={org.is_blocked ? "bg-red-50/60 hover:bg-red-50 dark:bg-red-950/20" : "hover:bg-muted/30"}>
                      <TableCell className="align-top">
                        <div className="font-semibold break-words">{org.name}</div>
                        <div className="font-mono text-xs text-muted-foreground break-all">{org.slug}</div>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(org.id, "Organization ID")}
                          className="mt-1 flex items-center gap-1.5 w-full font-mono text-[11px] text-muted-foreground truncate text-left hover:text-foreground hover:bg-muted/50 rounded px-1 py-0.5 -mx-1 transition-colors"
                          title="Click to copy organization ID"
                        >
                          <Copy className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate">{org.id}</span>
                        </button>
                      </TableCell>
                      {showTenantSubdomain || showTenantStrategy ? (
                      <TableCell className="align-top">
                      <div className="flex flex-col gap-2">
                      {showTenantSubdomain ? (
                      <div>
                        <Input
                          type="text"
                          className="h-8 font-mono text-xs mb-1"
                          defaultValue={org.subdomain ?? ""}
                          key={`sd-${org.id}-${org.subdomain ?? "x"}`}
                          placeholder="e.g. ml"
                          onBlur={(e) => {
                            const raw = e.target.value.trim().toLowerCase();
                            if (raw === "") {
                              if (org.subdomain) void updateOrganization(org.id, { subdomain: null });
                              return;
                            }
                            if (!SUBDOMAIN_RE.test(raw)) {
                              toast({
                                variant: "destructive",
                                title: "Invalid subdomain",
                                description: "Use lowercase letters, numbers, and hyphens (63 chars max per label).",
                              });
                              return;
                            }
                            if (raw !== (org.subdomain || "")) {
                              void updateOrganization(org.id, { subdomain: raw });
                            }
                          }}
                          disabled={updatingOrgId === org.id}
                        />
                        <p className="text-[10px] text-muted-foreground truncate" title={org.subdomain ? `https://${org.subdomain}.${appBaseDomain}` : ""}>
                          {org.subdomain ? `https://${org.subdomain}.${appBaseDomain}` : "—"}
                        </p>
                      </div>
                      ) : null}
                      {showTenantStrategy ? (
                      <div>
                        <Select
                          value={org.strategy_slug || "standard"}
                          onValueChange={(value) =>
                            updateOrganization(org.id, { strategy_slug: value })
                          }
                          disabled={updatingOrgId === org.id || strategiesList.length === 0}
                        >
                          <SelectTrigger className="h-8 w-full">
                            <SelectValue placeholder="—" />
                          </SelectTrigger>
                          <SelectContent>
                            {strategiesList.map((s) => (
                              <SelectItem key={s.slug} value={s.slug}>
                                {s.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      ) : null}
                      </div>
                      </TableCell>
                      ) : null}
                      {showTenantFeatures ? (
                      <TableCell className="align-top">
                        <div className="flex flex-col gap-1 w-full max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-2">
                          {MASTER_ADMIN_FEATURE_DEFINITIONS.map((def) => (
                            <div
                              key={def.key}
                              className={`flex items-start gap-2 rounded px-1.5 py-1 ${
                                def.key === ORGANIZATION_FEATURE_KEYS.org_blocked
                                  ? "border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
                                  : "hover:bg-background"
                              }`}
                            >
                              <Checkbox
                                id={`${org.id}-${def.key}`}
                                className="mt-0.5"
                                checked={featuresByOrgId[org.id]?.[def.key] ?? false}
                                onCheckedChange={(v) => {
                                  // Enabling user_activity_insights requires admin confirmation first
                                  if (
                                    def.key === ORGANIZATION_FEATURE_KEYS.user_activity_insights &&
                                    v === true
                                  ) {
                                    setActivityEnableChecked(false);
                                    setActivityEnablePending({ orgId: org.id, orgName: org.name });
                                  } else if (def.key === ORGANIZATION_FEATURE_KEYS.org_blocked && v === true) {
                                    // Blocking asks for the message users will see before saving the flag
                                    void openBlockDialog(org.id, org.name);
                                  } else {
                                    const featureSavePromise = saveOrganizationFeature(org.id, def.key, v === true);
                                    // Audit log for disable action — non-blocking. Requires SQL file 13.
                                    if (def.key === ORGANIZATION_FEATURE_KEYS.user_activity_insights && v === false) {
                                      void featureSavePromise.then(() => {
                                        supabase
                                          .rpc("record_user_activity_feature_audit", {
                                            p_organization_id: org.id,
                                            p_action: "disabled",
                                            p_confirmation_version: null,
                                            p_confirmation_text: null,
                                          })
                                          .then(({ error }) => {
                                            if (error) {
                                              console.warn("[ActivityAudit] disable audit failed (non-blocking):", error.message);
                                            }
                                          });
                                      });
                                    } else {
                                      void featureSavePromise;
                                    }
                                  }
                                }}
                                disabled={updatingOrgId === org.id}
                              />
                              <Label
                                htmlFor={`${org.id}-${def.key}`}
                                className="text-xs font-normal cursor-pointer leading-snug"
                              >
                                {t(def.labelKey)}
                                {def.requiresSubdomain ? (
                                  <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0">
                                    subdomain
                                  </Badge>
                                ) : null}
                              </Label>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                      ) : null}
                      <TableCell className="align-top">
                      <div className="flex flex-col gap-2">
                        <Select
                          value={org.plan ?? "__none__"}
                          onValueChange={(value) =>
                            updateOrganization(org.id, {
                              plan: value === "__none__" ? null : value,
                            })
                          }
                          disabled={updatingOrgId === org.id}
                        >
                          <SelectTrigger className="h-8 w-full">
                            <SelectValue placeholder="—" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">—</SelectItem>
                            {PLAN_OPTIONS.map((p) => (
                              <SelectItem key={p} value={p}>
                                {p}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={org.payment_status ?? "__none__"}
                          onValueChange={(value) =>
                            updateOrganization(org.id, {
                              payment_status: value === "__none__" ? null : value,
                            })
                          }
                          disabled={updatingOrgId === org.id}
                        >
                          <SelectTrigger className="h-8 w-full">
                            <SelectValue placeholder="—" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">—</SelectItem>
                            {PAYMENT_OPTIONS.map((p) => (
                              <SelectItem key={p} value={p}>
                                {p}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex flex-col gap-1">
                          <span className="text-muted-foreground text-xs whitespace-nowrap">
                            {memberCount} / {org.max_users == null ? "∞" : org.max_users}
                          </span>
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            placeholder="Unlimited"
                            className="h-8 w-full"
                            key={`${org.id}-${org.max_users ?? "u"}`}
                            defaultValue={org.max_users == null ? "" : String(org.max_users)}
                            onBlur={(e) => {
                              const raw = e.target.value.trim();
                              if (raw === "") {
                                if (org.max_users != null) updateOrganization(org.id, { max_users: null });
                                return;
                              }
                              const n = parseInt(raw, 10);
                              if (!Number.isNaN(n) && n >= 0 && n !== (org.max_users ?? undefined)) {
                                updateOrganization(org.id, { max_users: n });
                              }
                            }}
                            disabled={updatingOrgId === org.id}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex flex-col items-start gap-2">
                          <span className="text-xs text-muted-foreground">
                            {org.last_activity_at
                              ? format(new Date(org.last_activity_at), "PPp")
                              : "—"}
                          </span>
                          {org.is_blocked ? (
                            <Badge variant="destructive">Blocked: Yes</Badge>
                          ) : (
                            <Badge variant="outline" className="text-muted-foreground">Blocked: No</Badge>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Data & backup (master admin) */}
      <Card className="shadow-sm">
        <CardHeader className="border-b bg-muted/30">
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5 text-primary" />
            Data & backup
          </CardTitle>
          <CardDescription>
            Worst-case backup: full website data includes <strong>all expenses, users, memberships, settings, locations, categories, and audit logs from every organization</strong>, plus contact leads and master admin list. Use &quot;Download full website data&quot; to get everything in one file. Optionally include receipt files in a ZIP.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap gap-4 items-center rounded-lg border bg-muted/20 p-4">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="full-include-receipts"
                checked={includeReceiptsFull}
                onCheckedChange={(v) => setIncludeReceiptsFull(v === true)}
              />
              <Label htmlFor="full-include-receipts" className="text-sm font-normal cursor-pointer">Include receipts (full backup)</Label>
            </div>
            <button
              type="button"
              onClick={handleDownloadFullBackup}
              disabled={backupFullLoading}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {backupFullLoading ? "Preparing full backup…" : includeReceiptsFull ? "Download full data (ZIP)" : "Download full website data"}
            </button>
          </div>
          <div className="flex flex-wrap gap-4 items-center rounded-lg border bg-muted/20 p-4">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="org-include-receipts"
                checked={includeReceiptsOrg}
                onCheckedChange={(v) => setIncludeReceiptsOrg(v === true)}
              />
              <Label htmlFor="org-include-receipts" className="text-sm font-normal cursor-pointer">Include receipts (org backup)</Label>
            </div>
            <Select value={selectedOrgIdForBackup} onValueChange={setSelectedOrgIdForBackup}>
              <SelectTrigger className="w-[280px]">
                <SelectValue placeholder="Select organization" />
              </SelectTrigger>
              <SelectContent>
                {organizations.map((org) => (
                  <SelectItem key={org.id} value={org.id}>
                    {org.name} ({org.slug})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              onClick={handleDownloadOrgBackup}
              disabled={backupOrgLoading || !selectedOrgIdForBackup}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {backupOrgLoading ? "Preparing…" : includeReceiptsOrg ? "Download org data (ZIP)" : "Download organization data"}
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Contact leads */}
      <Card className="shadow-sm">
        <CardHeader className="border-b bg-muted/30">
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            Contact / Inquiry Leads
          </CardTitle>
          <CardDescription>Submissions from the contact form (Tell us about your organization)</CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50 [&_th]:whitespace-nowrap [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide">
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Needs</TableHead>
                  <TableHead>Submitted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contactLeads.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      No contact leads yet
                    </TableCell>
                  </TableRow>
                ) : (
                  contactLeads.map((lead) => (
                    <TableRow key={lead.id}>
                      <TableCell className="font-medium">{lead.full_name}</TableCell>
                      <TableCell>
                        <a href={`mailto:${lead.work_email}`} className="text-primary hover:underline">
                          {lead.work_email}
                        </a>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{lead.phone ?? "—"}</TableCell>
                      <TableCell>{lead.company}</TableCell>
                      <TableCell className="text-muted-foreground">{lead.role ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {[
                          lead.multi_level && "Multi-level",
                          lead.balance && "Balance",
                          lead.multi_location && "Multi-location",
                          lead.receipts && "Receipts",
                        ]
                          .filter(Boolean)
                          .join(", ") || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(lead.created_at), "PP")}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Storage */}
      {storageMetrics && (
        <Card className="shadow-sm">
          <CardHeader className="border-b bg-muted/30">
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5 text-primary" />
              Storage metrics
            </CardTitle>
            <CardDescription>Database and file storage usage</CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-lg border bg-muted/20 p-4">
                <p className="text-sm text-muted-foreground">Database</p>
                <p className="text-xl font-semibold">{storageMetrics.database_size_gb ?? "—"} GB</p>
              </div>
              <div className="rounded-lg border bg-muted/20 p-4">
                <p className="text-sm text-muted-foreground">Storage buckets</p>
                <p className="text-xl font-semibold">{storageMetrics.storage_size_gb ?? "—"} GB</p>
              </div>
              <div className="rounded-lg border bg-muted/20 p-4">
                <p className="text-sm text-muted-foreground">Total</p>
                <p className="text-xl font-semibold">{storageMetrics.total_size_gb ?? "—"} GB</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      {/* ── Block organization: message box ─────────────────────────────── */}
      <Dialog
        open={blockPending !== null}
        onOpenChange={(open) => {
          if (!open && !blockSaving) setBlockPending(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-red-500 shrink-0" />
              Block {blockPending?.orgName}
            </DialogTitle>
            <DialogDescription>
              Every user of this organization will be stopped at login and shown this message instead of the app.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="block-message">Message shown to users</Label>
            <Textarea
              id="block-message"
              rows={5}
              maxLength={ORG_BLOCK_MESSAGE_MAX}
              value={blockMessage}
              onChange={(e) => setBlockMessage(e.target.value)}
              placeholder="e.g. Your subscription has expired. Please contact support to restore access."
            />
            <p className="text-xs text-muted-foreground text-right">
              {blockMessage.length} / {ORG_BLOCK_MESSAGE_MAX}
            </p>
          </div>
          <DialogFooter className="gap-2 pt-2">
            <Button variant="outline" disabled={blockSaving} onClick={() => setBlockPending(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={blockSaving} onClick={() => void confirmBlockOrganization()}>
              {blockSaving ? "Blocking…" : "Block organization"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── User Activity Insights enable confirmation dialog ───────────── */}
      <Dialog
        open={activityEnablePending !== null}
        onOpenChange={(open) => {
          if (!open) {
            setActivityEnablePending(null);
            setActivityEnableChecked(false);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500 shrink-0" />
              Before enabling User Activity Insights
            </DialogTitle>
            <DialogDescription className="sr-only">
              Confirmation required before enabling activity tracking
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm text-gray-700">
            <p>
              This feature records limited in-app activity metadata for users of{" "}
              <strong>{activityEnablePending?.orgName}</strong>, including session start
              time, last seen time, visible PesoWise app time, session count, and
              expenses submitted per day.
            </p>
            <p>
              It does <strong>not</strong> track keystrokes, screenshots, screen
              recording, websites, other apps, location, camera, microphone, or
              activity outside PesoWise.
            </p>
            <p>
              This is <strong>not</strong> a hidden monitoring feature. Users
              will be shown an in-app notice before tracking starts.
            </p>
            <p>
              Before enabling this feature, confirm that the organization has
              informed its users/employees and has the necessary internal
              approval, lawful basis, HR policy, and a process for handling
              access, correction, or deletion requests.
            </p>
            <p className="text-xs text-gray-500">
              Your organization remains responsible for its HR/legal policy,
              lawful basis, retention period, and grievance/contact process.
              This feature alone does not constitute legal compliance. Review the{" "}
              <Link
                to="/legal/activity-insights"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:no-underline"
              >
                Activity Insights Notice
              </Link>{" "}
              and{" "}
              <Link
                to="/legal/data-processing"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:no-underline"
              >
                Data Processing Policy
              </Link>
              .
            </p>

            <label className="flex items-start gap-2 cursor-pointer select-none pt-1">
              <Checkbox
                id="activity-enable-confirm"
                checked={activityEnableChecked}
                onCheckedChange={(v) => setActivityEnableChecked(v === true)}
                className="mt-0.5 shrink-0"
              />
              <span className="text-xs text-gray-700 leading-snug">
                I confirm that this organization has informed its users of
                activity tracking, has the necessary internal/lawful approval,
                has a defined retention policy, and has a grievance/contact
                process for access and deletion requests.
              </span>
            </label>
          </div>

          <DialogFooter className="gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                setActivityEnablePending(null);
                setActivityEnableChecked(false);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!activityEnableChecked || updatingOrgId === activityEnablePending?.orgId}
              onClick={async () => {
                if (!activityEnablePending) return;
                await saveOrganizationFeature(
                  activityEnablePending.orgId,
                  ORGANIZATION_FEATURE_KEYS.user_activity_insights,
                  true
                );
                // Audit log — non-blocking. Requires SQL file 13 to be applied.
                supabase
                  .rpc("record_user_activity_feature_audit", {
                    p_organization_id: activityEnablePending.orgId,
                    p_action: "enabled",
                    p_confirmation_version: "activity_enable_confirm_v1",
                    p_confirmation_text:
                      "I confirm that this organization has informed its users of activity tracking, has the necessary internal/lawful approval, has a defined retention policy, and has a grievance/contact process for access and deletion requests.",
                  })
                  .then(({ error }) => {
                    if (error) {
                      console.warn(
                        "[ActivityAudit] record_user_activity_feature_audit failed (non-blocking):",
                        error.message
                      );
                    }
                  });
                setActivityEnablePending(null);
                setActivityEnableChecked(false);
              }}
            >
              Enable User Activity Insights
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
