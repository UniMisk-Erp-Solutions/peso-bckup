import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { LanguageSelector } from "@/components/LanguageSelector";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useDashboardTheme } from "@/hooks/useDashboardTheme";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Settings as SettingsIcon, Save, Bell, Volume2, VolumeX, MapPin, Plus, Edit, Trash2, Upload, Image as ImageIcon, X, Database, Download, RotateCcw, ChevronUp, ChevronDown, LayoutList } from "lucide-react";
import { fetchOrgBackup, downloadBackup, downloadBackupWithReceipts, fetchReceiptBlobs, restoreFromBackup, parseBackupFile, getBackupPreview, type BackupPayload } from "@/lib/backupData";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { formatINR } from "@/lib/format";
import { DEFAULT_BASE_FIELD_CONFIG, normalizeBaseFieldOptions, resolveBaseFieldConfig, type BaseExpenseFieldKey, type BaseFieldConfig, type BaseFieldInputType } from "@/lib/expenseFormConfig";
import { useBatchExpenseEntry } from "@/hooks/useBatchExpenseEntry";
import { TeamManagementSection } from "@/components/TeamManagementSection";
import { DailyExpenseReportMappingSection } from "@/components/DailyExpenseReportMappingSection";
import { ExpenseDateLockSection } from "@/components/ExpenseDateLockSection";
import { PwaInstallSettingsSection } from "@/components/PwaInstallSettingsSection";
import { AdditionalInfoLayoutSection } from "@/components/AdditionalInfoLayoutSection";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { invalidateOrgSettings } from "@/lib/orgSettingsCache";
import type { BatchExpenseAttachmentMode } from "@/lib/expenseBatchConstants";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileSettingsView } from "@/components/mobile/MobileSettingsView";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";

interface NotificationSettings {
  popup_enabled: boolean;
  sound_enabled: boolean;
  desktop_enabled: boolean;
}

