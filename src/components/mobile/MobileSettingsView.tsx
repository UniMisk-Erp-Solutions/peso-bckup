import React from "react";
import { useToast } from "@/hooks/use-toast";
import { LanguageSelector } from "@/components/LanguageSelector";
import { PwaInstallSettingsSection } from "@/components/PwaInstallSettingsSection";
import { TeamManagementSection } from "@/components/TeamManagementSection";
import { DailyExpenseReportMappingSection } from "@/components/DailyExpenseReportMappingSection";
import { AdditionalInfoLayoutSection } from "@/components/AdditionalInfoLayoutSection";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Settings as SettingsIcon,
  Save,
  Bell,
  Volume2,
  VolumeX,
  MapPin,
  Plus,
  Edit,
  Trash2,
  Upload,
  Image as ImageIcon,
  X,
  Database,
  Download,
  RotateCcw,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { formatINR } from "@/lib/format";
import {
  normalizeBaseFieldOptions,
  type BaseExpenseFieldKey,
  type BaseFieldConfig,
} from "@/lib/expenseFormConfig";
import type { BatchExpenseAttachmentMode } from "@/lib/expenseBatchConstants";

const FORCE_VISIBLE_FIELDS: BaseExpenseFieldKey[] = [
  "category",
  "amount",
  "expense_date",
];

const INPUT_TYPE_LABELS: Record<string, string> = {
  default: "Default",
  text: "Text",
  number: "Number",
  dropdown: "Dropdown",
};

interface NotificationSettings {
  popup_enabled: boolean;
  sound_enabled: boolean;
  desktop_enabled: boolean;
}

interface Props {
  // Auth / role
  userRole: string | null | undefined;
  organizationId: string | null | undefined;
  organization: { logo_url?: string | null; name?: string | null } | null;
  hierarchyEnabled: boolean;
  teamsEnabled: boolean;
  dailyProjectReportEnabled: boolean;
  baseFieldCustomizationEnabled: boolean;
  batchExpenseEntryEnabled: boolean;

  // Theme
  dashboardTheme: string;
  setDashboardTheme: (v: "legacy" | "old-money") => void;

  // Notifications
  notificationSettings: NotificationSettings;
  loadingNotifications: boolean;
  updateNotificationSetting: (
    key: keyof NotificationSettings,
    value: boolean,
  ) => void;

  // Admin settings
  loading: boolean;
  saving: boolean;
  engineerApprovalLimit: string;
  setEngineerApprovalLimit: (v: string) => void;
  disableManagerApprovalLimit: boolean;
  setDisableManagerApprovalLimit: (v: boolean) => void;
  attachmentRequiredAboveAmount: string;
  setAttachmentRequiredAboveAmount: (v: string) => void;
  allowCashierExpenseSubmission: boolean;
  setAllowCashierExpenseSubmission: (v: boolean) => void;
  requireImmediateSupervisor: boolean;
  setRequireImmediateSupervisor: (v: boolean) => void;
  batchExpenseAttachmentMode: BatchExpenseAttachmentMode;
  setBatchExpenseAttachmentMode: (v: BatchExpenseAttachmentMode) => void;
  saveSettings: () => Promise<void>;

  // Form builder
  baseFieldConfig: Record<BaseExpenseFieldKey, BaseFieldConfig>;
  savingFormBuilder: boolean;
  saveFormBuilderSettings: () => Promise<void>;
  openFieldEditor: (key: BaseExpenseFieldKey) => void;

  // Expense detail view order
  detailViewFields: {
    id: string;
    name: string;
    field_type: string;
    options?: string[] | null;
  }[];
  loadingDetailView: boolean;
  savingDetailView: boolean;
  moveDetailViewField: (index: number, direction: "up" | "down") => void;
  saveDetailViewOrder: () => Promise<void>;

  // Organization logo
  logoPreview: string | null;
  logoFile: File | null;
  uploadingLogo: boolean;
  setLogoFile: (f: File | null) => void;
  setLogoPreview: (v: string | null) => void;
  handleLogoUpload: () => Promise<void>;
  handleLogoDelete: () => Promise<void>;

  // Locations
  locations: { id: string; name: string }[];
  loadingLocations: boolean;
  openLocationDialog: (location?: { id: string; name: string }) => void;
  openDeleteLocationDialog: (location: { id: string; name: string }) => void;

