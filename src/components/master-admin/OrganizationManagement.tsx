/**
 * Organization management view for Master Admin (DOC-165): one organization, six tabs
 * (Overview, Features, Plan & Billing, Users, Activity, Security).
 *
 * Presentational: all writes go through the callbacks the page passes in
 * (updateOrganization, feature save, block / unblock), i.e. the same handlers and the
 * same database calls the old table used. Nothing here talks to Supabase.
 */
import { format } from "date-fns";
import { ArrowLeft, Copy, ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import type { FeatureChange } from "@/lib/masterAdminFeatures";
import { FeaturesTab } from "./FeaturesTab";
import {
  PAYMENT_OPTIONS,
  PLAN_OPTIONS,
  SUBDOMAIN_RE,
  type Organization,
  type OrganizationUpdates,
  type StrategyOption,
} from "./types";

type Props = {
  org: Organization;
  memberCount: number;
  /** This organization's saved feature flags (feature_key -> enabled). */
  flags: Record<string, boolean>;
  /** Blocked by the org_blocked flag or the legacy organizations.is_blocked column. */
  blocked: boolean;
  /** Blocked by the org_blocked flag specifically (this is the one that stops logins). */
  flagBlocked: boolean;
  appBaseDomain: string;
  showTenantSubdomain: boolean;
  showTenantStrategy: boolean;
  showTenantFeatures: boolean;
  strategiesList: StrategyOption[];
  /** An update for this organization is in flight. */
  updating: boolean;
  onBack: () => void;
  onCopyId: () => void;
  onUpdate: (updates: OrganizationUpdates) => void | Promise<void>;
  onSaveFeatures: (changes: FeatureChange[]) => Promise<void>;
  onBlock: () => void;
  onUnblock: () => void;
};

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function OrganizationManagement({
  org,
  memberCount,
  flags,
  blocked,
  flagBlocked,
  appBaseDomain,
  showTenantSubdomain,
  showTenantStrategy,
  showTenantFeatures,
  strategiesList,
  updating,
  onBack,
  onCopyId,
  onUpdate,
  onSaveFeatures,
  onBlock,
  onUnblock,
}: Props) {
  const { toast } = useToast();
  const usagePct =
    org.max_users != null && org.max_users > 0 ? Math.min(100, Math.round((memberCount / org.max_users) * 100)) : 0;
  const activityInsightsOn = flags[ORGANIZATION_FEATURE_KEYS.user_activity_insights] === true;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 rounded-xl border bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4 min-w-0">
          <Button variant="outline" size="icon" onClick={onBack} aria-label="Back to organizations">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-bold tracking-tight">{org.name}</h1>
              {blocked ? <Badge variant="destructive">Blocked</Badge> : <Badge variant="outline">Active</Badge>}
            </div>
            <p className="font-mono text-xs text-muted-foreground">{org.slug}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onCopyId} className="gap-2 self-start sm:self-center">
          <Copy className="h-3.5 w-3.5" />
          Copy organization ID
        </Button>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="h-auto w-full flex-wrap justify-start gap-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="features">Features</TabsTrigger>
          <TabsTrigger value="billing">Plan &amp; Billing</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Plan</CardDescription>
                <CardTitle className="text-xl capitalize">{org.plan ?? "—"}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Payment</CardDescription>
                <CardTitle className="text-xl capitalize">{org.payment_status ?? "—"}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Users</CardDescription>
                <CardTitle className="text-xl">
                  {memberCount} / {org.max_users == null ? "∞" : org.max_users}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tenant settings</CardTitle>
              <CardDescription>
                Subdomain and strategy for this organization. Shared app host:{" "}
                <span className="font-mono text-foreground">{appBaseDomain}</span>.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              {showTenantSubdomain ? (
                <Field
                  label="Tenant subdomain"
                  hint={org.subdomain ? `https://${org.subdomain}.${appBaseDomain}` : "No subdomain set"}
                >
                  <Input
                    type="text"
                    className="font-mono text-sm"
                    defaultValue={org.subdomain ?? ""}
                    key={`sd-${org.id}-${org.subdomain ?? "x"}`}
                    placeholder="e.g. ml"
                    onBlur={(e) => {
                      const raw = e.target.value.trim().toLowerCase();
                      if (raw === "") {
                        if (org.subdomain) void onUpdate({ subdomain: null });
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
                        void onUpdate({ subdomain: raw });
                      }
                    }}
                    disabled={updating}
                  />
                </Field>
              ) : null}
              {showTenantStrategy ? (
                <Field label="Strategy">
                  <Select
                    value={org.strategy_slug || "standard"}
                    onValueChange={(value) => void onUpdate({ strategy_slug: value })}
                    disabled={updating || strategiesList.length === 0}
                  >
                    <SelectTrigger>
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
                </Field>
              ) : null}
              {!showTenantSubdomain && !showTenantStrategy ? (
                <p className="text-sm text-muted-foreground sm:col-span-2">
                  Tenant controls are unavailable until the tenant migrations are applied.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Organization ID</p>
                <p className="break-all font-mono text-xs">{org.id}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Created</p>
                <p>{format(new Date(org.created_at), "PPp")}</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Features */}
        <TabsContent value="features">
          {showTenantFeatures ? (
            <FeaturesTab orgId={org.id} saved={flags} disabled={updating} onSave={onSaveFeatures} />
          ) : (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              Feature flags are unavailable until the organization_features migration is applied.
            </p>
          )}
        </TabsContent>

        {/* Plan & Billing */}
        <TabsContent value="billing">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Plan &amp; billing</CardTitle>
              <CardDescription>Changes are saved as soon as you pick a value.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              <Field label="Plan">
                <Select
                  value={org.plan ?? "__none__"}
                  onValueChange={(value) => void onUpdate({ plan: value === "__none__" ? null : value })}
                  disabled={updating}
                >
                  <SelectTrigger>
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
              </Field>
              <Field label="Payment status">
                <Select
                  value={org.payment_status ?? "__none__"}
                  onValueChange={(value) => void onUpdate({ payment_status: value === "__none__" ? null : value })}
                  disabled={updating}
                >
                  <SelectTrigger>
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
              </Field>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Users */}
        <TabsContent value="users">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Users</CardTitle>
              <CardDescription>
                Active members against the user limit. Master Admin sees counts only, not individual users.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-bold">{memberCount}</span>
                  <span className="text-sm text-muted-foreground">
                    of {org.max_users == null ? "unlimited" : org.max_users} users
                  </span>
                </div>
                {org.max_users != null && org.max_users > 0 ? <Progress value={usagePct} /> : null}
              </div>
              <Field label="User limit" hint="Leave empty for unlimited. Saved when you leave the field.">
                <Input
                  type="number"
                  min={0}
                  step={1}
                  placeholder="Unlimited"
                  className="max-w-[200px]"
                  key={`${org.id}-${org.max_users ?? "u"}`}
                  defaultValue={org.max_users == null ? "" : String(org.max_users)}
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    if (raw === "") {
                      if (org.max_users != null) void onUpdate({ max_users: null });
                      return;
                    }
                    const n = parseInt(raw, 10);
                    if (!Number.isNaN(n) && n >= 0 && n !== (org.max_users ?? undefined)) {
                      void onUpdate({ max_users: n });
                    }
                  }}
                  disabled={updating}
                />
              </Field>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Activity */}
        <TabsContent value="activity">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity</CardTitle>
              <CardDescription>When this organization was last used.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Last active</p>
                <p className="font-medium">
                  {org.last_activity_at ? format(new Date(org.last_activity_at), "PPp") : "No activity recorded"}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Created</p>
                <p className="font-medium">{format(new Date(org.created_at), "PPp")}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">User activity insights</p>
                <p className="font-medium">{activityInsightsOn ? "On" : "Off"}</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Security */}
        <TabsContent value="security">
          <Card className={flagBlocked ? "border-red-300 dark:border-red-900" : undefined}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                {flagBlocked ? (
                  <ShieldAlert className="h-5 w-5 text-red-600" />
                ) : (
                  <ShieldCheck className="h-5 w-5 text-emerald-600" />
                )}
                {flagBlocked ? "This organization is blocked" : "Block organization"}
              </CardTitle>
              <CardDescription>
                {flagBlocked
                  ? "Its users cannot use PesoWise and see the message you set. Unblock to restore access."
                  : "Stops every user of this organization at login and shows them a message you write. You will be asked to confirm."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {flagBlocked ? (
                <Button variant="outline" onClick={onUnblock} disabled={updating}>
                  Unblock organization
                </Button>
              ) : (
                <Button variant="destructive" onClick={onBlock} disabled={updating}>
                  Block organization
                </Button>
              )}
              {org.is_blocked ? (
                <p className="text-xs text-muted-foreground">
                  The legacy &quot;is_blocked&quot; column is also set for this organization (read-only; it does not
                  stop logins).
                </p>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