export default function Settings() {
  const { t } = useTranslation("settings");
  const [dashboardTheme, setDashboardTheme] = useDashboardTheme();
  const {
    userRole,
    user,
    organizationId,
    organization,
    refreshOrganization,
    hasOrganizationFeature,
  } = useAuth();
  const hierarchyEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.approval_hierarchy,
  );
  const teamsEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.teams_enabled,
  );
  const dailyProjectReportEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.daily_project_expense_report,
  );
  const baseFieldCustomizationEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.allow_base_field_input_customization,
  );
  const expenseDateLockingEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.expense_date_locking,
  );
  const { batchExpenseEntryEnabled } = useBatchExpenseEntry();
  const { toast } = useToast();
  
  // Admin settings
  const [engineerApprovalLimit, setEngineerApprovalLimit] = useState<string>("50000");
  const [disableManagerApprovalLimit, setDisableManagerApprovalLimit] =
    useState<boolean>(false);
  const [attachmentRequiredAboveAmount, setAttachmentRequiredAboveAmount] = useState<string>("50");
  const [allowCashierExpenseSubmission, setAllowCashierExpenseSubmission] = useState<boolean>(false);
  const [requireImmediateSupervisor, setRequireImmediateSupervisor] = useState<boolean>(false);
  const [batchExpenseAttachmentMode, setBatchExpenseAttachmentMode] =
    useState<BatchExpenseAttachmentMode>("per_line");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [baseFieldConfig, setBaseFieldConfig] = useState<Record<BaseExpenseFieldKey, BaseFieldConfig>>(DEFAULT_BASE_FIELD_CONFIG);
  const [savingFormBuilder, setSavingFormBuilder] = useState(false);
  const [editingFieldKey, setEditingFieldKey] = useState<BaseExpenseFieldKey | null>(null);
  const [fieldDraft, setFieldDraft] = useState<BaseFieldConfig | null>(null);

  // Expense detail view order builder
  const [detailViewFields, setDetailViewFields] = useState<{ id: string; name: string; field_type: string; options?: string[] | null }[]>([]);
  const [loadingDetailView, setLoadingDetailView] = useState(false);
  const [savingDetailView, setSavingDetailView] = useState(false);
  
  // Logo upload
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  
  // Notification settings
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>({
    popup_enabled: true,
    sound_enabled: true,
    desktop_enabled: true, // Enable by default for Windows notifications
  });
  const [loadingNotifications, setLoadingNotifications] = useState(true);

  // Location management
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);
  const [locationToEdit, setLocationToEdit] = useState<{ id: string; name: string } | null>(null);
  const [locationName, setLocationName] = useState("");
  const [savingLocation, setSavingLocation] = useState(false);
  const [deleteLocationDialogOpen, setDeleteLocationDialogOpen] = useState(false);
  const [locationToDelete, setLocationToDelete] = useState<{ id: string; name: string } | null>(null);
  const [deletingLocation, setDeletingLocation] = useState(false);

  // Data & backup
  const [backupLoading, setBackupLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [restorePreview, setRestorePreview] = useState<BackupPayload | null>(null);
  const [includeReceipts, setIncludeReceipts] = useState(false);
  const restoreFileInputRef = useRef<HTMLInputElement>(null);
  const { isMobile } = useViewportMode();
  const {
    progress: loadProgress,
    startOperation: startLoadProgress,
    completeOperation: completeLoadProgress,
  } = useOperationProgress();
  const {
    progress: saveProgress,
    startOperation: startSaveProgress,
    completeOperation: completeSaveProgress,
    failOperation: failSaveProgress,
  } = useOperationProgress();
  const prevLoadingRef = useRef(false);
  const prevSavingRef = useRef(false);

  useEffect(() => {
    if (userRole === "admin" && organizationId) {
      fetchSettings();
      fetchLocations();
      fetchFormBuilderSettings();
      fetchDetailViewFields();
    }
    if (user) {
      loadNotificationSettings();
    }
  }, [userRole, user, organizationId]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;
    if (loading && !wasLoading) {
      startLoadProgress("Loading settings…", { description: "Fetching organisation configuration" });
    } else if (!loading && wasLoading) {
      completeLoadProgress("Settings loaded");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  useEffect(() => {
    const wasSaving = prevSavingRef.current;
    prevSavingRef.current = saving;
    if (saving && !wasSaving) {
      startSaveProgress("Saving settings…");
    } else if (!saving && wasSaving) {
      completeSaveProgress("Settings saved");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving]);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      if (!organizationId) {
        setLoading(false);
        return;
      }

      // Prefer full organization_settings (including allow_cashier_expense_submission)
      let orgSettings: {
        engineer_approval_limit?: number | null;
        attachment_required_above_amount?: number | null;
        allow_cashier_expense_submission?: boolean | null;
        batch_expense_attachment_mode?: string | null;
        require_immediate_supervisor?: boolean | null;
      } | null = null;
      const { data: fullSettings, error: fullError } = await supabase
        .from("organization_settings")
        .select("engineer_approval_limit, attachment_required_above_amount, allow_cashier_expense_submission, batch_expense_attachment_mode, require_immediate_supervisor")
        .eq("organization_id", organizationId)
        .maybeSingle();

      if (!fullError && fullSettings) {
        orgSettings = fullSettings;
      } else if (fullError && (fullError.code === "42703" || fullError.message?.includes("allow_cashier_expense_submission"))) {
        // Column might not exist yet (migration not run) – fetch without it
        const { data: fallbackSettings, error: fallbackError } = await supabase
          .from("organization_settings")
          .select("engineer_approval_limit, attachment_required_above_amount")
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (!fallbackError && fallbackSettings) orgSettings = fallbackSettings;
      }

      if (orgSettings) {
        if (orgSettings.engineer_approval_limit !== null && orgSettings.engineer_approval_limit !== undefined) {
          setEngineerApprovalLimit(orgSettings.engineer_approval_limit.toString());
          setDisableManagerApprovalLimit(false);
        } else {
          setDisableManagerApprovalLimit(true);
        }
        if (orgSettings.attachment_required_above_amount !== null && orgSettings.attachment_required_above_amount !== undefined) {
          setAttachmentRequiredAboveAmount(orgSettings.attachment_required_above_amount.toString());
        }
        if (orgSettings.allow_cashier_expense_submission !== null && orgSettings.allow_cashier_expense_submission !== undefined) {
          setAllowCashierExpenseSubmission(orgSettings.allow_cashier_expense_submission === true);
        }
        if (orgSettings.require_immediate_supervisor !== null && orgSettings.require_immediate_supervisor !== undefined) {
          setRequireImmediateSupervisor(orgSettings.require_immediate_supervisor === true);
        }
        if (orgSettings.batch_expense_attachment_mode === "shared") {
          setBatchExpenseAttachmentMode("shared");
        } else {
          setBatchExpenseAttachmentMode("per_line");
        }
        setLoading(false);
        return;
      }

      // Fallback to settings table
      const { data: settingsData, error } = await supabase
        .from("settings")
        .select("*")
        .eq("organization_id", organizationId)
        .in("key", ["engineer_approval_limit", "attachment_required_above_amount"]);

      if (error) {
        // If table doesn't exist, show helpful message
        if (error.code === '42P01' || error.message.includes('does not exist')) {
          console.warn("Settings table does not exist. Please run the SQL migration first.");
          // Keep default values
          setLoading(false);
          return;
        }
        throw error;
      }

      if (settingsData) {
        const approvalLimit = settingsData.find(s => s.key === "engineer_approval_limit");
        const attachmentLimit = settingsData.find(s => s.key === "attachment_required_above_amount");
        
        if (approvalLimit) {
          const parsed = Number(approvalLimit.value);
          if (Number.isFinite(parsed) && parsed > 0) {
            setEngineerApprovalLimit(approvalLimit.value);
            setDisableManagerApprovalLimit(false);
          } else {
            setDisableManagerApprovalLimit(true);
          }
        }
        if (attachmentLimit) {
          setAttachmentRequiredAboveAmount(attachmentLimit.value);
        }
      }
    } catch (error: any) {
      console.error("Error fetching settings:", error);
      // Don't show error toast if table doesn't exist - just use default
      if (error.code !== '42P01' && !error.message?.includes('does not exist')) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to load settings. Using default value.",
        });
      }
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Detail view order builder
  // ---------------------------------------------------------------------------

  const fetchDetailViewFields = async () => {
    if (!organizationId) return;
    setLoadingDetailView(true);
    try {
      // Get all templates for this org
      const { data: templates, error: tplErr } = await supabase
        .from("expense_form_field_templates")
        .select("id, name, field_type, options")
        .eq("organization_id", organizationId);
      if (tplErr || !templates || templates.length === 0) return;

      // Get the minimum display_order across all category assignments for each template
      const { data: assignments, error: assignErr } = await supabase
        .from("expense_category_form_fields")
        .select("template_id, display_order")
        .eq("organization_id", organizationId)
        .in("template_id", templates.map((t) => t.id as string));

      const orderByTemplate = new Map<string, number>();
      if (!assignErr && assignments) {
        for (const a of assignments) {
          const tid = a.template_id as string;
          const ord = (a.display_order as number) ?? 0;
          const prev = orderByTemplate.get(tid);
          if (prev === undefined || ord < prev) orderByTemplate.set(tid, ord);
        }
      }

      const sorted = [...templates]
        .map((t) => ({
          id: t.id as string,
          name: t.name as string,
          field_type: (t.field_type as string) || "text",
          options: (t.options as string[] | null) ?? null,
          _order: orderByTemplate.get(t.id as string) ?? 9999,
        }))
        .sort((a, b) => a._order - b._order || a.name.localeCompare(b.name))
        .map(({ id, name, field_type, options }) => ({ id, name, field_type, options }));

      setDetailViewFields(sorted);
    } finally {
      setLoadingDetailView(false);
    }
  };

  const moveDetailViewField = (index: number, direction: "up" | "down") => {
    const next = [...detailViewFields];
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setDetailViewFields(next);
  };

  const saveDetailViewOrder = async () => {
    if (!organizationId || detailViewFields.length === 0) return;
    setSavingDetailView(true);
    try {
      // Assign sequential display_order values (10, 20, 30, …)
      const ordered = detailViewFields.map((f, i) => ({ ...f, display_order: (i + 1) * 10 }));

      // Update expense_category_form_fields for each template (all category assignments)
      const updates = ordered.map((f) =>
        supabase
          .from("expense_category_form_fields")
          .update({ display_order: f.display_order })
          .eq("template_id", f.id)
          .eq("organization_id", organizationId),
      );
      await Promise.all(updates);

      toast({
        title: "View order saved",
        description: "Additional information fields will now appear in this order in expense details.",
      });
    } catch {
      toast({ variant: "destructive", title: "Failed to save view order" });
    } finally {
      setSavingDetailView(false);
    }
  };

  const fetchFormBuilderSettings = async () => {
    try {
      if (!organizationId) return;
      const { data, error } = await (supabase as any)
        .from("organization_expense_form_fields")
        .select("*")
        .eq("organization_id", organizationId);
      if (!error && data) {
        setBaseFieldConfig(resolveBaseFieldConfig(data as Partial<BaseFieldConfig>[]));
      }
    } catch (e) {
      console.warn("Unable to load organization_expense_form_fields");
    }
  };

  const FORCE_VISIBLE_FIELDS: BaseExpenseFieldKey[] = ["category", "amount", "expense_date"];

  const inputTypeLabel = (it: BaseFieldInputType): string =>
    ({
      default: t("formBuilder.inputTypeDefault", { defaultValue: "Default" }),
      text: t("formBuilder.inputTypeText", { defaultValue: "Text" }),
      number: t("formBuilder.inputTypeNumber", { defaultValue: "Number" }),
      dropdown: t("formBuilder.inputTypeDropdown", { defaultValue: "Dropdown" }),
    })[it] ?? it;

  const openFieldEditor = (key: BaseExpenseFieldKey) => {
    setFieldDraft({ ...baseFieldConfig[key] });
    setEditingFieldKey(key);
  };

  const closeFieldEditor = () => {
    setEditingFieldKey(null);
    setFieldDraft(null);
  };

  const applyFieldDraft = () => {
    if (!editingFieldKey || !fieldDraft) return;
    setBaseFieldConfig((prev) => ({ ...prev, [editingFieldKey]: { ...fieldDraft } }));
    closeFieldEditor();
  };

  const saveFormBuilderSettings = async () => {
    if (!organizationId) return;
    try {
      setSavingFormBuilder(true);
      const rows = (Object.keys(baseFieldConfig) as BaseExpenseFieldKey[]).map((key) => {
        const cfg = baseFieldConfig[key];
        const inputType = baseFieldCustomizationEnabled ? cfg.input_type : "default";
        const options =
          baseFieldCustomizationEnabled && inputType === "dropdown"
            ? normalizeBaseFieldOptions(cfg.options)
            : [];
        return {
          organization_id: organizationId,
          field_key: key,
          label: cfg.label,
          help_text: cfg.help_text ?? null,
          is_visible: cfg.is_visible,
          is_required: cfg.is_required,
          display_order: cfg.display_order,
          show_on_submit: cfg.show_on_submit,
          show_on_review: cfg.show_on_review,
          show_on_detail: cfg.show_on_detail,
          input_type: inputType,
          options,
        };
      });

      if (baseFieldCustomizationEnabled) {
        const amountCfg = baseFieldConfig.amount;
        if (
          amountCfg.input_type === "dropdown" &&
          normalizeBaseFieldOptions(amountCfg.options).some((o) => Number.isNaN(Number(o)))
        ) {
          toast({
            variant: "destructive",
            title: t("formBuilder.amountOptionsInvalidTitle", { defaultValue: "Invalid amount options" }),
            description: t("formBuilder.amountOptionsInvalidHint", {
              defaultValue: "Amount dropdown options must all be numbers.",
            }),
          });
          setSavingFormBuilder(false);
          return;
        }
      }
      const { error } = await (supabase as any)
        .from("organization_expense_form_fields")
        .upsert(rows, { onConflict: "organization_id,field_key" });
      if (error) throw error;
      toast({ title: "Form builder updated", description: "Base expense fields have been saved." });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed to save form builder", description: e?.message || "Try again." });
    } finally {
      setSavingFormBuilder(false);
    }
  };

  const saveSettings = async () => {
    try {
      setSaving(true);
      const limitValue = disableManagerApprovalLimit
        ? Number.POSITIVE_INFINITY
        : parseFloat(engineerApprovalLimit);
      const attachmentLimitValue = parseFloat(attachmentRequiredAboveAmount);
      
      if (!disableManagerApprovalLimit && (isNaN(limitValue) || limitValue < 0)) {
        toast({
          variant: "destructive",
          title: "Invalid Input",
          description: "Please enter a valid positive number for Manager Approval Limit",
        });
        return;
      }

      if (isNaN(attachmentLimitValue) || attachmentLimitValue < 0) {
        toast({
          variant: "destructive",
          title: "Invalid Input",
          description: "Please enter a valid positive number for Attachment Required Above Amount",
        });
        return;
      }

      if (!organizationId) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Organization not found. Please contact support.",
        });
        return;
      }

      // Upsert both settings with organization_id
      const { error: settingsError } = await supabase
        .from("settings")
        .upsert([
          {
            key: "engineer_approval_limit",
            value: disableManagerApprovalLimit ? "-1" : limitValue.toString(),
            organization_id: organizationId,
            description: "Maximum amount (in rupees) that engineers can approve directly. Expenses below this limit can be approved by engineers, above this limit must go to admin.",
            updated_at: new Date().toISOString(),
          },
          {
            key: "attachment_required_above_amount",
            value: attachmentLimitValue.toString(),
            organization_id: organizationId,
            description: "Amount threshold (in rupees) above which bill attachments become mandatory. Expenses at or below this amount do not require attachments.",
            updated_at: new Date().toISOString(),
          }
        ], {
          onConflict: "key,organization_id"
        });

      if (settingsError) {
        if (settingsError.code === '42P01' || settingsError.message.includes('does not exist')) {
          toast({
            variant: "destructive",
            title: "Database Table Missing",
            description: "Please run the SQL migration to create the settings table first. Check supabase/migrations/20250113000000_create_settings_table.sql",
          });
          return;
        }
        throw settingsError;
      }

      // Also update organization_settings table (used by ExpenseService)
      const { error: orgSettingsError } = await supabase
        .from("organization_settings")
        .upsert({
          organization_id: organizationId,
          engineer_approval_limit: disableManagerApprovalLimit ? null : limitValue,
          attachment_required_above_amount: attachmentLimitValue,
          allow_cashier_expense_submission: allowCashierExpenseSubmission,
          batch_expense_attachment_mode: batchExpenseAttachmentMode,
          require_immediate_supervisor: hierarchyEnabled ? requireImmediateSupervisor : false,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: "organization_id"
        });

      if (orgSettingsError) {
        console.error("Error updating organization_settings:", orgSettingsError);
      } else if (organizationId) {
        invalidateOrgSettings(organizationId);
      }

      toast({
        title: t("saved"),
        description: t("saved"),
      });
    } catch (error: any) {
      console.error("Error saving settings:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to save settings",
      });
    } finally {
      setSaving(false);
    }
  };

  const loadNotificationSettings = async () => {
    try {
      setLoadingNotifications(true);
      const { data, error } = await supabase
        .from("profiles")
        .select("notification_settings")
        .eq("user_id", user?.id)
        .maybeSingle();

      if (!error && data?.notification_settings) {
        setNotificationSettings({
          popup_enabled: data.notification_settings.popup_enabled ?? true,
          sound_enabled: data.notification_settings.sound_enabled ?? true,
          desktop_enabled: data.notification_settings.desktop_enabled ?? false,
        });
      } else {
        const stored = localStorage.getItem(`notification_settings_${user?.id}`);
        if (stored) {
          try {
            setNotificationSettings(JSON.parse(stored));
          } catch {
            // use defaults
          }
        }
      }
    } catch {
      // 400 etc. (e.g. notification_settings column missing) – use localStorage or defaults
      const stored = localStorage.getItem(`notification_settings_${user?.id}`);
      if (stored) {
        try {
          setNotificationSettings(JSON.parse(stored));
        } catch {
          // use defaults
        }
      }
    } finally {
      setLoadingNotifications(false);
    }
  };

  const saveNotificationSettings = async (newSettings: NotificationSettings) => {
    try {
      setNotificationSettings(newSettings);
      
      // Save to localStorage immediately
      localStorage.setItem(`notification_settings_${user?.id}`, JSON.stringify(newSettings));

      // Try to save to database
      const { error } = await supabase
        .from("profiles")
        .update({
          notification_settings: newSettings,
        })
        .eq("user_id", user?.id);

      if (error) {
        console.error("Error saving to database, using localStorage only:", error);
      }

      toast({
        title: "Settings saved",
        description: "Your notification preferences have been updated",
      });
    } catch (error) {
      console.error("Error saving notification settings:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save settings",
      });
    }
  };

  const updateNotificationSetting = (key: keyof NotificationSettings, value: boolean) => {
    const newSettings = { ...notificationSettings, [key]: value };
    saveNotificationSettings(newSettings);
  };

  // Location management functions
  const fetchLocations = async () => {
    try {
      setLoadingLocations(true);
      if (!organizationId) {
        setLoadingLocations(false);
        return;
      }
      const { data, error } = await supabase
        .from("locations")
        .select("id, name")
        .eq("organization_id", organizationId)
        .order("name", { ascending: true });

      if (error) throw error;
      setLocations(data || []);
    } catch (error: any) {
      console.error("Error fetching locations:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to load locations",
      });
    } finally {
      setLoadingLocations(false);
    }
  };

  const openLocationDialog = (location?: { id: string; name: string }) => {
    if (location) {
      setLocationToEdit(location);
      setLocationName(location.name);
    } else {
      setLocationToEdit(null);
      setLocationName("");
    }
    setLocationDialogOpen(true);
  };

  const saveLocation = async () => {
    if (!locationName.trim()) {
      toast({
        variant: "destructive",
        title: "Invalid Input",
        description: "Location name cannot be empty",
      });
      return;
    }

    try {
      setSavingLocation(true);
      if (!organizationId) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Organization not found. Please contact support.",
        });
        return;
      }

      if (locationToEdit) {
        // Update existing location
        const { error } = await supabase
          .from("locations")
          .update({ name: locationName.trim(), updated_at: new Date().toISOString() })
          .eq("id", locationToEdit.id)
          .eq("organization_id", organizationId);

        if (error) throw error;
        toast({
          title: "Location Updated",
          description: `Location "${locationName}" has been updated successfully`,
        });
      } else {
        // Create new location with organization_id
        const { error } = await supabase
          .from("locations")
          .insert({ 
            name: locationName.trim(),
            organization_id: organizationId
          });

        if (error) throw error;
        toast({
          title: "Location Created",
          description: `Location "${locationName}" has been created successfully`,
        });
      }
      setLocationDialogOpen(false);
      setLocationName("");
      setLocationToEdit(null);
      fetchLocations();
    } catch (error: any) {
      console.error("Error saving location:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to save location",
      });
    } finally {
      setSavingLocation(false);
    }
  };

  const openDeleteLocationDialog = (location: { id: string; name: string }) => {
    setLocationToDelete(location);
    setDeleteLocationDialogOpen(true);
  };

  const deleteLocation = async () => {
    if (!locationToDelete) return;

    try {
      setDeletingLocation(true);
      if (!organizationId) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Organization not found.",
        });
        return;
      }
      const { error } = await supabase
        .from("locations")
        .delete()
        .eq("id", locationToDelete.id)
        .eq("organization_id", organizationId);

      if (error) throw error;
      toast({
        title: "Location Deleted",
        description: `Location "${locationToDelete.name}" has been deleted`,
      });
      setDeleteLocationDialogOpen(false);
      setLocationToDelete(null);
      fetchLocations();
    } catch (error: any) {
      console.error("Error deleting location:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to delete location",
      });
    } finally {
      setDeletingLocation(false);
    }
  };

  const handleDownloadBackup = async () => {
    if (!organizationId) return;
    try {
      setBackupLoading(true);
      const payload = await fetchOrgBackup(supabase, organizationId);
      if (includeReceipts && payload.attachments.length > 0) {
        const receiptBlobs = await fetchReceiptBlobs(supabase, payload.attachments);
        await downloadBackupWithReceipts(payload, receiptBlobs);
        toast({ title: "Backup downloaded", description: `Data and ${receiptBlobs.length} receipt file(s) saved.` });
      } else {
        downloadBackup(payload);
        toast({ title: "Backup downloaded", description: "Your organization data has been saved." });
      }
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Backup failed",
        description: e instanceof Error ? e.message : "Failed to prepare backup.",
      });
    } finally {
      setBackupLoading(false);
    }
  };

  const handleRestoreFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const payload = await parseBackupFile(file);
      if (payload.organizationId !== organizationId) {
        toast({
          variant: "destructive",
          title: "Wrong organization",
          description: "This backup is for a different organization. Restore only allowed for the same organization.",
        });
        return;
      }
      setRestorePreview(payload);
      setRestoreFile(file);
      setRestoreConfirmOpen(true);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Invalid file",
        description: err instanceof Error ? err.message : "Could not read backup file.",
      });
    }
    e.target.value = "";
  };

  const handleRestoreConfirm = async () => {
    if (!restoreFile || !organizationId) return;
    try {
      setRestoreLoading(true);
      const result = await restoreFromBackup(supabase, organizationId, restoreFile);
      if (result.success) {
        toast({ title: "Restore complete", description: "Data has been restored." });
        setRestoreConfirmOpen(false);
        setRestoreFile(null);
        setRestorePreview(null);
      } else {
        toast({ variant: "destructive", title: "Restore failed", description: result.error });
      }
    } finally {
      setRestoreLoading(false);
    }
  };

  const handleLogoUpload = async () => {
    if (!logoFile || !organizationId || !user) return;

    try {
      setUploadingLogo(true);

      // First, delete any existing logo files for this organization
      if (organization?.logo_url) {
        try {
          const urlParts = organization.logo_url.split('/');
          const publicIndex = urlParts.findIndex(part => part === 'public');
          if (publicIndex !== -1 && publicIndex < urlParts.length - 1) {
            const pathAfterPublic = urlParts.slice(publicIndex + 1).join('/');
            const fileName = pathAfterPublic.replace('organization-logos/', '');
            
            // Delete old file
            await supabase.storage
              .from('organization-logos')
              .remove([fileName]);
          }
        } catch (deleteError) {
          console.warn("Error deleting old logo:", deleteError);
          // Continue with upload even if deletion fails
        }
      }

      // Also try to delete any existing logo files with different extensions
      try {
        const { data: existingFiles } = await supabase.storage
          .from('organization-logos')
          .list(organizationId);
        
        if (existingFiles && existingFiles.length > 0) {
          const filesToDelete = existingFiles
            .filter(file => file.name.startsWith('logo.'))
            .map(file => `${organizationId}/${file.name}`);
          
          if (filesToDelete.length > 0) {
            await supabase.storage
              .from('organization-logos')
              .remove(filesToDelete);
          }
        }
      } catch (listError) {
        console.warn("Error listing existing files:", listError);
        // Continue with upload
      }

      // Get file extension
      const fileExt = logoFile.name.split('.').pop();
      // Add timestamp to filename to ensure uniqueness and prevent caching
      const timestamp = Date.now();
      const fileName = `${organizationId}/logo_${timestamp}.${fileExt}`;

      // Upload file to storage
      const { error: uploadError } = await supabase.storage
        .from('organization-logos')
        .upload(fileName, logoFile, {
          cacheControl: '0', // No cache
          upsert: false // Don't overwrite, use unique filename
        });

      if (uploadError) throw uploadError;

      // Get public URL with cache-busting query parameter
      const { data: urlData } = supabase.storage
        .from('organization-logos')
        .getPublicUrl(fileName);

      if (!urlData?.publicUrl) {
        throw new Error('Failed to get logo URL');
      }

      // Add cache-busting query parameter
      const logoUrlWithCacheBust = `${urlData.publicUrl}?t=${timestamp}`;

      // Update organization with logo URL
      const { error: updateError } = await supabase
        .from('organizations')
        .update({ logo_url: logoUrlWithCacheBust })
        .eq('id', organizationId);

      if (updateError) throw updateError;

      // Refresh organization data
      await refreshOrganization();

      // Update cache with new logo
      if (user?.email) {
        const { cacheOrganization } = await import('@/lib/organizationCache');
        const updatedOrg = await supabase
          .from('organizations')
          .select('id, name, logo_url')
          .eq('id', organizationId)
          .single();
        
        if (updatedOrg.data) {
          cacheOrganization(user.email, {
            id: updatedOrg.data.id,
            name: updatedOrg.data.name,
            logo_url: updatedOrg.data.logo_url || null
          });
        }
      }

      // Clear file selection
      setLogoFile(null);
      setLogoPreview(null);

      toast({
        title: "Logo Updated",
        description: "Organization logo has been updated successfully.",
      });
    } catch (error: any) {
      console.error("Error uploading logo:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to upload logo",
      });
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleLogoDelete = async () => {
    if (!organizationId || !organization?.logo_url) return;

    try {
      setUploadingLogo(true);

      // Remove query parameters from URL if present
      const logoUrl = organization.logo_url.split('?')[0];

      // Extract file path from URL
      // URL format: https://[project].supabase.co/storage/v1/object/public/organization-logos/[org-id]/logo.[ext]
      const urlParts = logoUrl.split('/');
      const publicIndex = urlParts.findIndex(part => part === 'public');
      if (publicIndex === -1 || publicIndex >= urlParts.length - 1) {
        throw new Error('Invalid logo URL format');
      }
      // Get everything after 'public/' which should be 'organization-logos/[org-id]/logo.[ext]'
      const pathAfterPublic = urlParts.slice(publicIndex + 1).join('/');
      // Remove 'organization-logos/' prefix to get just '[org-id]/logo.[ext]'
      const fileName = pathAfterPublic.replace('organization-logos/', '');

      // Delete file from storage
      const { error: deleteError } = await supabase.storage
        .from('organization-logos')
        .remove([fileName]);

      if (deleteError) {
        console.warn("Error deleting logo file:", deleteError);
        // Continue to remove URL from database even if file deletion fails
      }

      // Also try to delete any other logo files for this organization
      try {
        const { data: existingFiles } = await supabase.storage
          .from('organization-logos')
          .list(organizationId);
        
        if (existingFiles && existingFiles.length > 0) {
          const filesToDelete = existingFiles
            .filter(file => file.name.startsWith('logo'))
            .map(file => `${organizationId}/${file.name}`);
          
          if (filesToDelete.length > 0) {
            await supabase.storage
              .from('organization-logos')
              .remove(filesToDelete);
          }
        }
      } catch (listError) {
        console.warn("Error listing files for cleanup:", listError);
      }

      // Remove logo URL from organization
      const { error: updateError } = await supabase
        .from('organizations')
        .update({ logo_url: null })
        .eq('id', organizationId);

      if (updateError) throw updateError;

      // Refresh organization data
      await refreshOrganization();

      // Update cache to remove logo
      if (user?.email) {
        const { cacheOrganization } = await import('@/lib/organizationCache');
        const updatedOrg = await supabase
          .from('organizations')
          .select('id, name, logo_url')
          .eq('id', organizationId)
          .single();
        
        if (updatedOrg.data) {
          cacheOrganization(user.email, {
            id: updatedOrg.data.id,
            name: updatedOrg.data.name,
            logo_url: null
          });
        }
      }

      toast({
        title: "Logo Removed",
        description: "Organization logo has been removed",
      });
    } catch (error: any) {
      console.error("Error deleting logo:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to remove logo",
      });
    } finally {
      setUploadingLogo(false);
    }
  };

  if (isMobile) {
    return (
      <>
        <MobileSettingsView
          userRole={userRole}
          organizationId={organizationId ?? null}
          organization={organization ?? null}
          hierarchyEnabled={hierarchyEnabled}
          teamsEnabled={teamsEnabled}
          dailyProjectReportEnabled={dailyProjectReportEnabled}
          expenseDateLockingEnabled={expenseDateLockingEnabled}
          baseFieldCustomizationEnabled={baseFieldCustomizationEnabled}
          batchExpenseEntryEnabled={batchExpenseEntryEnabled}
          dashboardTheme={dashboardTheme}
          setDashboardTheme={setDashboardTheme}
          notificationSettings={notificationSettings}
          loadingNotifications={loadingNotifications}
          updateNotificationSetting={updateNotificationSetting}
          loading={loading}
          saving={saving}
          engineerApprovalLimit={engineerApprovalLimit}
          setEngineerApprovalLimit={setEngineerApprovalLimit}
          disableManagerApprovalLimit={disableManagerApprovalLimit}
          setDisableManagerApprovalLimit={setDisableManagerApprovalLimit}
          attachmentRequiredAboveAmount={attachmentRequiredAboveAmount}
          setAttachmentRequiredAboveAmount={setAttachmentRequiredAboveAmount}
          allowCashierExpenseSubmission={allowCashierExpenseSubmission}
          setAllowCashierExpenseSubmission={setAllowCashierExpenseSubmission}
          requireImmediateSupervisor={requireImmediateSupervisor}
          setRequireImmediateSupervisor={setRequireImmediateSupervisor}
          batchExpenseAttachmentMode={batchExpenseAttachmentMode}
          setBatchExpenseAttachmentMode={setBatchExpenseAttachmentMode}
          saveSettings={saveSettings}
          baseFieldConfig={baseFieldConfig}
          savingFormBuilder={savingFormBuilder}
          saveFormBuilderSettings={saveFormBuilderSettings}
          openFieldEditor={openFieldEditor}
          detailViewFields={detailViewFields}
          loadingDetailView={loadingDetailView}
          savingDetailView={savingDetailView}
          moveDetailViewField={moveDetailViewField}
          saveDetailViewOrder={saveDetailViewOrder}
          logoPreview={logoPreview}
          logoFile={logoFile}
          uploadingLogo={uploadingLogo}
          setLogoFile={setLogoFile}
          setLogoPreview={setLogoPreview}
          handleLogoUpload={handleLogoUpload}
          handleLogoDelete={handleLogoDelete}
          locations={locations}
          loadingLocations={loadingLocations}
          openLocationDialog={openLocationDialog}
          openDeleteLocationDialog={openDeleteLocationDialog}
          backupLoading={backupLoading}
          restoreLoading={restoreLoading}
          includeReceipts={includeReceipts}
          setIncludeReceipts={setIncludeReceipts}
          handleDownloadBackup={handleDownloadBackup}
          restoreFileInputRef={restoreFileInputRef}
          handleRestoreFileSelect={handleRestoreFileSelect}
        />

        {/* Field editor dialog — portal renders to body, works on mobile */}
        <Dialog
          open={editingFieldKey !== null}
          onOpenChange={(open) => {
            if (!open) closeFieldEditor();
          }}
        >
          <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
            {editingFieldKey && fieldDraft && (() => {
              const key = editingFieldKey;
              const forceVisible = FORCE_VISIBLE_FIELDS.includes(key);
              return (
                <>
                  <DialogHeader>
                    <DialogTitle>
                      {t("formBuilder.editTitle", { defaultValue: "Edit field" })} ·{" "}
                      <span className="font-mono text-base">{fieldDraft.field_key}</span>
                    </DialogTitle>
                    <DialogDescription>
                      {t("formBuilder.editDescription", {
                        defaultValue: "Configure how this built-in field appears in the expense form.",
                      })}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-1">
                    <div className="space-y-1.5">
                      <Label>{t("formBuilder.fieldLabel", { defaultValue: "Label" })}</Label>
                      <Input
                        value={fieldDraft.label}
                        onChange={(e) => setFieldDraft((d) => (d ? { ...d, label: e.target.value } : d))}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>{t("formBuilder.displayOrder", { defaultValue: "Display order" })}</Label>
                      <Input
                        type="number"
                        value={fieldDraft.display_order}
                        onChange={(e) =>
                          setFieldDraft((d) => d ? { ...d, display_order: Number(e.target.value || 0) } : d)
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div className="pr-3">
                        <p className="text-sm font-medium">{t("formBuilder.visible", { defaultValue: "Visible" })}</p>
                        <p className="text-xs text-muted-foreground">
                          {forceVisible
                            ? t("formBuilder.visibleCore", { defaultValue: "Core field — always visible" })
                            : t("formBuilder.visibleHint", { defaultValue: "Show this field on the form" })}
                        </p>
                      </div>
                      <Switch
                        checked={forceVisible ? true : fieldDraft.is_visible}
                        disabled={forceVisible}
                        onCheckedChange={(v) => setFieldDraft((d) => (d ? { ...d, is_visible: v } : d))}
                      />
                    </div>
                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div className="pr-3">
                        <p className="text-sm font-medium">{t("formBuilder.required", { defaultValue: "Required" })}</p>
                        <p className="text-xs text-muted-foreground">
                          {t("formBuilder.requiredHint", { defaultValue: "Users must fill this field before submitting" })}
                        </p>
                      </div>
                      <Switch
                        checked={fieldDraft.is_required}
                        onCheckedChange={(v) => setFieldDraft((d) => (d ? { ...d, is_required: v } : d))}
                      />
                    </div>
                    {baseFieldCustomizationEnabled && (
                      <div className="space-y-4 rounded-md border bg-muted/30 p-3">
                        <div className="space-y-1.5">
                          <Label>{t("formBuilder.inputType", { defaultValue: "Input type" })}</Label>
                          <Select
                            value={fieldDraft.input_type}
                            onValueChange={(v) =>
                              setFieldDraft((d) => d ? { ...d, input_type: v as BaseFieldInputType } : d)
                            }
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="default">{t("formBuilder.inputTypeDefault", { defaultValue: "Default" })}</SelectItem>
                              <SelectItem value="text">{t("formBuilder.inputTypeText", { defaultValue: "Text" })}</SelectItem>
                              <SelectItem value="number">{t("formBuilder.inputTypeNumber", { defaultValue: "Number" })}</SelectItem>
                              <SelectItem value="dropdown">{t("formBuilder.inputTypeDropdown", { defaultValue: "Dropdown" })}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {fieldDraft.input_type === "dropdown" && (
                          <div className="space-y-1.5">
                            <Label>
                              {key === "amount"
                                ? t("formBuilder.optionsLabelNumeric", { defaultValue: "Options (one per line, numbers only)" })
                                : t("formBuilder.optionsLabel", { defaultValue: "Options (one per line)" })}
                            </Label>
                            <Textarea
                              rows={5}
                              value={(fieldDraft.options ?? []).join("\n")}
                              onChange={(e) =>
                                setFieldDraft((d) => d ? { ...d, options: e.target.value.split("\n") } : d)
                              }
                              placeholder={key === "amount" ? "100\n250\n500" : "Option A\nOption B"}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={closeFieldEditor}>
                      {t("common.cancel", { defaultValue: "Cancel" })}
                    </Button>
                    <Button onClick={applyFieldDraft}>
                      {t("formBuilder.apply", { defaultValue: "Apply" })}
                    </Button>
                  </DialogFooter>
                </>
              );
            })()}
          </DialogContent>
        </Dialog>

        {/* Restore confirmation dialog */}
        <AlertDialog
          open={restoreConfirmOpen}
          onOpenChange={(open) => {
            setRestoreConfirmOpen(open);
            if (!open) { setRestoreFile(null); setRestorePreview(null); }
          }}
        >
          <AlertDialogContent className="max-w-lg">
            <AlertDialogHeader>
              <AlertDialogTitle>Restore from backup</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3">
                  <p>
                    This will add or update data for this organization. Existing rows with the same ID will be updated; new rows will be inserted.
                  </p>
                  {restorePreview && (() => {
                    const preview = getBackupPreview(restorePreview);
                    const formatDate = (d: string | null) =>
                      d ? new Date(d).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
                    return (
                      <div className="rounded-md border bg-muted/50 p-3 text-sm space-y-2">
                        <p className="font-medium text-foreground">Preview — what will be restored</p>
                        <p className="text-muted-foreground">
                          <span className="font-medium text-foreground">{preview.organizationName}</span>
                          {" · "}Backup exported {preview.exportedAt ? new Date(preview.exportedAt).toLocaleString() : "—"}
                        </p>
                        <p className="text-muted-foreground">
                          Data period:{" "}
                          <span className="text-foreground">{formatDate(preview.dataFrom)}</span>
                          {" → "}
                          <span className="text-foreground">{formatDate(preview.dataTo)}</span>
                          {!preview.dataFrom && !preview.dataTo && " (no date range in backup)"}
                        </p>
                        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground list-none">
                          {preview.counts.expenses > 0 && <li>Expenses: <span className="text-foreground font-medium">{preview.counts.expenses}</span></li>}
                          {preview.counts.profiles > 0 && <li>Profiles: <span className="text-foreground font-medium">{preview.counts.profiles}</span></li>}
                          {preview.counts.organization_memberships > 0 && <li>Memberships: <span className="text-foreground font-medium">{preview.counts.organization_memberships}</span></li>}
                          {preview.counts.expense_line_items > 0 && <li>Line items: <span className="text-foreground font-medium">{preview.counts.expense_line_items}</span></li>}
                          {preview.counts.attachments > 0 && <li>Attachments: <span className="text-foreground font-medium">{preview.counts.attachments}</span></li>}
                          {preview.counts.audit_logs > 0 && <li>Audit logs: <span className="text-foreground font-medium">{preview.counts.audit_logs}</span></li>}
                          {preview.counts.cash_transfer_history > 0 && <li>Transfers: <span className="text-foreground font-medium">{preview.counts.cash_transfer_history}</span></li>}
                          {preview.counts.expense_categories > 0 && <li>Categories: <span className="text-foreground font-medium">{preview.counts.expense_categories}</span></li>}
                          {preview.counts.locations > 0 && <li>Locations: <span className="text-foreground font-medium">{preview.counts.locations}</span></li>}
                        </ul>
                        <p className="text-muted-foreground pt-1 border-t text-xs">
                          Receipt files are not re-uploaded; only database records are restored.
                        </p>
                      </div>
                    );
                  })()}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleRestoreConfirm} disabled={restoreLoading}>
                {restoreLoading ? "Restoring…" : "Restore"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Location Dialog */}
        <Dialog open={locationDialogOpen} onOpenChange={setLocationDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{locationToEdit ? "Edit Location" : "Add New Location"}</DialogTitle>
              <DialogDescription>
                {locationToEdit ? "Update the location name" : "Create a new location for organizing engineers and teams"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="m-location-name">Location Name</Label>
                <Input
                  id="m-location-name"
                  value={locationName}
                  onChange={(e) => setLocationName(e.target.value)}
                  placeholder="e.g., London, Mumbai, Delhi"
                  onKeyDown={(e) => { if (e.key === "Enter") saveLocation(); }}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setLocationDialogOpen(false); setLocationName(""); setLocationToEdit(null); }}>
                Cancel
              </Button>
              <Button onClick={saveLocation} disabled={savingLocation || !locationName.trim()}>
                {savingLocation ? "Saving..." : locationToEdit ? "Update" : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Location Confirmation Dialog */}
        <AlertDialog open={deleteLocationDialogOpen} onOpenChange={setDeleteLocationDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Location</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete "{locationToDelete?.name}"? This will remove all engineer assignments to this location. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={deleteLocation} className="bg-red-600 hover:bg-red-700" disabled={deletingLocation}>
                {deletingLocation ? "Deleting..." : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dashboard appearance</CardTitle>
          <CardDescription>
            Choose how your dashboard looks. This only changes the visual theme — your data
            and every feature stay exactly the same.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            {([
              { id: "legacy", title: "Legacy", desc: "The original PesoWise dashboard." },
              { id: "old-money", title: "Old Money", desc: "A private-banking aesthetic — ivory, emerald & brass." },
            ] as const).map((opt) => {
              const active = dashboardTheme === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDashboardTheme(opt.id)}
                  aria-pressed={active}
                  className={`text-left rounded-xl border p-4 transition-colors ${
                    active
                      ? "border-emerald-700 ring-2 ring-emerald-700/30 bg-emerald-50/60"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{opt.title}</span>
                    {active && (
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
                        Active
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{opt.desc}</p>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("languageCardTitle")}</CardTitle>
          <CardDescription>{t("languageCardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <LanguageSelector />
        </CardContent>
      </Card>

      <PwaInstallSettingsSection />

      {/* Notification Settings - Available for all users */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Notification Preferences
          </CardTitle>
          <CardDescription>
            Control how notifications appear and behave
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {loadingNotifications ? (
            <p className="text-muted-foreground">Loading notification settings...</p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="popup" className="text-base">
                    Popup Notifications
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Show WhatsApp-style popup notifications when new notifications arrive
                  </p>
                </div>
                <Switch
                  id="popup"
                  checked={notificationSettings.popup_enabled}
                  onCheckedChange={(checked) => updateNotificationSetting("popup_enabled", checked)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="sound" className="text-base flex items-center gap-2">
                    {notificationSettings.sound_enabled ? (
                      <Volume2 className="h-4 w-4" />
                    ) : (
                      <VolumeX className="h-4 w-4" />
                    )}
                    Sound Notifications
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Play a sound when new notifications arrive
                  </p>
                </div>
                <Switch
                  id="sound"
                  checked={notificationSettings.sound_enabled}
                  onCheckedChange={(checked) => updateNotificationSetting("sound_enabled", checked)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="desktop" className="text-base">
                    Windows Desktop Notifications
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Show native Windows notifications in the notification center (like WhatsApp). Click to open the expense.
                  </p>
                </div>
                <Switch
                  id="desktop"
                  checked={notificationSettings.desktop_enabled}
                  onCheckedChange={async (checked) => {
                    if (checked && "Notification" in window) {
                      const permission = await Notification.requestPermission();
                      if (permission === "granted") {
                        updateNotificationSetting("desktop_enabled", true);
                        toast({
                          title: "Notifications enabled",
                          description: "You'll receive Windows desktop notifications for new updates",
                        });
                      } else if (permission === "denied") {
                        toast({
                          variant: "destructive",
                          title: "Permission denied",
                          description: "Please enable desktop notifications in your browser settings (Site Settings > Notifications)",
                        });
                        updateNotificationSetting("desktop_enabled", false);
                      } else {
                        updateNotificationSetting("desktop_enabled", false);
                      }
                    } else {
                      updateNotificationSetting("desktop_enabled", checked);
                    }
                  }}
                />
              </div>
              {notificationSettings.desktop_enabled && "Notification" in window && (
                <div className="mt-2 p-3 bg-blue-50 border border-blue-200 rounded-md">
                  <p className="text-xs text-blue-800">
                    ✓ Windows notifications are enabled. You'll see notifications in the Windows notification center when new updates arrive.
                    {window.location.hostname === "localhost" && (
                      <span className="block mt-1 text-blue-700">
                        Note: Some browsers may restrict notifications on localhost. If notifications don't appear, try deploying to a production URL with HTTPS.
                      </span>
                    )}
                  </p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Admin Settings - Organization admins (and visible to master_admin with a note) */}
      {(userRole === "admin" || userRole === "master_admin") && (
        <>
        {teamsEnabled && organizationId && userRole === "admin" && (
          <TeamManagementSection />
        )}
        {dailyProjectReportEnabled && organizationId && userRole === "admin" && (
          <DailyExpenseReportMappingSection />
        )}
        {expenseDateLockingEnabled && organizationId && userRole === "admin" && (
          <ExpenseDateLockSection />
        )}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <SettingsIcon className="h-5 w-5" />
              <CardTitle>Admin Settings</CardTitle>
            </div>
            <CardDescription>
              Configure organization-wide settings (organization admin only)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {userRole === "master_admin" && !organizationId ? (
              <p className="text-muted-foreground text-sm">
                Sign in as an organization administrator to change these settings (e.g. manager approval limit, attachment rules, and whether cashiers can submit expenses).
              </p>
            ) : loading ? (
              <AsyncOperationProgress
                status={loadProgress.status !== "idle" ? loadProgress.status : "running"}
                title={loadProgress.phase || "Loading settings…"}
                compact
              />
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="approval-limit">Manager Approval Limit (₹)</Label>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">Disable manager approval limit</p>
                      <p className="text-xs text-muted-foreground">
                        Managers can directly approve any amount when enabled.
                      </p>
                    </div>
                    <Switch
                      id="disable-approval-limit"
                      checked={disableManagerApprovalLimit}
                      onCheckedChange={setDisableManagerApprovalLimit}
                    />
                  </div>
                  <Input
                    id="approval-limit"
                    type="number"
                    min="0"
                    step="1"
                    value={engineerApprovalLimit}
                    onChange={(e) => setEngineerApprovalLimit(e.target.value)}
                    placeholder="50000"
                    className="max-w-xs"
                    disabled={disableManagerApprovalLimit}
                  />
                  <p className="text-sm text-muted-foreground">
                    {disableManagerApprovalLimit
                      ? "Manager approval limit is disabled. Managers can approve all expense amounts directly."
                      : `Expenses below ${formatINR(parseFloat(engineerApprovalLimit) || 0)} can be approved directly by managers. Expenses at or above this limit must be verified by managers and then approved by administrators.`}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="attachment-limit">Attachment Required Above Amount (₹)</Label>
                  <Input
                    id="attachment-limit"
                    type="number"
                    min="0"
                    step="0.01"
                    value={attachmentRequiredAboveAmount}
                    onChange={(e) => setAttachmentRequiredAboveAmount(e.target.value)}
                    placeholder="50"
                    className="max-w-xs"
                  />
                  <p className="text-sm text-muted-foreground">
                    Expenses above {formatINR(parseFloat(attachmentRequiredAboveAmount) || 0)} require bill attachments.
                    Expenses at or below this amount do not require attachments.
                  </p>
                </div>

                {batchExpenseEntryEnabled && (
                  <div className="space-y-2">
                    <Label htmlFor="batch-attachment-mode">Batch expense receipts</Label>
                    <Select
                      value={batchExpenseAttachmentMode}
                      onValueChange={(v) =>
                        setBatchExpenseAttachmentMode(v as BatchExpenseAttachmentMode)
                      }
                    >
                      <SelectTrigger id="batch-attachment-mode" className="max-w-md">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="per_line">
                          One receipt per line (when amount exceeds threshold)
                        </SelectItem>
                        <SelectItem value="shared">
                          One shared receipt for the whole batch
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                      Applies when employees use Submit multiple. Single-expense flow is unchanged.
                    </p>
                  </div>
                )}

                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <Label htmlFor="allow-cashier-expense">Allow cashiers to submit expenses</Label>
                    <p className="text-sm text-muted-foreground">
                      When enabled, cashiers can create and submit expense claims; admins can approve them.
                    </p>
                  </div>
                  <Switch
                    id="allow-cashier-expense"
                    checked={allowCashierExpenseSubmission}
                    onCheckedChange={setAllowCashierExpenseSubmission}
                  />
                </div>

                {hierarchyEnabled && (
                  <div className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <Label htmlFor="require-immediate-supervisor">Require immediate supervisor</Label>
                      <p className="text-sm text-muted-foreground">
                        When enabled, employees, team leaders, and executives must have an immediate supervisor
                        assigned in User Management before their account can be saved.
                      </p>
                    </div>
                    <Switch
                      id="require-immediate-supervisor"
                      checked={requireImmediateSupervisor}
                      onCheckedChange={setRequireImmediateSupervisor}
                    />
                  </div>
                )}

                {saveProgress.status !== "idle" && (
                  <AsyncOperationProgress
                    status={saveProgress.status}
                    title={saveProgress.phase}
                    showSuccess={saveProgress.status === "success"}
                    compact
                  />
                )}
                <div className="flex gap-2">
                  <Button onClick={saveSettings} disabled={saving}>
                    <Save className="h-4 w-4 mr-2" />
                    {saving ? "Saving..." : "Save Settings"}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

          <Card>
            <CardHeader>
              <CardTitle>Expense Form Builder (Base Fields)</CardTitle>
              <CardDescription>
                Tap a field to edit its label, order, visibility
                {baseFieldCustomizationEnabled ? ", and input type" : ""}. Remember to
                Save Form Builder to apply changes.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="divide-y rounded-lg border">
                {(Object.keys(baseFieldConfig) as BaseExpenseFieldKey[])
                  .sort((a, b) => baseFieldConfig[a].display_order - baseFieldConfig[b].display_order)
                  .map((key) => {
                    const cfg = baseFieldConfig[key];
                    const forceVisible = FORCE_VISIBLE_FIELDS.includes(key);
                    const isHidden = !forceVisible && !cfg.is_visible;
                    const optionCount = normalizeBaseFieldOptions(cfg.options).length;
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between gap-3 p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-sm truncate">
                              {cfg.label || cfg.field_key}
                            </span>
                            {forceVisible && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                Core
                              </Badge>
                            )}
                            {cfg.is_required && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                Required
                              </Badge>
                            )}
                            {isHidden && (
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 text-muted-foreground"
                              >
                                Hidden
                              </Badge>
                            )}
                            {baseFieldCustomizationEnabled && cfg.input_type !== "default" && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                {inputTypeLabel(cfg.input_type)}
                                {cfg.input_type === "dropdown" ? ` · ${optionCount}` : ""}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            <span className="font-mono">{cfg.field_key}</span>
                            <span className="mx-1.5">·</span>
                            <span>order {cfg.display_order}</span>
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => openFieldEditor(key)}
                        >
                          <Edit className="h-4 w-4 sm:mr-1.5" />
                          <span className="hidden sm:inline">Edit</span>
                        </Button>
                      </div>
                    );
                  })}
              </div>
              <Button onClick={saveFormBuilderSettings} disabled={savingFormBuilder} className="w-full sm:w-auto">
                <Save className="h-4 w-4 mr-2" />
                {savingFormBuilder ? "Saving..." : "Save Form Builder"}
              </Button>
            </CardContent>
          </Card>

          <Dialog
            open={editingFieldKey !== null}
            onOpenChange={(open) => {
              if (!open) closeFieldEditor();
            }}
          >
            <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
              {editingFieldKey && fieldDraft && (() => {
                const key = editingFieldKey;
                const forceVisible = FORCE_VISIBLE_FIELDS.includes(key);
                return (
                  <>
                    <DialogHeader>
                      <DialogTitle>
                        {t("formBuilder.editTitle", { defaultValue: "Edit field" })} ·{" "}
                        <span className="font-mono text-base">{fieldDraft.field_key}</span>
                      </DialogTitle>
                      <DialogDescription>
                        {t("formBuilder.editDescription", {
                          defaultValue:
                            "Configure how this built-in field appears in the expense form.",
                        })}
                      </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4 py-1">
                      <div className="space-y-1.5">
                        <Label>{t("formBuilder.fieldLabel", { defaultValue: "Label" })}</Label>
                        <Input
                          value={fieldDraft.label}
                          onChange={(e) =>
                            setFieldDraft((d) => (d ? { ...d, label: e.target.value } : d))
                          }
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label>
                          {t("formBuilder.displayOrder", { defaultValue: "Display order" })}
                        </Label>
                        <Input
                          type="number"
                          value={fieldDraft.display_order}
                          onChange={(e) =>
                            setFieldDraft((d) =>
                              d ? { ...d, display_order: Number(e.target.value || 0) } : d,
                            )
                          }
                        />
                      </div>

                      <div className="flex items-center justify-between rounded-md border p-3">
                        <div className="pr-3">
                          <p className="text-sm font-medium">
                            {t("formBuilder.visible", { defaultValue: "Visible" })}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {forceVisible
                              ? t("formBuilder.visibleCore", {
                                  defaultValue: "Core field — always visible",
                                })
                              : t("formBuilder.visibleHint", {
                                  defaultValue: "Show this field on the form",
                                })}
                          </p>
                        </div>
                        <Switch
                          checked={forceVisible ? true : fieldDraft.is_visible}
                          disabled={forceVisible}
                          onCheckedChange={(v) =>
                            setFieldDraft((d) => (d ? { ...d, is_visible: v } : d))
                          }
                        />
                      </div>

                      <div className="flex items-center justify-between rounded-md border p-3">
                        <div className="pr-3">
                          <p className="text-sm font-medium">
                            {t("formBuilder.required", { defaultValue: "Required" })}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t("formBuilder.requiredHint", {
                              defaultValue: "Users must fill this field before submitting",
                            })}
                          </p>
                        </div>
                        <Switch
                          checked={fieldDraft.is_required}
                          onCheckedChange={(v) =>
                            setFieldDraft((d) => (d ? { ...d, is_required: v } : d))
                          }
                        />
                      </div>

                      {baseFieldCustomizationEnabled && (
                        <div className="space-y-4 rounded-md border bg-muted/30 p-3">
                          <div className="space-y-1.5">
                            <Label>
                              {t("formBuilder.inputType", { defaultValue: "Input type" })}
                            </Label>
                            <Select
                              value={fieldDraft.input_type}
                              onValueChange={(v) =>
                                setFieldDraft((d) =>
                                  d ? { ...d, input_type: v as BaseFieldInputType } : d,
                                )
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="default">
                                  {t("formBuilder.inputTypeDefault", { defaultValue: "Default" })}
                                </SelectItem>
                                <SelectItem value="text">
                                  {t("formBuilder.inputTypeText", { defaultValue: "Text" })}
                                </SelectItem>
                                <SelectItem value="number">
                                  {t("formBuilder.inputTypeNumber", { defaultValue: "Number" })}
                                </SelectItem>
                                <SelectItem value="dropdown">
                                  {t("formBuilder.inputTypeDropdown", { defaultValue: "Dropdown" })}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <p className="text-[11px] text-muted-foreground">
                              {t("formBuilder.inputTypeHint", {
                                defaultValue: "Default keeps the built-in control for this field.",
                              })}
                            </p>
                          </div>

                          {fieldDraft.input_type === "dropdown" && (
                            <div className="space-y-1.5">
                              <Label>
                                {key === "amount"
                                  ? t("formBuilder.optionsLabelNumeric", {
                                      defaultValue: "Options (one per line, numbers only)",
                                    })
                                  : t("formBuilder.optionsLabel", {
                                      defaultValue: "Options (one per line)",
                                    })}
                              </Label>
                              <Textarea
                                rows={5}
                                value={(fieldDraft.options ?? []).join("\n")}
                                onChange={(e) =>
                                  setFieldDraft((d) =>
                                    d ? { ...d, options: e.target.value.split("\n") } : d,
                                  )
                                }
                                placeholder={key === "amount" ? "100\n250\n500" : "Option A\nOption B"}
                              />
                              <div className="flex items-center justify-between">
                                <p className="text-[11px] text-muted-foreground">
                                  {normalizeBaseFieldOptions(fieldDraft.options).length}{" "}
                                  {t("formBuilder.optionCount", { defaultValue: "option(s)" })}
                                </p>
                              </div>
                              {(key === "category" || key === "expense_date") && (
                                <p className="text-[11px] text-amber-600">
                                  {key === "category"
                                    ? t("formBuilder.categoryOptionsHint", {
                                        defaultValue:
                                          "Options must match existing category names to load their custom fields.",
                                      })
                                    : t("formBuilder.dateOptionsHint", {
                                        defaultValue: "Options must be valid dates (YYYY-MM-DD).",
                                      })}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <DialogFooter>
                      <Button variant="outline" onClick={closeFieldEditor}>
                        {t("common.cancel", { defaultValue: "Cancel" })}
                      </Button>
                      <Button onClick={applyFieldDraft}>
                        {t("formBuilder.apply", { defaultValue: "Apply" })}
                      </Button>
                    </DialogFooter>
                  </>
                );
              })()}
            </DialogContent>
          </Dialog>

          {/* Expense Detail View Order */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <LayoutList className="h-5 w-5" />
                <CardTitle>Expense Detail View — Field Order</CardTitle>
              </div>
              <CardDescription>
                Drag or use the arrows to reorder the <strong>Additional Information</strong> fields
                that appear when viewing an expense. Changes apply to all categories.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {loadingDetailView ? (
                <p className="text-sm text-muted-foreground">Loading fields…</p>
              ) : detailViewFields.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No custom fields found. Add fields via the Category form-field settings first.
                </p>
              ) : (
                <>
                  <div className="rounded-lg border divide-y">
                    {detailViewFields.map((field, index) => (
                      <div key={field.id} className="px-3 py-2">
                        <div className="flex items-center gap-3">
                          <span className="w-6 text-center text-xs font-medium text-muted-foreground select-none">
                            {index + 1}
                          </span>
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium truncate">{field.name}</span>
                            <Badge variant="secondary" className="ml-2 text-[10px] px-1.5 py-0 align-middle">
                              {field.field_type}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              disabled={index === 0}
                              onClick={() => moveDetailViewField(index, "up")}
                              title="Move up"
                            >
                              <ChevronUp className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              disabled={index === detailViewFields.length - 1}
                              onClick={() => moveDetailViewField(index, "down")}
                              title="Move down"
                            >
                              <ChevronDown className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                        {(field.field_type === "select" || field.field_type === "checkbox") &&
                          field.options && field.options.length > 0 && (
                            <div className="flex flex-wrap gap-1 pl-8 pt-1.5 pb-0.5">
                              {field.options.map((opt) => (
                                <Badge
                                  key={opt}
                                  variant="outline"
                                  className="text-[10px] px-1.5 py-0 font-normal text-muted-foreground"
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
                    className="gap-2"
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
            <AdditionalInfoLayoutSection organizationId={organizationId} />
          )}

          {/* Organization Logo */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <ImageIcon className="h-5 w-5" />
                <CardTitle>Organization Logo</CardTitle>
              </div>
              <CardDescription>
                Upload your organization logo to show it in the sidebar, header, and sign-in page. If none is uploaded, the default PesoWise mark is used.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Current Logo Preview */}
              <div className="flex items-center gap-4">
                <div className="flex-shrink-0">
                  <div className="h-20 w-20 border-2 border-gray-200 rounded-lg flex items-center justify-center bg-gray-50 overflow-hidden">
                    {logoPreview ? (
                      <img 
                        key="preview"
                        src={logoPreview} 
                        alt="Preview" 
                        className="h-full w-full object-contain"
                      />
                    ) : organization?.logo_url ? (
                      <img
                        key={organization.logo_url}
                        src={organization.logo_url}
                        alt={organization.name || "Logo"}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <ImageIcon className="h-8 w-8 text-gray-400" />
                    )}
                  </div>
                </div>
                <div className="flex-1">
                  <p className="text-sm text-muted-foreground">
                    {organization?.logo_url 
                      ? "Current organization logo" 
                      : "No logo uploaded. Default logo will be used."}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Recommended: Square image, PNG or JPG, max 2MB
                  </p>
                </div>
              </div>

              {/* Logo Upload */}
              <div className="space-y-2">
                <Label htmlFor="logo-upload">Upload New Logo</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="logo-upload"
                    type="file"
                    accept="image/png,image/jpeg,image/jpg,image/svg+xml,image/webp"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        // Validate file size (2MB)
                        if (file.size > 2 * 1024 * 1024) {
                          toast({
                            variant: "destructive",
                            title: "File too large",
                            description: "Logo must be less than 2MB",
                          });
                          return;
                        }
                        setLogoFile(file);
                        // Create preview
                        const reader = new FileReader();
                        reader.onloadend = () => {
                          setLogoPreview(reader.result as string);
                        };
                        reader.readAsDataURL(file);
                      }
                    }}
                    className="max-w-xs"
                    disabled={uploadingLogo}
                  />
                  {logoFile && (
                    <Button
                      variant="outline"
                      size="sm"
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

              {/* Upload/Remove Buttons */}
              <div className="flex gap-2">
                {logoFile && (
                  <Button 
                    onClick={handleLogoUpload} 
                    disabled={uploadingLogo || !logoFile}
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    {uploadingLogo ? "Uploading..." : "Upload Logo"}
                  </Button>
                )}
                {organization?.logo_url && !logoFile && (
                  <Button 
                    variant="destructive"
                    onClick={handleLogoDelete}
                    disabled={uploadingLogo}
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
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MapPin className="h-5 w-5" />
                  <CardTitle>Location Management</CardTitle>
                </div>
                <Button onClick={() => openLocationDialog()} size="sm">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Location
                </Button>
              </div>
              <CardDescription>
                Manage locations for organizing engineers and teams. Useful for income tax audits and organizational structure.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingLocations ? (
                <p className="text-muted-foreground">Loading locations...</p>
              ) : locations.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <MapPin className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No locations created yet.</p>
                  <p className="text-sm mt-2">Click "Add Location" to create your first location.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {locations.map((location) => (
                    <div
                      key={location.id}
                      className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-gray-500" />
                        <span className="font-medium">{location.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openLocationDialog(location)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openDeleteLocationDialog(location)}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Data & backup */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                <CardTitle>Data & backup</CardTitle>
              </div>
              <CardDescription>
                Download a full backup of your organization data (expenses, profiles, categories, etc.) or restore from a previous backup. Optionally include receipt files in a ZIP.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="include-receipts"
                  checked={includeReceipts}
                  onCheckedChange={(v) => setIncludeReceipts(v === true)}
                />
                <Label htmlFor="include-receipts" className="text-sm font-normal cursor-pointer">
                  Include receipt files (downloads as ZIP with data + receipts)
                </Label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={handleDownloadBackup}
                  disabled={backupLoading || !organizationId}
                >
                  <Download className="h-4 w-4 mr-2" />
                  {backupLoading ? "Preparing backup…" : includeReceipts ? "Download backup (ZIP)" : "Download data backup"}
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
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Restore from backup
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Restore confirmation dialog */}
      <AlertDialog
        open={restoreConfirmOpen}
        onOpenChange={(open) => {
          setRestoreConfirmOpen(open);
          if (!open) {
            setRestoreFile(null);
            setRestorePreview(null);
          }
        }}
      >
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Restore from backup</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This will add or update data for this organization. Existing rows with the same ID will be updated; new rows will be inserted.
                </p>
                {restorePreview && (() => {
                  const preview = getBackupPreview(restorePreview);
                  const formatDate = (d: string | null) => d ? new Date(d).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
                  return (
                    <div className="rounded-md border bg-muted/50 p-3 text-sm space-y-2">
                      <p className="font-medium text-foreground">Preview — what will be restored</p>
                      <p className="text-muted-foreground">
                        <span className="font-medium text-foreground">{preview.organizationName}</span>
                        {" · "}
                        Backup exported {preview.exportedAt ? new Date(preview.exportedAt).toLocaleString() : "—"}
                      </p>
                      <p className="text-muted-foreground">
                        Data period: <span className="text-foreground">{formatDate(preview.dataFrom)}</span>
                        {" → "}
                        <span className="text-foreground">{formatDate(preview.dataTo)}</span>
                        {!preview.dataFrom && !preview.dataTo && " (no date range in backup)"}
                      </p>
                      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground list-none">
                        {preview.counts.expenses > 0 && <li>Expenses: <span className="text-foreground font-medium">{preview.counts.expenses}</span></li>}
                        {preview.counts.profiles > 0 && <li>Profiles: <span className="text-foreground font-medium">{preview.counts.profiles}</span></li>}
                        {preview.counts.organization_memberships > 0 && <li>Memberships: <span className="text-foreground font-medium">{preview.counts.organization_memberships}</span></li>}
                        {preview.counts.expense_line_items > 0 && <li>Line items: <span className="text-foreground font-medium">{preview.counts.expense_line_items}</span></li>}
                        {preview.counts.attachments > 0 && <li>Attachments: <span className="text-foreground font-medium">{preview.counts.attachments}</span></li>}
                        {preview.counts.audit_logs > 0 && <li>Audit logs: <span className="text-foreground font-medium">{preview.counts.audit_logs}</span></li>}
                        {preview.counts.cash_transfer_history > 0 && <li>Transfers: <span className="text-foreground font-medium">{preview.counts.cash_transfer_history}</span></li>}
                        {preview.counts.expense_categories > 0 && <li>Categories: <span className="text-foreground font-medium">{preview.counts.expense_categories}</span></li>}
                        {preview.counts.locations > 0 && <li>Locations: <span className="text-foreground font-medium">{preview.counts.locations}</span></li>}
                      </ul>
                      <p className="text-muted-foreground pt-1 border-t text-xs">
                        Receipt files are not re-uploaded; only database records are restored.
                      </p>
                    </div>
                  );
                })()}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestoreConfirm} disabled={restoreLoading}>
              {restoreLoading ? "Restoring…" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Location Dialog */}
      <Dialog open={locationDialogOpen} onOpenChange={setLocationDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {locationToEdit ? "Edit Location" : "Add New Location"}
            </DialogTitle>
            <DialogDescription>
              {locationToEdit
                ? "Update the location name"
                : "Create a new location for organizing engineers and teams"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="location-name">Location Name</Label>
              <Input
                id="location-name"
                value={locationName}
                onChange={(e) => setLocationName(e.target.value)}
                placeholder="e.g., London, Mumbai, Delhi"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    saveLocation();
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setLocationDialogOpen(false);
                setLocationName("");
                setLocationToEdit(null);
              }}
            >
              Cancel
            </Button>
            <Button onClick={saveLocation} disabled={savingLocation || !locationName.trim()}>
              {savingLocation ? "Saving..." : locationToEdit ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Location Confirmation Dialog */}
      <AlertDialog open={deleteLocationDialogOpen} onOpenChange={setDeleteLocationDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Location</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{locationToDelete?.name}"? This will remove all engineer assignments to this location. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={deleteLocation}
              className="bg-red-600 hover:bg-red-700"
              disabled={deletingLocation}
            >
              {deletingLocation ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