  // Data & backup
  backupLoading: boolean;
  restoreLoading: boolean;
  includeReceipts: boolean;
  setIncludeReceipts: (v: boolean) => void;
  handleDownloadBackup: () => Promise<void>;
  restoreFileInputRef: React.RefObject<HTMLInputElement>;
  handleRestoreFileSelect: (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => Promise<void>;
}

export function MobileSettingsView({
  userRole,
  organizationId,
  organization,
  hierarchyEnabled,
  teamsEnabled,
  dailyProjectReportEnabled,
  baseFieldCustomizationEnabled,
  batchExpenseEntryEnabled,
  dashboardTheme,
  setDashboardTheme,
  notificationSettings,
  loadingNotifications,
  updateNotificationSetting,
  loading,
  saving,
  engineerApprovalLimit,
  setEngineerApprovalLimit,
  disableManagerApprovalLimit,
  setDisableManagerApprovalLimit,
  attachmentRequiredAboveAmount,
  setAttachmentRequiredAboveAmount,
  allowCashierExpenseSubmission,
  setAllowCashierExpenseSubmission,
  requireImmediateSupervisor,
  setRequireImmediateSupervisor,
  batchExpenseAttachmentMode,
  setBatchExpenseAttachmentMode,
  saveSettings,
  baseFieldConfig,
  savingFormBuilder,
  saveFormBuilderSettings,
  openFieldEditor,
  detailViewFields,
  loadingDetailView,
  savingDetailView,
  moveDetailViewField,
  saveDetailViewOrder,
  logoPreview,
  logoFile,
  uploadingLogo,
  setLogoFile,
  setLogoPreview,
  handleLogoUpload,
  handleLogoDelete,
  locations,
  loadingLocations,
  openLocationDialog,
  openDeleteLocationDialog,
  backupLoading,
  restoreLoading,
  includeReceipts,
  setIncludeReceipts,
  handleDownloadBackup,
  restoreFileInputRef,
  handleRestoreFileSelect,
}: Props) {
  const { toast } = useToast();
  const isAdmin = userRole === "admin" || userRole === "master_admin";

  const handleLogoFileChange = (file: File | null) => {
    if (!file) {
      setLogoFile(null);
      setLogoPreview(null);
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({
        variant: "destructive",
        title: "File too large",
        description: "Logo must be less than 2MB",
      });
      return;
    }
    setLogoFile(file);
    const reader = new FileReader();
    reader.onloadend = () => setLogoPreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleDesktopNotificationToggle = async (checked: boolean) => {
    if (checked && "Notification" in window) {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        updateNotificationSetting("desktop_enabled", true);
        toast({
          title: "Notifications enabled",
          description:
            "You'll receive desktop notifications for new updates",
        });
      } else if (permission === "denied") {
        toast({
          variant: "destructive",
          title: "Permission denied",
          description:
            "Please enable notifications in your browser settings",
        });
        updateNotificationSetting("desktop_enabled", false);
      } else {
        updateNotificationSetting("desktop_enabled", false);
      }
    } else {
      updateNotificationSetting("desktop_enabled", checked);
    }
  };

  return (
    <div className="space-y-4 pb-6" data-testid="mobile-settings-view">
      {/* ── Appearance ──────────────────────────────────── */}
      <Card data-testid="mobile-settings-appearance">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Dashboard Appearance</CardTitle>
          <CardDescription className="text-xs">
            Visual theme only — data and features are unchanged.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(
            [
              {
                id: "legacy" as const,
                title: "Legacy",
                desc: "The original PesoWise dashboard.",
              },
              {
                id: "old-money" as const,
                title: "Old Money",
                desc: "A private-banking aesthetic — ivory, emerald & brass.",
              },
            ] as const
          ).map((opt) => {
            const active = dashboardTheme === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setDashboardTheme(opt.id)}
                aria-pressed={active}
                data-testid={`theme-option-${opt.id}`}
                className={`w-full text-left rounded-xl border p-4 min-h-[44px] transition-colors ${
                  active
                    ? "border-emerald-700 ring-2 ring-emerald-700/30 bg-emerald-50/60"
                    : "border-border hover:bg-muted/50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">{opt.title}</span>
                  {active && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                      Active
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{opt.desc}</p>
              </button>
            );
          })}
        </CardContent>
      </Card>

      {/* ── Language ────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Language</CardTitle>
        </CardHeader>
        <CardContent>
          <LanguageSelector />
        </CardContent>
      </Card>

      {/* ── PWA Install ─────────────────────────────────── */}
      <PwaInstallSettingsSection />

      {/* ── Notifications ───────────────────────────────── */}
      <Card data-testid="mobile-settings-notifications">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-4 w-4" />
            Notifications
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-0 divide-y">
          {loadingNotifications ? (
            <p className="text-sm text-muted-foreground py-2">Loading…</p>
          ) : (
            <>
              <div className="flex items-center justify-between py-3 min-h-[56px]">
                <div className="pr-4 min-w-0">
                  <p className="text-sm font-medium">Popup Notifications</p>
                  <p className="text-xs text-muted-foreground">
                    Show popup when new notifications arrive
                  </p>
                </div>
                <Switch
                  checked={notificationSettings.popup_enabled}
                  onCheckedChange={(v) =>
                    updateNotificationSetting("popup_enabled", v)
                  }
                />
              </div>

              <div className="flex items-center justify-between py-3 min-h-[56px]">
                <div className="pr-4 min-w-0">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    {notificationSettings.sound_enabled ? (
                      <Volume2 className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <VolumeX className="h-3.5 w-3.5 shrink-0" />
                    )}
                    Sound
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Play a sound on new notifications
                  </p>
                </div>
                <Switch
                  checked={notificationSettings.sound_enabled}
                  onCheckedChange={(v) =>
                    updateNotificationSetting("sound_enabled", v)
                  }
                />
              </div>

              <div className="flex items-center justify-between py-3 min-h-[56px]">
                <div className="pr-4 min-w-0">
                  <p className="text-sm font-medium">Desktop Notifications</p>
                  <p className="text-xs text-muted-foreground">
                    Native OS notification center
                  </p>
                </div>
                <Switch
                  checked={notificationSettings.desktop_enabled}
                  onCheckedChange={handleDesktopNotificationToggle}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Admin-only sections ─────────────────────────── */}
      {isAdmin && (
        <>
          {teamsEnabled && organizationId && userRole === "admin" && (
            <TeamManagementSection />
          )}
          {dailyProjectReportEnabled &&
            organizationId &&
            userRole === "admin" && <DailyExpenseReportMappingSection />}

          {/* Admin Settings */}
          <Card data-testid="mobile-settings-admin">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <SettingsIcon className="h-4 w-4" />
                <CardTitle className="text-base">Admin Settings</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {userRole === "master_admin" && !organizationId ? (
                <p className="text-sm text-muted-foreground">
                  Sign in as an organisation administrator to change these
                  settings.
                </p>
              ) : loading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="m-approval-limit">
                      Manager Approval Limit (₹)
                    </Label>
                    <div className="flex items-center justify-between rounded-lg border p-3 min-h-[56px]">
                      <p className="text-sm font-medium pr-4">
                        Disable manager limit
                      </p>
                      <Switch
                        id="m-disable-approval-limit"
                        checked={disableManagerApprovalLimit}
                        onCheckedChange={setDisableManagerApprovalLimit}
                      />
                    </div>
                    <Input
                      id="m-approval-limit"
                      type="number"
                      min="0"
                      step="1"
                      value={engineerApprovalLimit}
                      onChange={(e) => setEngineerApprovalLimit(e.target.value)}
                      placeholder="50000"
                      disabled={disableManagerApprovalLimit}
                      className="text-base"
                    />
                    <p className="text-xs text-muted-foreground">
                      {disableManagerApprovalLimit
                        ? "Managers can approve all amounts directly."
                        : `Expenses below ${formatINR(parseFloat(engineerApprovalLimit) || 0)} approved by managers directly.`}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="m-attachment-limit">
                      Attachment Required Above (₹)
                    </Label>
                    <Input
                      id="m-attachment-limit"
                      type="number"
                      min="0"
                      step="0.01"
                      value={attachmentRequiredAboveAmount}
                      onChange={(e) =>
                        setAttachmentRequiredAboveAmount(e.target.value)
                      }
                      placeholder="50"
                      className="text-base"
                    />
                  </div>

                  {batchExpenseEntryEnabled && (
                    <div className="space-y-2">
                      <Label htmlFor="m-batch-attachment">
                        Batch receipts
                      </Label>
                      <Select
                        value={batchExpenseAttachmentMode}
                        onValueChange={(v) =>
                          setBatchExpenseAttachmentMode(
                            v as BatchExpenseAttachmentMode,
                          )
                        }
                      >
                        <SelectTrigger id="m-batch-attachment">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="per_line">
                            One receipt per line
                          </SelectItem>
                          <SelectItem value="shared">
                            One shared receipt for batch
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div className="flex items-center justify-between rounded-lg border p-3 min-h-[56px]">
                    <div className="pr-4 min-w-0">
                      <p className="text-sm font-medium">Cashier expenses</p>
                      <p className="text-xs text-muted-foreground">
                        Allow cashiers to submit expense claims
                      </p>
                    </div>
                    <Switch
                      id="m-allow-cashier-expense"
                      checked={allowCashierExpenseSubmission}
                      onCheckedChange={setAllowCashierExpenseSubmission}
                    />
                  </div>

                  {hierarchyEnabled && (
                    <div className="flex items-center justify-between rounded-lg border p-3 min-h-[56px]">
                      <div className="pr-4 min-w-0">
                        <p className="text-sm font-medium">
                          Require immediate supervisor
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Employees must have a supervisor assigned
                        </p>
                      </div>
                      <Switch
                        id="m-require-supervisor"
                        checked={requireImmediateSupervisor}
                        onCheckedChange={setRequireImmediateSupervisor}
                      />
                    </div>
                  )}

                  <Button
                    onClick={saveSettings}
                    disabled={saving}
                    className="w-full min-h-[44px]"
                    data-testid="mobile-settings-save"
                  >
                    <Save className="h-4 w-4 mr-2" />
                    {saving ? "Saving…" : "Save Settings"}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {/* Form Builder */}
          <Card data-testid="mobile-settings-form-builder">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Expense Form Builder
              </CardTitle>
              <CardDescription className="text-xs">
                Tap a field to edit its label, order, visibility
                {baseFieldCustomizationEnabled ? ", and input type" : ""}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="divide-y rounded-lg border">
                {(
                  Object.keys(baseFieldConfig) as BaseExpenseFieldKey[]
                )
                  .sort(
                    (a, b) =>
                      baseFieldConfig[a].display_order -
                      baseFieldConfig[b].display_order,
                  )
                  .map((key) => {
                    const cfg = baseFieldConfig[key];
                    const forceVisible = FORCE_VISIBLE_FIELDS.includes(key);
                    const isHidden = !forceVisible && !cfg.is_visible;
                    const optionCount = normalizeBaseFieldOptions(
                      cfg.options,
                    ).length;
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between gap-3 p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="font-medium text-sm truncate">
                              {cfg.label || cfg.field_key}
                            </span>
                            {forceVisible && (
                              <Badge
                                variant="secondary"
                                className="text-[10px] px-1 py-0"
                              >
                                Core
                              </Badge>
                            )}
                            {cfg.is_required && (
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1 py-0"
                              >
                                Req
                              </Badge>
                            )}
                            {isHidden && (
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1 py-0 text-muted-foreground"
                              >
                                Hidden
                              </Badge>
                            )}
                            {baseFieldCustomizationEnabled &&
                              cfg.input_type !== "default" && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] px-1 py-0"
                                >
                                  {INPUT_TYPE_LABELS[cfg.input_type] ??
                                    cfg.input_type}
                                  {cfg.input_type === "dropdown"
                                    ? ` · ${optionCount}`
                                    : ""}
                                </Badge>
                              )}
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-0.5 font-mono">
                            {cfg.field_key}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0 min-h-[44px] min-w-[44px]"
                          onClick={() => openFieldEditor(key)}
                          aria-label={`Edit ${cfg.label || cfg.field_key}`}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                      </div>
                    );
                  })}
              </div>
              <Button
                onClick={saveFormBuilderSettings}
                disabled={savingFormBuilder}
                className="w-full min-h-[44px]"
                data-testid="mobile-settings-save-form-builder"
              >
                <Save className="h-4 w-4 mr-2" />
                {savingFormBuilder ? "Saving…" : "Save Form Builder"}
              </Button>
            </CardContent>
          </Card>

          {/* Expense Detail View Order */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Expense Detail — Field Order
              </CardTitle>
              <CardDescription className="text-xs">
                Reorder the Additional Information fields shown in expense
                detail view.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {loadingDetailView ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : detailViewFields.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="mobile-settings-detail-empty"
                >
                  No custom fields found. Add fields via Categories first.
                </p>
              ) : (
                <>
                  <div className="rounded-lg border divide-y">
                    {detailViewFields.map((field, index) => (
                      <div key={field.id} className="px-3 py-2">
                        <div className="flex items-center gap-3">
                          <span className="w-5 text-center text-xs font-medium text-muted-foreground select-none">
                            {index + 1}
                          </span>
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium truncate">
                              {field.name}
                            </span>
                            <Badge
                              variant="secondary"
                              className="ml-1.5 text-[10px] px-1 py-0 align-middle"
                            >
                              {field.field_type}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-0.5">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9"
                              disabled={index === 0}
                              onClick={() => moveDetailViewField(index, "up")}
                              aria-label="Move up"
                            >
                              <ChevronUp className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9"
                              disabled={index === detailViewFields.length - 1}
                              onClick={() =>
                                moveDetailViewField(index, "down")
                              }
                              aria-label="Move down"
                            >
                              <ChevronDown className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                        {(field.field_type === "select" ||
                          field.field_type === "checkbox") &&
                          field.options &&
                          field.options.length > 0 && (
                            <div className="flex flex-wrap gap-1 pl-8 pt-1.5">
                              {field.options.map((opt) => (
                                <Badge
                                  key={opt}
                                  variant="outline"
                                  className="text-[10px] px-1 py-0 font-normal text-muted-foreground"
                                >
                                  {opt}
                                </Badge>
                              ))}
                            </div>
                          )}
                      </div>
                    ))}
                  </div>
                  <Button
                    onClick={saveDetailViewOrder}
                    disabled={savingDetailView}
                    className="w-full min-h-[44px] gap-2"
                    data-testid="mobile-settings-save-detail-view"
                  >
                    <Save className="h-4 w-4" />
                    {savingDetailView ? "Saving…" : "Save View Order"}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {/* Additional Information Layout */}
          {organizationId && (
            <AdditionalInfoLayoutSection organizationId={organizationId} compact />
          )}

          {/* Organization Logo */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <ImageIcon className="h-4 w-4" />
                <CardTitle className="text-base">Organisation Logo</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 border-2 border-border rounded-lg flex items-center justify-center bg-muted overflow-hidden shrink-0">
                  {logoPreview ? (
                    <img
                      src={logoPreview}
                      alt="Preview"
                      className="h-full w-full object-contain"
                    />
                  ) : organization?.logo_url ? (
                    <img
                      src={organization.logo_url}
                      alt={organization.name ?? "Logo"}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <ImageIcon className="h-6 w-6 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-muted-foreground">
                    {organization?.logo_url
                      ? "Current logo"
                      : "No logo uploaded"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    PNG, JPG, SVG, WebP — max 2 MB
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="m-logo-upload">Upload New Logo</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="m-logo-upload"
                    type="file"
                    accept="image/png,image/jpeg,image/jpg,image/svg+xml,image/webp"
                    onChange={(e) =>
                      handleLogoFileChange(e.target.files?.[0] ?? null)
                    }
                    disabled={uploadingLogo}
                    className="text-sm"
                  />
                  {logoFile && (
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0 h-9 w-9"
                      onClick={() => {
                        setLogoFile(null);
                        setLogoPreview(null);
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex gap-2 flex-wrap">
                {logoFile && (
                  <Button
                    onClick={handleLogoUpload}
                    disabled={uploadingLogo}
                    className="min-h-[44px]"
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    {uploadingLogo ? "Uploading…" : "Upload Logo"}
                  </Button>
                )}
                {organization?.logo_url && !logoFile && (
                  <Button
                    variant="destructive"
                    onClick={handleLogoDelete}
                    disabled={uploadingLogo}
                    className="min-h-[44px]"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Remove Logo
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Location Management */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4" />
                  <CardTitle className="text-base">Locations</CardTitle>
                </div>
                <Button
                  size="sm"
                  onClick={() => openLocationDialog()}
                  className="min-h-[44px]"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {loadingLocations ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : locations.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground">
                  <MapPin className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">No locations yet</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {locations.map((loc) => (
                    <div
                      key={loc.id}
                      className="flex items-center justify-between p-3 border rounded-lg"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="font-medium text-sm truncate">
                          {loc.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9"
                          onClick={() => openLocationDialog(loc)}
                          aria-label={`Edit ${loc.name}`}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-destructive"
                          onClick={() => openDeleteLocationDialog(loc)}
                          aria-label={`Delete ${loc.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Data & Backup */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4" />
                <CardTitle className="text-base">Data & Backup</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Download or restore organisation data.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="m-include-receipts"
                  checked={includeReceipts}
                  onCheckedChange={(v) => setIncludeReceipts(v === true)}
                />
                <Label
                  htmlFor="m-include-receipts"
                  className="text-sm font-normal cursor-pointer"
                >
                  Include receipt files (downloads as ZIP)
                </Label>
              </div>
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  onClick={handleDownloadBackup}
                  disabled={backupLoading || !organizationId}
                  className="w-full min-h-[44px]"
                >
                  <Download className="h-4 w-4 mr-2" />
                  {backupLoading
                    ? "Preparing…"
                    : includeReceipts
                      ? "Download backup (ZIP)"
                      : "Download data backup"}
                </Button>
                <input
                  ref={restoreFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleRestoreFileSelect}
                />
                <Button
                  variant="outline"
                  onClick={() => restoreFileInputRef.current?.click()}
                  disabled={restoreLoading || !organizationId}
                  className="w-full min-h-[44px]"
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Restore from backup
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
