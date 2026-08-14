import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { formatINR } from "@/lib/format";
import { getDateLocale } from "@/lib/formatLocale";
import { Badge } from "@/components/ui/badge";
import { RoleBadgeWithLabels } from "@/components/RoleBadgeWithLabels";
import { notifyBalanceAdded } from "@/services/NotificationService";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { fetchOrgMembershipRolesMap } from "@/lib/orgUsers";
import { BalanceTransferOfferService } from "@/services/BalanceTransferOfferService";
import { TransferSentOffersPanel } from "@/components/TransferSentOffersPanel";
import { Search, Users, History, Download, RefreshCw, Pencil } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { fetchProfileNamesByUserIds } from "@/lib/supabaseInQuery";
import { useRequireOperationalCashier } from "@/hooks/useRequireOperationalCashier";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileBalancesView } from "@/components/mobile/MobileBalancesView";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { ListPagination } from "@/components/ListPagination";
import { paginateItems, clampPage } from "@/lib/listPagination";

interface ProfileRow {
  user_id: string;
  name: string;
  email: string;
  employee_id?: string | null;
  balance: number | null;
  role: string;
}

interface BankAccountRow {
  id: string;
  organization_id: string;
  bank_name: string;
  account_holder_name: string;
  account_number: string;
  ifsc_code: string;
  branch_name?: string | null;
  is_active: boolean;
}

export default function Balances() {
  const { blocked } = useRequireOperationalCashier();
  const { t, i18n } = useTranslation(["balances", "common", "transfers"]);
  const { userRole, user, organizationId, hasOrganizationFeature } = useAuth();
  const employeeIdFeatureEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.employee_id_login,
  );
  const transferAcceptanceEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.transfer_recipient_acceptance,
  );
  const { toast } = useToast();
  const moneyLocale = getDateLocale(i18n.language);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ProfileRow[]>([]);
  const employeeIdLoginEnabled = useMemo(
    () => employeeIdFeatureEnabled || rows.some((r) => !!r.employee_id?.trim()),
    [employeeIdFeatureEnabled, rows],
  );
  const [savingId, setSavingId] = useState<string | null>(null);
  const [cashierBalance, setCashierBalance] = useState<number>(0);
  const [addAmounts, setAddAmounts] = useState<{ [key: string]: number }>({});
  const [addNotes, setAddNotes] = useState<{ [key: string]: string }>({});
  const [allocationMode, setAllocationMode] = useState<"cash" | "bank_transfer">("cash");
  const [selectedBankAccountByUser, setSelectedBankAccountByUser] = useState<Record<string, string>>({});
  const [searchTerm, setSearchTerm] = useState("");
  const [bulkAddDialogOpen, setBulkAddDialogOpen] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [bulkAmount, setBulkAmount] = useState<number>(0);
  const [bulkNote, setBulkNote] = useState<string>("");
  const [bulkAllocationMode, setBulkAllocationMode] = useState<"cash" | "bank_transfer">("cash");
  const [bulkSourceBankAccountId, setBulkSourceBankAccountId] = useState<string>("");
  const [bulkAdding, setBulkAdding] = useState(false);
  const [activeTab, setActiveTab] = useState<"balances" | "history" | "offers">("balances");

  // Transfer history state
  const [transferHistoryLoading, setTransferHistoryLoading] = useState(false);
  const [transfers, setTransfers] = useState<any[]>([]);
  const [filteredTransfers, setFilteredTransfers] = useState<any[]>([]);
  const [transferSearchTerm, setTransferSearchTerm] = useState("");
  const [transferFilterType, setTransferFilterType] = useState<string>("all");
  const [transferFilterRole, setTransferFilterRole] = useState<string>("all");
  const [transferFilterMode, setTransferFilterMode] = useState<string>("all");
  const [transferFilterBank, setTransferFilterBank] = useState<string>("all");
  const [bankAccounts, setBankAccounts] = useState<BankAccountRow[]>([]);
  const [bankAccountsLoading, setBankAccountsLoading] = useState(false);
  const [manageBanksOpen, setManageBanksOpen] = useState(false);
  const [newBank, setNewBank] = useState({
    bank_name: "",
    account_holder_name: "",
    account_number: "",
    ifsc_code: "",
    branch_name: "",
  });
  const [savingBank, setSavingBank] = useState(false);

  // Edit transfer date (backdate) - admin only
  const [editTransferModalOpen, setEditTransferModalOpen] = useState(false);
  const [editTransferRow, setEditTransferRow] = useState<{
    id: string;
    transferrer_name: string;
    recipient_name: string;
    amount: number;
    transferred_at: string;
    transferred_at_original?: string | null;
    transferred_at_edited_at?: string | null;
    edited_by_name?: string | null;
    date_edited?: boolean;
  } | null>(null);
  const [editTransferNewDate, setEditTransferNewDate] = useState<string>("");
  const [editTransferSaving, setEditTransferSaving] = useState(false);

  // Edit balance (set to any value or 0) - admin only
  const [editBalanceDialogOpen, setEditBalanceDialogOpen] = useState(false);
  const [editBalanceRow, setEditBalanceRow] = useState<ProfileRow | null>(null);
  const [editBalanceNewValue, setEditBalanceNewValue] = useState<string>("");
  const [editBalanceNote, setEditBalanceNote] = useState<string>("");
  const [editBalanceSaving, setEditBalanceSaving] = useState(false);

  const {
    progress: loadProgress,
    startOperation: startLoadProgress,
    completeOperation: completeLoadProgress,
  } = useOperationProgress();
  const {
    progress: transferHistoryProgress,
    startOperation: startHistoryProgress,
    completeOperation: completeHistoryProgress,
  } = useOperationProgress();
  const {
    progress: bulkProgress,
    startOperation: startBulkProgress,
    updateOperation: updateBulkProgress,
    completeOperation: completeBulkProgress,
    warnOperation: warnBulkProgress,
    failOperation: failBulkProgress,
    resetOperation: resetBulkProgress,
  } = useOperationProgress();
  const prevLoadingRef = useRef(false);
  const prevTransferHistoryLoadingRef = useRef(false);

  const canEdit = userRole === "admin" || userRole === "cashier";
  const { isMobile } = useViewportMode();

  // Pagination state — draft inputs (addAmounts/addNotes/selectedBankAccountByUser) are
  // keyed by user_id so they survive page navigation automatically.
  const [balancesPage, setBalancesPage] = useState(() => {
    const p = Number(sessionStorage.getItem("balances.page"));
    return p > 0 ? p : 1;
  });
  const [balancesPageSize, setBalancesPageSize] = useState(() => {
    const s = Number(sessionStorage.getItem("balances.pageSize"));
    return [10, 25, 50, 100].includes(s) ? s : 25;
  });
  const [transfersPage, setTransfersPage] = useState(1);
  const [transfersPageSize, setTransfersPageSize] = useState(25);
  const [bulkPage, setBulkPage] = useState(1);
  const [bulkPageSize, setBulkPageSize] = useState(25);

  const filteredRows = useMemo(() => {
    if (!searchTerm) return rows;
    const q = searchTerm.toLowerCase();
    return rows.filter(r =>
      r.name.toLowerCase().includes(q) ||
      (employeeIdLoginEnabled
        ? (r.employee_id ?? "").toLowerCase().includes(q)
        : r.email.toLowerCase().includes(q)),
    );
  }, [rows, searchTerm, employeeIdLoginEnabled]);

  const clampedBalancesPage = useMemo(
    () => clampPage(balancesPage, filteredRows.length, balancesPageSize),
    [balancesPage, filteredRows.length, balancesPageSize],
  );

  const pagedRows = useMemo(
    () => paginateItems(filteredRows, clampedBalancesPage, balancesPageSize),
    [filteredRows, clampedBalancesPage, balancesPageSize],
  );

  const clampedTransfersPage = useMemo(
    () => clampPage(transfersPage, filteredTransfers.length, transfersPageSize),
    [transfersPage, filteredTransfers.length, transfersPageSize],
  );

  const pagedTransfers = useMemo(
    () => paginateItems(filteredTransfers, clampedTransfersPage, transfersPageSize),
    [filteredTransfers, clampedTransfersPage, transfersPageSize],
  );

  const clampedBulkPage = useMemo(
    () => clampPage(bulkPage, rows.length, bulkPageSize),
    [bulkPage, rows.length, bulkPageSize],
  );

  const pagedBulkRows = useMemo(
    () => paginateItems(rows, clampedBulkPage, bulkPageSize),
    [rows, clampedBulkPage, bulkPageSize],
  );

  useEffect(() => { setBalancesPage(1); }, [searchTerm]);
  useEffect(() => { setTransfersPage(1); }, [transferSearchTerm, transferFilterType, transferFilterRole, transferFilterMode, transferFilterBank]);
  useEffect(() => { sessionStorage.setItem("balances.page", String(balancesPage)); }, [balancesPage]);
  useEffect(() => { sessionStorage.setItem("balances.pageSize", String(balancesPageSize)); }, [balancesPageSize]);

  useEffect(() => {
    fetchProfiles();
    fetchBankAccounts();

    // Set up real-time balance subscription for cashiers
    if (userRole === "cashier" && user?.id) {
      const cleanup = setupBalanceRealtimeSubscription();
      return cleanup;
    }
  }, [userRole, user?.id]);

  useEffect(() => {
    if (activeTab === "history" && user && (userRole === "admin" || userRole === "cashier")) {
      fetchTransferHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, user?.id, userRole]);

  useEffect(() => {
    if (activeTab === "history") {
      applyTransferFilters();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfers, transferSearchTerm, transferFilterType, transferFilterRole, transferFilterMode, transferFilterBank, activeTab]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;
    if (loading && !wasLoading) {
      startLoadProgress(t("balances:progress.loadingProfiles"), { description: t("balances:progress.loadingProfilesHint") });
    } else if (!loading && wasLoading) {
      completeLoadProgress(t("balances:progress.profilesReady", { count: rows.length }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  useEffect(() => {
    const wasLoading = prevTransferHistoryLoadingRef.current;
    prevTransferHistoryLoadingRef.current = transferHistoryLoading;
    if (transferHistoryLoading && !wasLoading) {
      startHistoryProgress(t("balances:progress.loadingHistory"), { description: t("balances:progress.loadingHistoryHint") });
    } else if (!transferHistoryLoading && wasLoading) {
      completeHistoryProgress(t("balances:progress.historyReady"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferHistoryLoading]);

  const setupBalanceRealtimeSubscription = () => {
    if (!user?.id) return () => { };

    console.log('Setting up balance real-time subscription for cashier:', user.id);

    const channel = supabase
      .channel(`balances-cashier-${user.id}`)
      .on('postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `user_id=eq.${user.id}`
        },
        (payload) => {
          console.log('✅ Balances: Cashier balance updated via realtime:', payload);
          const newBalance = (payload.new as any)?.balance ?? 0;
          setCashierBalance(newBalance);
          fetchProfiles(); // Refresh all profiles to show updated balances
        }
      )
      // Also listen for balance updates on employees under this cashier's engineer
      .on('postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles'
        },
        (payload) => {
          // Refresh profiles when any balance changes (for employees under this cashier)
          console.log('✅ Balances: Profile balance updated, refreshing...');
          fetchProfiles();
        }
      )
      .subscribe((status) => {
        console.log('📡 Balances cashier subscription status:', status);
        if (status === 'SUBSCRIBED') {
          console.log('✅ Balances: Successfully subscribed to balance updates');
        }
      });

    return () => {
      console.log('Cleaning up balances cashier subscription');
      supabase.removeChannel(channel);
    };
  };

  const maskAccountNumber = (accountNumber?: string | null) => {
    if (!accountNumber) return "-";
    const trimmed = accountNumber.replace(/\s+/g, "");
    if (trimmed.length <= 4) return trimmed;
    return `${"*".repeat(Math.max(0, trimmed.length - 4))}${trimmed.slice(-4)}`;
  };

  const fetchBankAccounts = async () => {
    if (!organizationId || (userRole !== "admin" && userRole !== "cashier")) return;
    try {
      setBankAccountsLoading(true);
      const { data, error } = await supabase
        .from("organization_bank_accounts")
        .select("id, organization_id, bank_name, account_holder_name, account_number, ifsc_code, branch_name, is_active")
        .eq("organization_id", organizationId)
        .order("bank_name", { ascending: true });
      if (error) throw error;
      setBankAccounts((data || []) as BankAccountRow[]);
    } catch (error) {
      console.error("Failed to fetch bank accounts", error);
      setBankAccounts([]);
    } finally {
      setBankAccountsLoading(false);
    }
  };

  const saveBankAccount = async () => {
    if (!organizationId) return;
    if (userRole !== "admin") {
      toast({ variant: "destructive", title: "Access denied", description: "Only admins can manage source bank accounts." });
      return;
    }
    const payload = {
      bank_name: newBank.bank_name.trim(),
      account_holder_name: newBank.account_holder_name.trim(),
      account_number: newBank.account_number.trim(),
      ifsc_code: newBank.ifsc_code.trim().toUpperCase(),
      branch_name: newBank.branch_name.trim() || null,
    };
    if (!payload.bank_name || !payload.account_holder_name || !payload.account_number || !payload.ifsc_code) {
      toast({ variant: "destructive", title: "Missing details", description: "Please fill bank name, holder name, account number, and IFSC." });
      return;
    }
    try {
      setSavingBank(true);
      const { error } = await supabase
        .from("organization_bank_accounts")
        .insert({ organization_id: organizationId, ...payload });
      if (error) throw error;
      setNewBank({ bank_name: "", account_holder_name: "", account_number: "", ifsc_code: "", branch_name: "" });
      toast({ title: "Bank account saved", description: "Source bank account is now available for transfers." });
      fetchBankAccounts();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Save failed", description: error?.message || "Could not save bank account." });
    } finally {
      setSavingBank(false);
    }
  };

  const toggleBankAccountStatus = async (account: BankAccountRow) => {
    if (userRole !== "admin") return;
    try {
      const { error } = await supabase
        .from("organization_bank_accounts")
        .update({ is_active: !account.is_active })
        .eq("id", account.id);
      if (error) throw error;
      toast({
        title: account.is_active ? "Bank account deactivated" : "Bank account activated",
        description: `${account.bank_name} (${maskAccountNumber(account.account_number)}) updated.`,
      });
      fetchBankAccounts();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Update failed", description: error?.message || "Could not update bank account status." });
    }
  };

  const fetchProfiles = async () => {
    try {
      setLoading(true);

      // If cashier, get their assigned engineer first
      let cashierAssignedEngineerId: string | null = null;
      if (userRole === 'cashier' && user?.id) {
        const { data: cashierProfile } = await supabase
          .from("profiles")
          .select("cashier_assigned_engineer_id")
          .eq("user_id", user.id)
          .single();

        cashierAssignedEngineerId = cashierProfile?.cashier_assigned_engineer_id || null;
        console.log('Cashier assigned engineer:', cashierAssignedEngineerId);
      }

      // Fetch profiles first
      let profilesQuery = supabase
        .from("profiles")
        .select("user_id, name, email, employee_id, balance, reporting_engineer_id, cashier_assigned_engineer_id")
        .order("name", { ascending: true });

      if (organizationId) {
        profilesQuery = profilesQuery.eq("organization_id", organizationId);
      }

      // If cashier has assigned engineer, filter to only show employees under that engineer
      if (userRole === 'cashier' && cashierAssignedEngineerId) {
        // Cashier can only see:
        // 1. Employees assigned to their engineer
        // 2. The engineer they're assigned to
        // 3. Other cashiers and admins (for reference)
        // We'll filter this in the application layer after fetching roles
        console.log('Filtering for cashier with assigned engineer:', cashierAssignedEngineerId);
      }

      const { data: profilesData, error: profilesError } = await profilesQuery;

      if (profilesError) {
        console.error("Error fetching profiles:", profilesError);
        throw profilesError;
      }

      console.log("Fetched profiles:", profilesData?.length || 0);

      let rolesByUserId: Record<string, string[]> = {};
      if (organizationId) {
        try {
          const rolesMap = await fetchOrgMembershipRolesMap(organizationId);
          for (const [userId, role] of Object.entries(rolesMap)) {
            rolesByUserId[userId] = [role];
          }
          console.log("Fetched all roles from database:", Object.keys(rolesByUserId).length);
        } catch (rolesError) {
          console.error("Error fetching roles:", rolesError);
          console.warn("Continuing without roles due to error");
        }
      }

      // Role priority - higher number = higher priority
      const rolePriority: { [key: string]: number } = {
        'admin': 4,
        'cashier': 3,
        'engineer': 2,
        'employee': 1
      };

      // Combine data and select highest priority role
      let combinedData = (profilesData || []).map((r: any) => {
        const userRoles = rolesByUserId[r.user_id] || [];
        let highestPriorityRole = 'employee'; // Default fallback
        let highestPriority = 0;

        // Find the role with highest priority
        if (userRoles.length > 0) {
          userRoles.forEach((role: string) => {
            const priority = rolePriority[role] || 0;
            if (priority > highestPriority) {
              highestPriority = priority;
              highestPriorityRole = role;
            }
          });
        } else {
          // If no role found, log a warning but keep default
          console.warn(`No role found for user ${r.name} (${r.user_id}) in organization ${organizationId}`);
        }

        console.log(`User ${r.name} (${r.user_id}): roles=${JSON.stringify(userRoles)}, selected=${highestPriorityRole}`);

        return {
          user_id: r.user_id,
          name: r.name,
          email: r.email,
          employee_id: r.employee_id ?? null,
          balance: typeof r.balance === 'number' ? r.balance : 0,
          role: highestPriorityRole,
          reporting_engineer_id: r.reporting_engineer_id,
          cashier_assigned_engineer_id: r.cashier_assigned_engineer_id,
        };
      });

      // Filter for cashiers: show employees based on location assignment (prioritized) or direct engineer assignment
      if (userRole === 'cashier' && user?.id) {
        // Get cashier's assignment from the database directly
        const { data: cashierProfileData } = await supabase
          .from("profiles")
          .select("cashier_assigned_engineer_id, cashier_assigned_location_id")
          .eq("user_id", user.id)
          .single();

        const cashierAssignedEngineerId = cashierProfileData?.cashier_assigned_engineer_id;
        const cashierAssignedLocationId = cashierProfileData?.cashier_assigned_location_id;

        if (cashierAssignedLocationId) {
          // Location-based assignment: show all engineers and employees in this location
          console.log('Filtering data for cashier with assigned location:', cashierAssignedLocationId);

          // Get all engineer IDs in this location
          const { data: locationEngineers } = await supabase
            .from("engineer_locations")
            .select("engineer_id")
            .eq("location_id", cashierAssignedLocationId);

          const locationEngineerIds = new Set((locationEngineers || []).map((le: any) => le.engineer_id));

          combinedData = combinedData.filter((row: any) => {
            // Show ONLY:
            // 1. The cashier themselves
            // 2. All engineers in the assigned location
            // 3. All employees under those engineers
            // DO NOT show: Admins, other cashiers, engineers/employees from other locations

            // Show cashier themselves
            if (row.user_id === user.id) return true;

            // Show engineers in the assigned location
            if (row.role === 'engineer' && locationEngineerIds.has(row.user_id)) return true;

            // Show employees under engineers in the assigned location
            if (row.role === 'employee' && row.reporting_engineer_id && locationEngineerIds.has(row.reporting_engineer_id)) return true;

            // Hide everything else
            return false;
          });
          console.log('Filtered data for location-based cashier:', combinedData.length, 'rows');
        } else if (cashierAssignedEngineerId) {
          // Direct engineer assignment (fallback)
          console.log('Filtering data for cashier with assigned engineer:', cashierAssignedEngineerId);
          combinedData = combinedData.filter((row: any) => {
            // Show ONLY:
            // 1. The cashier themselves
            // 2. The engineer they're assigned to (by user_id match)
            // 3. Employees assigned to that engineer (by reporting_engineer_id match)
            // DO NOT show: Admins, other cashiers, other engineers, employees from other zones

            // Show cashier themselves
            if (row.user_id === user.id) return true;

            // Show assigned engineer (must match by user_id)
            if (row.user_id === cashierAssignedEngineerId && row.role === 'engineer') return true;

            // Show employees under assigned engineer (must have matching reporting_engineer_id)
            if (row.role === 'employee' && row.reporting_engineer_id === cashierAssignedEngineerId) return true;

            // Hide everything else: admins, other cashiers, other engineers, other employees
            return false;
          });
          console.log('Filtered data for cashier:', combinedData.length, 'rows');
        } else {
          // If cashier has no assignment, show all (backward compatibility)
          console.log('Cashier has no assignment - showing all users');
        }
      }

      console.log("Final combined data:", combinedData);
      setRows(combinedData);

      // If user is cashier, fetch their balance
      if (userRole === 'cashier' && user?.id) {
        const cashierProfile = combinedData.find(p => p.user_id === user.id);
        setCashierBalance(cashierProfile?.balance || 0);
      }
    } catch (e: any) {
      console.error("Error loading balances", e);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to load user balances",
      });
    } finally {
      setLoading(false);
    }
  };

  const addAmountToUser = async (
    userId: string,
    amountToAdd: number,
    note: string,
    options?: { paymentMode?: "cash" | "bank_transfer"; sourceBankAccountId?: string }
  ) => {
    try {
      setSavingId(userId);
      const paymentMode = options?.paymentMode || "cash";
      const sourceBankAccountId = options?.sourceBankAccountId;
      const selectedBank = sourceBankAccountId ? bankAccounts.find((b) => b.id === sourceBankAccountId) : null;

      console.log('Adding amount:', amountToAdd, 'to user:', userId, 'by:', userRole);

      // Prevent cashier from adding money to themselves
      if (userRole === 'cashier' && user?.id && userId === user.id) {
        toast({
          variant: "destructive",
          title: "Action Not Allowed",
          description: "Cashiers cannot add money to their own account. Only administrators can allocate funds to cashiers."
        });
        setSavingId(null);
        return;
      }

      const currentRow = rows.find(r => r.user_id === userId);
      if (!currentRow) throw new Error('User not found');
      if (paymentMode === "bank_transfer") {
        if (!sourceBankAccountId || !selectedBank) {
          toast({
            variant: "destructive",
            title: "Bank account required",
            description: "Please select an active source bank account for bank transfer.",
          });
          setSavingId(null);
          return;
        }
        if (!selectedBank.is_active) {
          toast({
            variant: "destructive",
            title: "Inactive bank account",
            description: "Please select an active source bank account.",
          });
          setSavingId(null);
          return;
        }
      }

      console.log('Current user balance:', currentRow.balance);

      // Prevent cashier from adding money to admin
      if (userRole === 'cashier' && currentRow.role === 'admin') {
        toast({
          variant: "destructive",
          title: "Action Not Allowed",
          description: "Cashiers cannot add balance to administrators.",
        });
        setSavingId(null);
        return;
      }

      if (transferAcceptanceEnabled && amountToAdd > 0 && user?.id !== userId) {
        if (!organizationId) {
          throw new Error("Organization not found.");
        }
        const { data: transferrerProfile } = await supabase
          .from("profiles")
          .select("name")
          .eq("user_id", user?.id)
          .maybeSingle();
        await BalanceTransferOfferService.proposeOffer({
          organizationId,
          recipientId: userId,
          amount: amountToAdd,
          paymentMode,
          sourceBankAccountId,
          note,
          transferrerName: transferrerProfile?.name || "Admin",
          recipientName: currentRow.name,
        });
        toast({
          title: t("transfers:offerSent"),
          description: t("transfers:offerSentHint", { name: currentRow.name }),
        });
        setAddAmounts((prev) => ({ ...prev, [userId]: 0 }));
        setAddNotes((prev) => ({ ...prev, [userId]: "" }));
        setSavingId(null);
        return;
      }

      let deductionPerformed = false;
      const startingCashierBalance = cashierBalance;

      // If cashier is adding funds, validate they can manage this employee
      if (userRole === 'cashier' && amountToAdd > 0 && user?.id) {
        // Check if cashier can manage this employee (must be under their assigned engineer)
        const cashierProfile = rows.find(r => r.user_id === user.id);
        const cashierAssignedEngineerId = (cashierProfile as any)?.cashier_assigned_engineer_id;

        if (cashierAssignedEngineerId) {
          // Cashier has assigned engineer - check if employee is under that engineer
          const employeeEngineerId = (currentRow as any)?.reporting_engineer_id;

          if (currentRow.role === 'employee' && employeeEngineerId !== cashierAssignedEngineerId) {
            toast({
              variant: "destructive",
              title: "Access Denied",
              description: "You can only manage employees under your assigned engineer's zone/department.",
            });
            setSavingId(null);
            return;
          }

          if (currentRow.role === 'engineer' && currentRow.user_id !== cashierAssignedEngineerId) {
            toast({
              variant: "destructive",
              title: "Access Denied",
              description: "You can only manage your assigned engineer.",
            });
            setSavingId(null);
            return;
          }
        }

        if (paymentMode === "cash") {
          // Cash mode: deduct from cashier wallet
          console.log('Cashier balance check - Current balance:', cashierBalance, 'Amount to add:', amountToAdd);
          if (cashierBalance < amountToAdd) {
            console.log('Insufficient balance - need:', amountToAdd, 'have:', cashierBalance);
            toast({
              variant: "destructive",
              title: "Insufficient Balance",
              description: `You need ${formatINR(amountToAdd)} but only have ${formatINR(cashierBalance)}`
            });
            return;
          }

          console.log('Deducting from cashier balance:', cashierBalance, 'by:', amountToAdd);

          const { error: cashierError } = await supabase
            .from("profiles")
            .update({ balance: cashierBalance - amountToAdd })
            .eq("user_id", user.id);

          if (cashierError) {
            console.error('Cashier balance update error:', cashierError);
            throw cashierError;
          }

          setCashierBalance(cashierBalance - amountToAdd);
          deductionPerformed = true;
          console.log('Cashier balance updated in state');
        } else {
          // Bank transfer mode: only recipient gets credited; cashier wallet is unchanged.
          console.log('Bank transfer mode selected for cashier, skipping sender wallet deduction');
        }
      }

      // Add to target user's balance
      const newBalance = (currentRow.balance || 0) + amountToAdd;
      console.log('New balance for user:', newBalance);

      // Try to update the user's balance
      const { data, error } = await supabase
        .from("profiles")
        .update({ balance: newBalance })
        .eq("user_id", userId)
        .select("user_id, balance");

      if (error) {
        console.error('User balance update error:', error);
        // If user balance update fails, rollback cashier balance only if we actually deducted
        if (userRole === 'cashier' && user?.id && deductionPerformed) {
          console.log('Rolling back cashier balance...');
          await supabase
            .from("profiles")
            .update({ balance: startingCashierBalance })
            .eq("user_id", user.id);
          setCashierBalance(startingCashierBalance);
        }
        throw error;
      }
      if (!data || data.length === 0) {
        // RLS can block UPDATE without returning an error, so guard explicitly.
        if (userRole === 'cashier' && user?.id && deductionPerformed) {
          await supabase
            .from("profiles")
            .update({ balance: startingCashierBalance })
            .eq("user_id", user.id);
          setCashierBalance(startingCashierBalance);
        }
        throw new Error("Balance update was not permitted for this account.");
      }

      console.log('User balance updated successfully:', data);

      // Record money assignment if cashier is adding money to an employee/engineer
      // This tracks the path: cashier -> employee, so money can be returned to the same cashier
      // Always record assignments when cashier adds money - this ensures complete transaction history
      if (userRole === 'cashier' && user?.id && amountToAdd > 0) {
        // Check if recipient is an employee or engineer (not admin or cashier)
        const recipientRole = currentRow.role;
        if (recipientRole === 'employee' || recipientRole === 'engineer') {
          // Always record the assignment for transaction history
          console.log('Recording money assignment:', {
            cashier_id: user.id,
            recipient_id: userId,
            amount: amountToAdd,
            recipientRole
          });

          const { data: insertedData, error: assignmentError } = await supabase
            .from("money_assignments")
            .insert({
              cashier_id: user.id,
              recipient_id: userId,
              amount: amountToAdd,
            })
            .select();

          if (assignmentError) {
            console.error('Error recording money assignment:', assignmentError);
            // Don't throw error - assignment recording is not critical for the transaction
            // But log it for debugging
          } else {
            console.log('Money assignment recorded successfully:', insertedData);
            console.log('Money assignment recorded: cashier', user.id, '-> employee', userId, 'amount:', amountToAdd);
          }
        }
      }

      // Log to cash transfer history (for both admin and cashier transfers)
      if ((userRole === 'admin' || userRole === 'cashier') && user?.id && amountToAdd > 0) {
        const recipientRole = currentRow.role;
        let transferType: string | null = null;

        if (userRole === 'admin') {
          if (recipientRole === 'cashier') {
            transferType = 'admin_to_cashier';
          } else if (recipientRole === 'employee') {
            transferType = 'admin_to_employee';
          } else if (recipientRole === 'engineer') {
            transferType = 'admin_to_engineer';
          } else if (recipientRole === 'admin') {
            transferType = 'admin_to_admin';
          }
        } else {
          // cashier
          if (recipientRole === 'employee') {
            transferType = 'cashier_to_employee';
          } else if (recipientRole === 'engineer') {
            transferType = 'cashier_to_engineer';
          }
          // cashier can't transfer to admin or other cashiers - skip logging
        }

        // Only log if we have a valid transfer type
        if (transferType) {
          console.log('Logging cash transfer history:', {
            organization_id: organizationId,
            transferrer_id: user.id,
            transferrer_role: userRole,
            recipient_id: userId,
            recipient_role: recipientRole,
            amount: amountToAdd,
            transfer_type: transferType,
          });

          if (!organizationId) {
            console.error('Cannot log transfer history: organizationId is missing');
            return;
          }

          const { data: historyData, error: historyError } = await supabase
            .from("cash_transfer_history")
            .insert({
              organization_id: organizationId,
              transferrer_id: user.id,
              transferrer_role: userRole,
              recipient_id: userId,
              recipient_role: recipientRole,
              amount: amountToAdd,
              transfer_type: transferType,
              payment_mode: paymentMode,
              source_bank_account_id: paymentMode === "bank_transfer" ? sourceBankAccountId : null,
              source_bank_name_snapshot: paymentMode === "bank_transfer" ? selectedBank?.bank_name || null : null,
              source_account_holder_snapshot: paymentMode === "bank_transfer" ? selectedBank?.account_holder_name || null : null,
              source_account_number_masked_snapshot: paymentMode === "bank_transfer" ? maskAccountNumber(selectedBank?.account_number) : null,
              notes: note,
            })
            .select();

          if (historyError) {
            console.error('Error recording cash transfer history:', historyError);
            console.error('Error details:', {
              code: historyError.code,
              message: historyError.message,
              details: historyError.details,
              hint: historyError.hint,
            });
            // Don't throw error - history logging is not critical for the transaction
          } else {
            console.log('Cash transfer history recorded successfully:', historyData);
          }
        } else {
          console.log('Skipping transfer history log - invalid transfer type for cashier');
        }
      }

      // Get cashier/admin name for notification
      const { data: adderProfile } = await supabase
        .from("profiles")
        .select("name")
        .eq("user_id", user?.id)
        .single();

      // Create notification for the user who received the money (both cashier and admin can add)
      if ((userRole === 'cashier' || userRole === 'admin') && adderProfile) {
        await notifyBalanceAdded(
          userId,
          amountToAdd,
          adderProfile.name
        );
      }

      // Check if balance was negative and is now compensated
      const wasNegative = (currentRow.balance || 0) < 0;
      const isNowPositive = newBalance >= 0;
      const compensationMessage = wasNegative && isNowPositive
        ? ` Added ${formatINR(amountToAdd)}. Negative balance compensated. New balance: ${formatINR(newBalance)}`
        : wasNegative
          ? ` Added ${formatINR(amountToAdd)}. Balance: ${formatINR(newBalance)} (still negative)`
          : ` Added ${formatINR(amountToAdd)}. New balance: ${formatINR(newBalance)}`;

      toast({
        title: "Amount added",
        description: `${currentRow.name}'s account:${compensationMessage}${paymentMode === "bank_transfer" ? ` via ${selectedBank?.bank_name || "bank transfer"}.` : ""}`
      });

      // Update both recipient's balance and cashier's balance in the rows state
      setRows(prev => prev.map(r => {
        if (r.user_id === userId) {
          // Update recipient's balance
          return { ...r, balance: newBalance };
        } else if (userRole === 'cashier' && user?.id && deductionPerformed && r.user_id === user.id) {
          // Update cashier's balance in the table
          const newCashierBalance = startingCashierBalance - amountToAdd;
          return { ...r, balance: newCashierBalance };
        }
        return r;
      }));

      // Clear the add amount input
      setAddAmounts(prev => ({ ...prev, [userId]: 0 }));
      setAddNotes(prev => ({ ...prev, [userId]: "" }));

      // Refresh transfer history if history tab is active
      if (activeTab === "history") {
        fetchTransferHistory();
      }
    } catch (e: any) {
      console.error('Error in addAmountToUser:', e);
      toast({ variant: "destructive", title: "Error", description: e.message || "Failed to add amount" });
    } finally {
      setSavingId(null);
    }
  };

  const updateBalance = async (userId: string, newBalance: number, note?: string) => {
    try {
      setSavingId(userId);

      // Prevent cashier from adding money to themselves
      if (userRole === 'cashier' && user?.id && userId === user.id) {
        toast({
          variant: "destructive",
          title: "Action Not Allowed",
          description: "Cashiers cannot add money to their own account. Only administrators can allocate funds to cashiers."
        });
        setSavingId(null);
        return;
      }

      const currentRow = rows.find(r => r.user_id === userId);
      if (!currentRow) throw new Error('User not found');

      const currentBalance = currentRow.balance || 0;
      const balanceDifference = newBalance - currentBalance;

      // If cashier is adding funds, check if they have sufficient balance
      if (userRole === 'cashier' && balanceDifference > 0 && user?.id) {
        if (cashierBalance < balanceDifference) {
          toast({
            variant: "destructive",
            title: "Insufficient Balance",
            description: `You need ${formatINR(balanceDifference)} but only have ${formatINR(cashierBalance)}`
          });
          return;
        }

        // Deduct from cashier's balance
        const { error: cashierError } = await supabase
          .from("profiles")
          .update({ balance: cashierBalance - balanceDifference })
          .eq("user_id", user.id);

        if (cashierError) throw cashierError;

        // Update cashier balance in state
        setCashierBalance(cashierBalance - balanceDifference);
      }

      // Update target user's balance
      const { data, error } = await supabase
        .from("profiles")
        .update({ balance: newBalance })
        .eq("user_id", userId)
        .select("user_id");

      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error("Balance update was not permitted for this account.");
      }

      // Log to cash transfer history if balance increased (transfer occurred)
      if ((userRole === 'admin' || userRole === 'cashier') && user?.id && balanceDifference > 0) {
        const recipientRole = currentRow.role;
        let transferType: string | null = null;

        if (userRole === 'admin') {
          if (recipientRole === 'cashier') {
            transferType = 'admin_to_cashier';
          } else if (recipientRole === 'employee') {
            transferType = 'admin_to_employee';
          } else if (recipientRole === 'engineer') {
            transferType = 'admin_to_engineer';
          } else if (recipientRole === 'admin') {
            transferType = 'admin_to_admin';
          }
        } else {
          // cashier
          if (recipientRole === 'employee') {
            transferType = 'cashier_to_employee';
          } else if (recipientRole === 'engineer') {
            transferType = 'cashier_to_engineer';
          }
          // cashier can't transfer to admin or other cashiers, skip logging
        }

        if (transferType) {
          console.log('Logging cash transfer history (updateBalance):', {
            organization_id: organizationId,
            transferrer_id: user.id,
            transferrer_role: userRole,
            recipient_id: userId,
            recipient_role: recipientRole,
            amount: balanceDifference,
            transfer_type: transferType,
          });

          if (!organizationId) {
            console.error('Cannot log transfer history: organizationId is missing');
            return;
          }

          const { data: historyData, error: historyError } = await supabase
            .from("cash_transfer_history")
            .insert({
              organization_id: organizationId,
              transferrer_id: user.id,
              transferrer_role: userRole,
              recipient_id: userId,
              recipient_role: recipientRole,
              amount: balanceDifference,
              transfer_type: transferType,
              payment_mode: "cash",
              notes: note || undefined,
            })
            .select();

          if (historyError) {
            console.error('Error recording cash transfer history:', historyError);
            console.error('Error details:', {
              code: historyError.code,
              message: historyError.message,
              details: historyError.details,
              hint: historyError.hint,
            });
            // Don't throw error - history logging is not critical for the transaction
          } else {
            console.log('Cash transfer history recorded successfully:', historyData);
          }
        } else {
          console.log('Skipping transfer history log - invalid transfer type for cashier');
        }
      }

      toast({
        title: "Balance updated",
        description: userRole === 'cashier' && balanceDifference > 0
          ? `Added ${formatINR(balanceDifference)} to ${currentRow.name}'s account`
          : "Employee balance has been saved"
      });

      // Update both recipient's balance and cashier's balance in the rows state
      setRows(prev => prev.map(r => {
        if (r.user_id === userId) {
          // Update recipient's balance
          return { ...r, balance: newBalance };
        } else if (userRole === 'cashier' && balanceDifference > 0 && user?.id && r.user_id === user.id) {
          // Update cashier's balance in the table
          const newCashierBalance = cashierBalance - balanceDifference;
          return { ...r, balance: newCashierBalance };
        }
        return r;
      }));

      // Refresh transfer history if history tab is active
      if (activeTab === "history" && balanceDifference > 0) {
        fetchTransferHistory();
      }
    } catch (e: any) {
      toast({ variant: "destructive", title: "Error", description: e.message || "Failed to update balance" });
    } finally {
      setSavingId(null);
    }
  };

  const handleSaveEditBalance = async () => {
    if (!editBalanceRow) return;
    const parsed = parseFloat(editBalanceNewValue);
    if (Number.isNaN(parsed)) {
      toast({ variant: "destructive", title: "Error", description: "Please enter a valid number" });
      return;
    }
    const trimmedNote = editBalanceNote.trim();
    if (!trimmedNote) {
      toast({ variant: "destructive", title: "Error", description: "Please add a note for this balance edit" });
      return;
    }
    try {
      setEditBalanceSaving(true);
      await updateBalance(editBalanceRow.user_id, parsed, trimmedNote);
      setEditBalanceDialogOpen(false);
      setEditBalanceRow(null);
      setEditBalanceNewValue("");
      setEditBalanceNote("");
    } catch {
      // updateBalance already shows toast
    } finally {
      setEditBalanceSaving(false);
    }
  };

  if (!canEdit) {
    return (
      <div className="space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">{t("common:accessDenied.title")}</h1>
          <p className="text-muted-foreground">{t("common:accessDenied.balances")}</p>
        </div>
      </div>
    );
  }

  const applyTransferFilters = () => {
    let filtered = [...transfers];

    // Search filter
    if (transferSearchTerm) {
      const search = transferSearchTerm.toLowerCase();
      const userIdToEmployeeId = new Map(
        rows
          .filter((r) => r.employee_id?.trim())
          .map((r) => [r.user_id, r.employee_id!.toLowerCase()]),
      );
      filtered = filtered.filter(
        (t) =>
          t.transferrer_name?.toLowerCase().includes(search) ||
          t.recipient_name?.toLowerCase().includes(search) ||
          t.transfer_type.toLowerCase().includes(search) ||
          (t.payment_mode || "").toLowerCase().includes(search) ||
          (t.source_bank_name_snapshot || "").toLowerCase().includes(search) ||
          (t.source_account_number_masked_snapshot || "").toLowerCase().includes(search) ||
          (employeeIdLoginEnabled &&
            (userIdToEmployeeId.get(t.transferrer_id)?.includes(search) ||
              userIdToEmployeeId.get(t.recipient_id)?.includes(search))),
      );
    }

    // Type filter
    if (transferFilterType !== "all") {
      filtered = filtered.filter((t) => t.transfer_type === transferFilterType);
    }

    // Role filter
    if (transferFilterRole !== "all") {
      if (userRole === "cashier") {
        filtered = filtered.filter((t) => t.recipient_role === transferFilterRole);
      } else {
        filtered = filtered.filter(
          (t) => t.transferrer_role === transferFilterRole || t.recipient_role === transferFilterRole
        );
      }
    }

    if (transferFilterMode !== "all") {
      filtered = filtered.filter((t) => (t.payment_mode || "cash") === transferFilterMode);
    }

    if (transferFilterBank !== "all") {
      filtered = filtered.filter((t) => (t.source_bank_account_id || "") === transferFilterBank);
    }

    setFilteredTransfers(filtered);
  };

  const fetchTransferHistory = async () => {
    if (!user?.id) return;
    try {
      setTransferHistoryLoading(true);

      let query = supabase
        .from("cash_transfer_history")
        .select("*")
        .eq("organization_id", organizationId || "")
        .order("transferred_at", { ascending: false });

      if (userRole === "cashier") {
        query = query.or(`transferrer_id.eq.${user.id},recipient_id.eq.${user.id}`);
      }

      const { data, error } = await query;

      if (error) {
        if (error.code === "PGRST205" || error.message?.includes("does not exist") || error.message?.includes("relation") || error.code === "42P01") {
          console.warn("cash_transfer_history table does not exist yet");
          setTransfers([]);
          setFilteredTransfers([]);
          return;
        }
        throw error;
      }

      const typedTransfers = (data || []) as any[];

      const userIds = new Set<string>();
      typedTransfers.forEach((t) => {
        userIds.add(t.transferrer_id);
        userIds.add(t.recipient_id);
        if (t.transferred_at_edited_by) userIds.add(t.transferred_at_edited_by);
      });

      if (userIds.size > 0) {
        const nameMap = await fetchProfileNamesByUserIds(supabase, Array.from(userIds));

        const transfersWithNames = typedTransfers.map((t) => ({
          id: t.id,
          transferrer_id: t.transferrer_id,
          transferrer_name: nameMap.get(t.transferrer_id.toLowerCase()) || nameMap.get(t.transferrer_id) || "Unknown",
          transferrer_role: t.transferrer_role,
          recipient_id: t.recipient_id,
          recipient_name: nameMap.get(t.recipient_id.toLowerCase()) || nameMap.get(t.recipient_id) || "Unknown",
          recipient_role: t.recipient_role,
          amount: Number(t.amount),
          transfer_type: t.transfer_type,
          payment_mode: t.payment_mode || "cash",
          source_bank_account_id: t.source_bank_account_id ?? undefined,
          source_bank_name_snapshot: t.source_bank_name_snapshot ?? undefined,
          source_account_holder_snapshot: t.source_account_holder_snapshot ?? undefined,
          source_account_number_masked_snapshot: t.source_account_number_masked_snapshot ?? undefined,
          transferred_at: t.transferred_at,
          notes: t.notes || undefined,
          transferred_at_original: t.transferred_at_original ?? undefined,
          transferred_at_edited_at: t.transferred_at_edited_at ?? undefined,
          transferred_at_edited_by: t.transferred_at_edited_by ?? undefined,
          date_edited: !!t.date_edited,
          edited_by_name: t.transferred_at_edited_by
            ? nameMap.get(t.transferred_at_edited_by.toLowerCase()) ||
            nameMap.get(t.transferred_at_edited_by) ||
            "Unknown"
            : undefined,
        }));

        setTransfers(transfersWithNames);
      } else {
        setTransfers([]);
      }
    } catch (error: any) {
      console.error("Error fetching transfer history:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error?.message || "Failed to load transfer history.",
      });
    } finally {
      setTransferHistoryLoading(false);
    }
  };

  const getTransferTypeLabel = (type: string, transferrerRole?: string, recipientRole?: string) => {
    const labels: Record<string, string> = {
      admin_to_cashier: "Admin → Cashier",
      admin_to_employee: "Admin → Employee",
      admin_to_engineer: "Admin → Manager",
      cashier_to_employee: "Cashier → Employee",
      cashier_to_engineer: "Cashier → Manager",
      cashier_to_admin: "Cashier → Admin",
      employee_to_cashier: "Employee → Cashier",
      engineer_to_cashier: "Manager → Cashier",
      admin_to_admin: "Admin → Admin",
    };
    if (transferrerRole && recipientRole) {
      const roleKey = `${transferrerRole}_to_${recipientRole}`;
      if (labels[roleKey]) return labels[roleKey];
    }
    return labels[type] || type;
  };

  const openEditTransferDateModal = (transfer: (typeof transfers)[0]) => {
    setEditTransferRow(transfer);
    setEditTransferNewDate(format(new Date(transfer.transferred_at), "yyyy-MM-dd'T'HH:mm"));
    setEditTransferModalOpen(true);
  };

  const saveEditTransferDate = async () => {
    if (!editTransferRow || !user?.id || !editTransferNewDate) return;
    const newDate = new Date(editTransferNewDate);
    if (isNaN(newDate.getTime())) {
      toast({ variant: "destructive", title: "Invalid date", description: "Please select a valid date and time." });
      return;
    }
    if (newDate > new Date()) {
      toast({ variant: "destructive", title: "Invalid date", description: "Transfer date cannot be in the future." });
      return;
    }
    try {
      setEditTransferSaving(true);
      const originalAt = editTransferRow.transferred_at_original || editTransferRow.transferred_at;
      const originalDate = new Date(originalAt);
      const { data: adminProfile } = await supabase
        .from("profiles")
        .select("name")
        .eq("user_id", user.id)
        .single();
      const editorName = adminProfile?.name || "Admin";
      const editTime = format(new Date(), "MMM d, yyyy h:mm a");
      const auditNotes = `Date edited from ${format(originalDate, "MMM d, yyyy h:mm a")} to ${format(newDate, "MMM d, yyyy h:mm a")} by ${editorName} on ${editTime}.`;

      const updatePayload: Record<string, unknown> = {
        transferred_at: newDate.toISOString(),
        transferred_at_edited_at: new Date().toISOString(),
        transferred_at_edited_by: user.id,
        date_edited: true,
        notes: auditNotes,
      };
      if (!editTransferRow.transferred_at_original) {
        updatePayload.transferred_at_original = new Date(editTransferRow.transferred_at).toISOString();
      }

      const { error } = await supabase
        .from("cash_transfer_history")
        .update(updatePayload)
        .eq("id", editTransferRow.id);

      if (error) throw error;
      toast({ title: "Date updated", description: "Transfer date has been updated. Original date is stored for audit." });
      setEditTransferModalOpen(false);
      setEditTransferRow(null);
      setEditTransferNewDate("");
      fetchTransferHistory();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to update transfer date.";
      toast({ variant: "destructive", title: "Error", description: message });
    } finally {
      setEditTransferSaving(false);
    }
  };

  const exportTransferHistoryToCSV = () => {
    const csvRows = [
      ["Date", "Transferrer", "Transferrer Role", "Recipient", "Recipient Role", "Amount", "Type", "Payment Mode", "Source Bank", "Source Account", "Notes", "Original Date", "Edited Date", "Edited By"].join(","),
      ...filteredTransfers.map((t) => {
        const row = [
          format(new Date(t.transferred_at), "yyyy-MM-dd HH:mm:ss"),
          `"${t.transferrer_name || "Unknown"}"`,
          t.transferrer_role,
          `"${t.recipient_name || "Unknown"}"`,
          t.recipient_role,
          t.amount,
          getTransferTypeLabel(t.transfer_type, t.transferrer_role, t.recipient_role),
          t.payment_mode === "bank_transfer" ? "Bank Transfer" : "Cash",
          t.source_bank_name_snapshot ? `"${String(t.source_bank_name_snapshot).replace(/"/g, '""')}"` : "",
          t.source_account_number_masked_snapshot ? `"${String(t.source_account_number_masked_snapshot).replace(/"/g, '""')}"` : "",
          t.notes ? `"${t.notes.replace(/"/g, '""')}"` : "",
          t.date_edited && t.transferred_at_original ? format(new Date(t.transferred_at_original), "yyyy-MM-dd HH:mm:ss") : "",
          t.date_edited && t.transferred_at_edited_at ? format(new Date(t.transferred_at_edited_at), "yyyy-MM-dd HH:mm:ss") : "",
          t.date_edited && t.edited_by_name ? `"${String(t.edited_by_name).replace(/"/g, '""')}"` : "",
        ];
        return row.join(",");
      }),
    ];

    const csvContent = csvRows.join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `cash-transfer-history-${format(new Date(), "yyyy-MM-dd")}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    toast({
      title: t("balances:toast.exportSuccess"),
      description: t("balances:toast.exportSuccessHint"),
    });
  };

  if (blocked) return null;

  if (isMobile) {
    return (
      <MobileBalancesView
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        transferAcceptanceEnabled={transferAcceptanceEnabled}
        userRole={userRole ?? ""}
        cashierBalance={cashierBalance}
        rows={rows}
        loading={loading}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        addAmounts={addAmounts}
        setAddAmounts={setAddAmounts}
        addNotes={addNotes}
        setAddNotes={setAddNotes}
        allocationMode={allocationMode}
        setAllocationMode={setAllocationMode}
        bankAccounts={bankAccounts}
        selectedBankAccountByUser={selectedBankAccountByUser}
        setSelectedBankAccountByUser={setSelectedBankAccountByUser}
        savingId={savingId}
        onAddToUser={addAmountToUser}
        filteredTransfers={filteredTransfers}
        transferHistoryLoading={transferHistoryLoading}
        transferSearchTerm={transferSearchTerm}
        setTransferSearchTerm={setTransferSearchTerm}
        getTransferTypeLabel={getTransferTypeLabel}
        loadProgressStatus={loadProgress.status}
        loadProgressTitle={loadProgress.phase || undefined}
        loadProgressDescription={loadProgress.description}
        transferHistoryProgressStatus={transferHistoryProgress.status}
        transferHistoryProgressTitle={transferHistoryProgress.phase || undefined}
        employeeIdLoginEnabled={employeeIdLoginEnabled}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("balances:title")}</h1>
          <p className="text-muted-foreground">
            {userRole === 'cashier'
              ? t("balances:descriptionCashier", { balance: formatINR(cashierBalance, moneyLocale) })
              : t("balances:description")
            }
          </p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "balances" | "history" | "offers")} className="w-full">
        <TabsList className={`grid w-full max-w-lg ${transferAcceptanceEnabled ? "grid-cols-3" : "grid-cols-2"}`}>
          <TabsTrigger value="balances">{t("balances:balancesTab")}</TabsTrigger>
          {transferAcceptanceEnabled ? (
            <TabsTrigger value="offers">{t("transfers:sentOffersTab")}</TabsTrigger>
          ) : null}
          <TabsTrigger value="history" className="flex items-center gap-2">
            <History className="h-4 w-4" />
            {t("balances:history")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="balances" className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>{t("balances:cardTitle")}</CardTitle>
                  <CardDescription>
                    {t("balances:cardDescription")}
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  {userRole === "admin" && (
                    <Button
                      variant="outline"
                      onClick={() => setManageBanksOpen(true)}
                    >
                      Manage Bank Accounts
                    </Button>
                  )}
                  {userRole === 'admin' && (
                    <Button
                      onClick={() => setBulkAddDialogOpen(true)}
                      className="flex items-center gap-2"
                    >
                      <Users className="h-4 w-4" />
                      Add to Multiple Users
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* Search Bar */}
              <div className="mb-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    placeholder={employeeIdLoginEnabled ? "Search by name or employee ID..." : "Search by name or email..."}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
              <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
                <div className="inline-flex rounded-lg border p-1 bg-muted/30">
                  <Button
                    type="button"
                    size="sm"
                    variant={allocationMode === "cash" ? "default" : "ghost"}
                    onClick={() => setAllocationMode("cash")}
                    className="h-8"
                  >
                    Cash Transfer
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={allocationMode === "bank_transfer" ? "default" : "ghost"}
                    onClick={() => setAllocationMode("bank_transfer")}
                    className="h-8"
                  >
                    Bank Transfer
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {allocationMode === "cash"
                    ? "Cash page: add amount + note."
                    : "Bank page: select source bank + amount + note."}
                </p>
              </div>
              {loading ? (
                <div className="min-h-[400px] flex flex-col items-center justify-center gap-4">
                  <AsyncOperationProgress
                    status={loadProgress.status !== "idle" ? loadProgress.status : "running"}
                    title={loadProgress.phase || t("balances:progress.loadingProfiles")}
                    description={loadProgress.description}
                    showSuccess={false}
                  />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table className="table-fixed w-full">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[15%]">Name</TableHead>
                        <TableHead className="w-[20%]">{employeeIdLoginEnabled ? "Employee ID" : "Email"}</TableHead>
                        <TableHead className="w-[12%]">Role</TableHead>
                        <TableHead className="text-right w-[18%]">Current Balance</TableHead>
                        <TableHead className="text-right w-[20%]">Add Amount</TableHead>
                        <TableHead className="text-right w-[15%]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                            No users found
                          </TableCell>
                        </TableRow>
                      ) : filteredRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                            No users match your search
                          </TableCell>
                        </TableRow>
                      ) : (
                        <>
                          {pagedRows.map((r) => (
                            <TableRow key={r.user_id}>
                              <TableCell className="font-medium">{r.name}</TableCell>
                              <TableCell>
                                {employeeIdLoginEnabled
                                  ? <span className="font-mono text-sm">{r.employee_id || "—"}</span>
                                  : r.email}
                              </TableCell>
                              <TableCell>
                                <RoleBadgeWithLabels role={r.role} />
                              </TableCell>
                              <TableCell className="text-right">
                                <span className={`font-medium whitespace-nowrap ${(r.balance || 0) < 0 ? 'text-red-600' : ''}`}>
                                  {formatINR(r.balance || 0)}
                                </span>
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex items-center justify-end gap-2 flex-wrap">
                                  {allocationMode === "bank_transfer" && (
                                    <Select
                                      value={selectedBankAccountByUser[r.user_id] || undefined}
                                      onValueChange={(value) =>
                                        setSelectedBankAccountByUser((prev) => ({ ...prev, [r.user_id]: value }))
                                      }
                                      disabled={userRole === 'cashier' && user?.id === r.user_id}
                                    >
                                      <SelectTrigger className="w-56 h-9 min-w-[190px]">
                                        <SelectValue placeholder={bankAccountsLoading ? "Loading banks..." : "Source bank"} />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {bankAccounts
                                          .filter((b) => b.is_active)
                                          .map((bank) => (
                                            <SelectItem key={bank.id} value={bank.id}>
                                              {bank.bank_name} ({maskAccountNumber(bank.account_number)})
                                            </SelectItem>
                                          ))}
                                      </SelectContent>
                                    </Select>
                                  )}
                                  <Input
                                    type="number"
                                    className="w-32 h-9 min-w-[120px]"
                                    placeholder="Add amount"
                                    value={addAmounts[r.user_id] || ''}
                                    onChange={(e) => {
                                      const val = parseFloat(e.target.value || '0');
                                      setAddAmounts(prev => ({ ...prev, [r.user_id]: isNaN(val) ? 0 : val }));
                                    }}
                                    disabled={userRole === 'cashier' && user?.id === r.user_id}
                                  />
                                  <Input
                                    type="text"
                                    className="w-40 h-9 min-w-[140px]"
                                    placeholder="Note"
                                    value={addNotes[r.user_id] || ''}
                                    onChange={(e) => {
                                      setAddNotes(prev => ({ ...prev, [r.user_id]: e.target.value }));
                                    }}
                                    disabled={userRole === 'cashier' && user?.id === r.user_id}
                                  />
                                  <span className="text-xs text-muted-foreground whitespace-nowrap">INR</span>
                                </div>
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex justify-end gap-2 flex-wrap">
                                  {userRole === "admin" && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="gap-1"
                                      disabled={savingId === r.user_id}
                                      onClick={() => {
                                        setEditBalanceRow(r);
                                        setEditBalanceNewValue(String(r.balance ?? 0));
                                        setEditBalanceNote("");
                                        setEditBalanceDialogOpen(true);
                                      }}
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                      Edit
                                    </Button>
                                  )}
                                  <Button
                                    size="sm"
                                    className="w-20 min-w-[80px]"
                                    disabled={
                                      savingId === r.user_id ||
                                      (userRole === 'cashier' && user?.id === r.user_id) ||
                                      (allocationMode === "bank_transfer" && !selectedBankAccountByUser[r.user_id])
                                    }
                                    onClick={() => {
                                      console.log('Button clicked for user:', r.user_id, 'userRole:', userRole);
                                      const amountToAdd = addAmounts[r.user_id] || 0;
                                      const note = (addNotes[r.user_id] || "").trim();
                                      const paymentMode = allocationMode;
                                      const sourceBankAccountId = selectedBankAccountByUser[r.user_id];
                                      console.log('Amount to add:', amountToAdd);
                                      if (amountToAdd > 0) {
                                        if (!note) {
                                          toast({ variant: "destructive", title: "Error", description: "Please add a note for this transfer" });
                                          return;
                                        }
                                        if (paymentMode === "bank_transfer" && !sourceBankAccountId) {
                                          toast({ variant: "destructive", title: "Error", description: "Please select a source bank account." });
                                          return;
                                        }
                                        addAmountToUser(r.user_id, amountToAdd, note, { paymentMode, sourceBankAccountId });
                                      } else {
                                        toast({ variant: "destructive", title: "Error", description: "Please enter an amount to add" });
                                      }
                                    }}
                                  >
                                    {savingId === r.user_id
                                      ? transferAcceptanceEnabled
                                        ? t("balances:sendingOffer")
                                        : "Adding..."
                                      : transferAcceptanceEnabled
                                        ? t("balances:sendOffer")
                                        : allocationMode === "bank_transfer"
                                          ? "Transfer"
                                          : "Add"}
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </>
                      )}
                    </TableBody>
                  </Table>
                  <ListPagination
                    page={clampedBalancesPage}
                    pageSize={balancesPageSize}
                    totalItems={filteredRows.length}
                    onPageChange={setBalancesPage}
                    onPageSizeChange={setBalancesPageSize}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Bulk Add Dialog */}
          <Dialog open={bulkAddDialogOpen} onOpenChange={setBulkAddDialogOpen}>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Add Amount to Multiple Users</DialogTitle>
                <DialogDescription>
                  Select users and enter the amount to add to all selected accounts.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                {/* Amount Input */}
                <div className="space-y-2">
                  <Label htmlFor="bulk-amount">Amount to Add (INR)</Label>
                  <Input
                    id="bulk-amount"
                    type="number"
                    placeholder="Enter amount"
                    value={bulkAmount || ''}
                    onChange={(e) => setBulkAmount(parseFloat(e.target.value) || 0)}
                    min="0"
                    step="0.01"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bulk-note">Note</Label>
                  <Textarea
                    id="bulk-note"
                    placeholder="Add note for this bulk transfer"
                    value={bulkNote}
                    onChange={(e) => setBulkNote(e.target.value)}
                    className="min-h-[80px]"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Transfer Mode</Label>
                  <div className="inline-flex rounded-lg border p-1 bg-muted/30">
                    <Button
                      type="button"
                      size="sm"
                      variant={bulkAllocationMode === "cash" ? "default" : "ghost"}
                      onClick={() => setBulkAllocationMode("cash")}
                      className="h-8"
                    >
                      Cash Transfer
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={bulkAllocationMode === "bank_transfer" ? "default" : "ghost"}
                      onClick={() => setBulkAllocationMode("bank_transfer")}
                      className="h-8"
                    >
                      Bank Transfer
                    </Button>
                  </div>
                </div>
                {bulkAllocationMode === "bank_transfer" && (
                  <div className="space-y-2">
                    <Label htmlFor="bulk-bank-account">Source Bank Account</Label>
                    <Select
                      value={bulkSourceBankAccountId || undefined}
                      onValueChange={setBulkSourceBankAccountId}
                    >
                      <SelectTrigger id="bulk-bank-account">
                        <SelectValue placeholder={bankAccountsLoading ? "Loading banks..." : "Select source bank account"} />
                      </SelectTrigger>
                      <SelectContent>
                        {bankAccounts
                          .filter((b) => b.is_active)
                          .map((bank) => (
                            <SelectItem key={bank.id} value={bank.id}>
                              {bank.bank_name} ({maskAccountNumber(bank.account_number)})
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Select All / Deselect All */}
                <div className="flex items-center justify-between pb-2 border-b">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="select-all"
                      checked={selectedUserIds.size === rows.length && rows.length > 0}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedUserIds(new Set(rows.map(r => r.user_id)));
                        } else {
                          setSelectedUserIds(new Set());
                        }
                      }}
                    />
                    <Label htmlFor="select-all" className="font-medium cursor-pointer">
                      Select All ({rows.length} users)
                    </Label>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {selectedUserIds.size} selected
                  </span>
                </div>

                {/* User List with Checkboxes */}
                <div className="space-y-2">
                  {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No users available
                    </p>
                  ) : (
                    pagedBulkRows.map((r) => (
                      <div key={r.user_id} className="flex items-center space-x-3 p-2 hover:bg-gray-50 rounded-md">
                        <Checkbox
                          id={`user-${r.user_id}`}
                          checked={selectedUserIds.has(r.user_id)}
                          onCheckedChange={(checked) => {
                            const newSet = new Set(selectedUserIds);
                            if (checked) {
                              newSet.add(r.user_id);
                            } else {
                              newSet.delete(r.user_id);
                            }
                            setSelectedUserIds(newSet);
                          }}
                        />
                        <Label
                          htmlFor={`user-${r.user_id}`}
                          className="flex-1 cursor-pointer"
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-medium">{r.name}</div>
                              <div className="text-sm text-muted-foreground">
                                {employeeIdLoginEnabled ? (r.employee_id || r.email) : r.email}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className={`text-sm font-medium ${(r.balance || 0) < 0 ? 'text-red-600' : ''}`}>
                                {formatINR(r.balance || 0)}
                              </div>
                              <Badge variant="outline" className="text-xs mt-1">
                                {r.role}
                              </Badge>
                            </div>
                          </div>
                        </Label>
                      </div>
                    ))
                  )}
                  <ListPagination
                    page={clampedBulkPage}
                    pageSize={bulkPageSize}
                    totalItems={rows.length}
                    onPageChange={setBulkPage}
                    onPageSizeChange={setBulkPageSize}
                  />
                </div>
              </div>

              {bulkProgress.status !== "idle" && (
                <div className="px-0 pb-2">
                  <AsyncOperationProgress
                    status={bulkProgress.status}
                    title={bulkProgress.phase}
                    description={bulkProgress.description}
                    completed={bulkProgress.completed}
                    total={bulkProgress.total}
                    showSuccess={bulkProgress.status === "success"}
                  />
                </div>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setBulkAddDialogOpen(false);
                    setSelectedUserIds(new Set());
                    setBulkAmount(0);
                    setBulkNote("");
                    setBulkAllocationMode("cash");
                    setBulkSourceBankAccountId("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={async () => {
                    if (selectedUserIds.size === 0) {
                      toast({
                        variant: "destructive",
                        title: "Error",
                        description: "Please select at least one user",
                      });
                      return;
                    }
                    if (bulkAmount <= 0) {
                      toast({
                        variant: "destructive",
                        title: "Error",
                        description: "Please enter a valid amount greater than 0",
                      });
                      return;
                    }
                    const trimmedBulkNote = bulkNote.trim();
                    if (!trimmedBulkNote) {
                      toast({
                        variant: "destructive",
                        title: "Error",
                        description: "Please add a note for this bulk transfer",
                      });
                      return;
                    }

                    try {
                      setBulkAdding(true);
                      resetBulkProgress();
                      startBulkProgress(t("balances:progress.bulkAdding", { current: 0, total: selectedUserIds.size }));
                      const paymentMode = bulkAllocationMode;
                      const selectedBank = paymentMode === "bank_transfer"
                        ? bankAccounts.find((b) => b.id === bulkSourceBankAccountId && b.is_active)
                        : null;

                      if (paymentMode === "bank_transfer" && !selectedBank) {
                        toast({
                          variant: "destructive",
                          title: "Bank account required",
                          description: "Please select an active source bank account for bank transfer.",
                        });
                        return;
                      }

                      // Get admin name for notifications
                      const { data: adminProfile } = await supabase
                        .from("profiles")
                        .select("name")
                        .eq("user_id", user?.id)
                        .single();

                      const userIds = Array.from(selectedUserIds);
                      let successCount = 0;
                      let errorCount = 0;

                      if (transferAcceptanceEnabled) {
                        if (!organizationId) {
                          throw new Error("Organization not found.");
                        }
                        for (const userId of userIds) {
                          try {
                            const userRow = rows.find((r) => r.user_id === userId);
                            if (!userRow) continue;
                            if (user?.id === userId) {
                              await addAmountToUser(userId, bulkAmount, trimmedBulkNote, {
                                paymentMode,
                                sourceBankAccountId: selectedBank?.id,
                              });
                              successCount++;
                              updateBulkProgress(t("balances:progress.bulkAdding", { current: successCount + errorCount, total: userIds.length }), { completed: successCount + errorCount, total: userIds.length });
                              continue;
                            }
                            await BalanceTransferOfferService.proposeOffer({
                              organizationId,
                              recipientId: userId,
                              amount: bulkAmount,
                              paymentMode,
                              sourceBankAccountId: selectedBank?.id,
                              note: trimmedBulkNote,
                              transferrerName: adminProfile?.name || "Admin",
                              recipientName: userRow.name,
                            });
                            successCount++;
                            updateBulkProgress(t("balances:progress.bulkAdding", { current: successCount + errorCount, total: userIds.length }), { completed: successCount + errorCount, total: userIds.length });
                          } catch {
                            errorCount++;
                          }
                        }
                        if (errorCount > 0) {
                          warnBulkProgress(t("balances:progress.bulkComplete"), { description: t("balances:progress.bulkPartial", { succeeded: successCount, total: userIds.length }) });
                        } else {
                          completeBulkProgress(t("balances:progress.bulkComplete"));
                        }
                        toast({
                          title: t("transfers:offerSent"),
                          description:
                            errorCount === 0
                              ? t("transfers:offerSentHint", { name: `${successCount} users` })
                              : `Sent ${successCount}, failed ${errorCount}`,
                        });
                        setBulkAddDialogOpen(false);
                        setSelectedUserIds(new Set());
                        setBulkAmount(0);
                        setBulkNote("");
                        setBulkAllocationMode("cash");
                        setBulkSourceBankAccountId("");
                        setBulkAdding(false);
                        return;
                      }

                      // Add amount to each selected user
                      for (const userId of userIds) {
                        try {
                          const userRow = rows.find(r => r.user_id === userId);
                          if (!userRow) continue;

                          const currentBalance = userRow.balance || 0;
                          const newBalance = currentBalance + bulkAmount;

                          // Update balance in database
                          const { data: updateData, error: updateError } = await supabase
                            .from("profiles")
                            .update({ balance: newBalance })
                            .eq("user_id", userId)
                            .select("user_id");

                          if (updateError) throw updateError;
                          if (!updateData || updateData.length === 0) {
                            throw new Error("Balance update was not permitted for this account.");
                          }

                          // Log to cash transfer history (admin bulk transfers)
                          if (userRole === 'admin' && user?.id) {
                            const recipientRole = userRow.role;
                            let transferType: string;

                            if (recipientRole === 'cashier') {
                              transferType = 'admin_to_cashier';
                            } else if (recipientRole === 'employee') {
                              transferType = 'admin_to_employee';
                            } else if (recipientRole === 'engineer') {
                              transferType = 'admin_to_engineer';
                            } else if (recipientRole === 'admin') {
                              transferType = 'admin_to_admin';
                            }

                            console.log('Logging cash transfer history (bulk):', {
                              organization_id: organizationId,
                              transferrer_id: user.id,
                              transferrer_role: 'admin',
                              recipient_id: userId,
                              recipient_role: recipientRole,
                              amount: bulkAmount,
                              transfer_type: transferType,
                            });

                            if (!organizationId) {
                              console.error('Cannot log transfer history: organizationId is missing');
                              return;
                            }

                            const { data: historyData, error: historyError } = await supabase
                              .from("cash_transfer_history")
                              .insert({
                                organization_id: organizationId,
                                transferrer_id: user.id,
                                transferrer_role: 'admin',
                                recipient_id: userId,
                                recipient_role: recipientRole,
                                amount: bulkAmount,
                                transfer_type: transferType,
                                payment_mode: paymentMode,
                                source_bank_account_id: paymentMode === "bank_transfer" ? selectedBank?.id || null : null,
                                source_bank_name_snapshot: paymentMode === "bank_transfer" ? selectedBank?.bank_name || null : null,
                                source_account_holder_snapshot: paymentMode === "bank_transfer" ? selectedBank?.account_holder_name || null : null,
                                source_account_number_masked_snapshot: paymentMode === "bank_transfer" ? maskAccountNumber(selectedBank?.account_number) : null,
                                notes: trimmedBulkNote,
                              })
                              .select();

                            if (historyError) {
                              console.error('Error recording cash transfer history:', historyError);
                              console.error('Error details:', {
                                code: historyError.code,
                                message: historyError.message,
                                details: historyError.details,
                                hint: historyError.hint,
                              });
                              // Don't throw error - history logging is not critical
                            } else {
                              console.log('Cash transfer history recorded successfully:', historyData);
                            }
                          }

                          // Send notification
                          if (adminProfile) {
                            await notifyBalanceAdded(
                              userId,
                              bulkAmount,
                              adminProfile.name
                            );
                          }

                          successCount++;
                          updateBulkProgress(t("balances:progress.bulkAdding", { current: successCount + errorCount, total: userIds.length }), { completed: successCount + errorCount, total: userIds.length });
                        } catch (error) {
                          console.error(`Error adding amount to user ${userId}:`, error);
                          errorCount++;
                          updateBulkProgress(t("balances:progress.bulkAdding", { current: successCount + errorCount, total: userIds.length }), { completed: successCount + errorCount, total: userIds.length });
                        }
                      }

                      // Update local state
                      setRows(prev => prev.map(r => {
                        if (selectedUserIds.has(r.user_id)) {
                          return { ...r, balance: (r.balance || 0) + bulkAmount };
                        }
                        return r;
                      }));

                      // Show success/error message
                      if (errorCount === 0) {
                        completeBulkProgress(t("balances:progress.bulkComplete"));
                        toast({
                          title: "Success",
                          description: `${paymentMode === "bank_transfer" ? "Transferred" : "Added"} ${formatINR(bulkAmount)} to ${successCount} user(s)`,
                        });
                      } else {
                        warnBulkProgress(t("balances:progress.bulkComplete"), { description: t("balances:progress.bulkPartial", { succeeded: successCount, total: userIds.length }) });
                        toast({
                          variant: "destructive",
                          title: "Partial Success",
                          description: `Added amount to ${successCount} user(s), ${errorCount} failed`,
                        });
                      }

                      // Close dialog and reset
                      setBulkAddDialogOpen(false);
                      setSelectedUserIds(new Set());
                      setBulkAmount(0);
                      setBulkNote("");
                      setBulkAllocationMode("cash");
                      setBulkSourceBankAccountId("");

                      // Refresh transfer history if history tab is active
                      if (activeTab === "history") {
                        fetchTransferHistory();
                      }
                    } catch (error: any) {
                      console.error("Error in bulk add:", error);
                      failBulkProgress(t("balances:progress.bulkComplete"), error.message || "Failed to add amount to users");
                      toast({
                        variant: "destructive",
                        title: "Error",
                        description: error.message || "Failed to add amount to users",
                      });
                    } finally {
                      setBulkAdding(false);
                    }
                  }}
                  disabled={
                    bulkAdding ||
                    selectedUserIds.size === 0 ||
                    bulkAmount <= 0 ||
                    (bulkAllocationMode === "bank_transfer" && !bulkSourceBankAccountId)
                  }
                >
                  {bulkAdding
                    ? "Adding..."
                    : bulkAmount > 0 && selectedUserIds.size > 0
                      ? `Add ${formatINR(bulkAmount)} to ${selectedUserIds.size} User(s)`
                      : "Add to Selected Users"
                  }
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={manageBanksOpen} onOpenChange={setManageBanksOpen}>
            <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Manage Source Bank Accounts</DialogTitle>
                <DialogDescription>
                  These accounts are available when using Bank Transfer mode.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Bank Name</Label>
                    <Input
                      value={newBank.bank_name}
                      onChange={(e) => setNewBank((prev) => ({ ...prev, bank_name: e.target.value }))}
                      placeholder="HDFC Bank"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Account Holder Name</Label>
                    <Input
                      value={newBank.account_holder_name}
                      onChange={(e) => setNewBank((prev) => ({ ...prev, account_holder_name: e.target.value }))}
                      placeholder="Company Name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Account Number</Label>
                    <Input
                      value={newBank.account_number}
                      onChange={(e) => setNewBank((prev) => ({ ...prev, account_number: e.target.value }))}
                      placeholder="123456789012"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>IFSC Code</Label>
                    <Input
                      value={newBank.ifsc_code}
                      onChange={(e) => setNewBank((prev) => ({ ...prev, ifsc_code: e.target.value.toUpperCase() }))}
                      placeholder="HDFC0001234"
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label>Branch Name (optional)</Label>
                    <Input
                      value={newBank.branch_name}
                      onChange={(e) => setNewBank((prev) => ({ ...prev, branch_name: e.target.value }))}
                      placeholder="Ahmedabad Main Branch"
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button onClick={saveBankAccount} disabled={savingBank}>
                    {savingBank ? "Saving..." : "Save Bank Account"}
                  </Button>
                </div>
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Bank</TableHead>
                        <TableHead>Holder</TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead>IFSC</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bankAccounts.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                            {bankAccountsLoading ? "Loading bank accounts..." : "No bank accounts configured"}
                          </TableCell>
                        </TableRow>
                      ) : (
                        bankAccounts.map((bank) => (
                          <TableRow key={bank.id}>
                            <TableCell>{bank.bank_name}</TableCell>
                            <TableCell>{bank.account_holder_name}</TableCell>
                            <TableCell>{maskAccountNumber(bank.account_number)}</TableCell>
                            <TableCell>{bank.ifsc_code}</TableCell>
                            <TableCell>
                              <Badge variant={bank.is_active ? "default" : "secondary"}>
                                {bank.is_active ? "Active" : "Inactive"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => toggleBankAccountStatus(bank)}
                              >
                                {bank.is_active ? "Deactivate" : "Activate"}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* Edit balance dialog - admin only */}
          <Dialog
            open={editBalanceDialogOpen}
            onOpenChange={(open) => {
              if (!open) {
                setEditBalanceDialogOpen(false);
                setEditBalanceRow(null);
                setEditBalanceNewValue("");
                setEditBalanceNote("");
              }
            }}
          >
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Edit balance</DialogTitle>
                <DialogDescription>
                  Set this user's balance to a specific value. Use 0 to clear (remove) their balance.
                </DialogDescription>
              </DialogHeader>
              {editBalanceRow && (
                <div className="space-y-4 py-2">
                  <div className="rounded-lg border p-3 text-sm">
                    <p className="font-medium">{editBalanceRow.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {employeeIdLoginEnabled ? (editBalanceRow.employee_id || editBalanceRow.email) : editBalanceRow.email}
                    </p>
                    <p className="mt-2">
                      <span className="text-muted-foreground">Current balance: </span>
                      <span className={`font-medium ${(editBalanceRow.balance ?? 0) < 0 ? "text-red-600" : ""}`}>
                        {formatINR(editBalanceRow.balance ?? 0)}
                      </span>
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-balance-value">New balance (INR)</Label>
                    <div className="flex gap-2">
                      <Input
                        id="edit-balance-value"
                        type="number"
                        step="0.01"
                        value={editBalanceNewValue}
                        onChange={(e) => setEditBalanceNewValue(e.target.value)}
                        placeholder="0"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setEditBalanceNewValue("0")}
                      >
                        Set to 0
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-balance-note">Note</Label>
                    <Textarea
                      id="edit-balance-note"
                      value={editBalanceNote}
                      onChange={(e) => setEditBalanceNote(e.target.value)}
                      placeholder="Add reason/note for this balance edit"
                      className="min-h-[90px]"
                    />
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditBalanceDialogOpen(false);
                    setEditBalanceRow(null);
                    setEditBalanceNewValue("");
                    setEditBalanceNote("");
                  }}
                >
                  Cancel
                </Button>
                <Button onClick={handleSaveEditBalance} disabled={editBalanceSaving}>
                  {editBalanceSaving ? "Saving..." : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>


          <div className="text-sm text-muted-foreground">
            {userRole === 'cashier'
              ? `Note: ${allocationMode === "cash" ? "Cash mode deducts from your balance." : "Bank Transfer mode credits employee without deducting your wallet."} Source bank is logged for audit.`
              : userRole === 'admin'
                ? `Note: You are on ${allocationMode === "cash" ? "Cash Transfer" : "Bank Transfer"} page. Bank transfers log source account details for tracking.`
                : "Note: Balance is automatically reduced when an expense is approved by admin."
            }
          </div>
        </TabsContent>

        {transferAcceptanceEnabled ? (
          <TabsContent value="offers" className="space-y-6">
            <TransferSentOffersPanel />
          </TabsContent>
        ) : null}

        <TabsContent value="history" className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Transfer History</CardTitle>
                  <CardDescription>
                    View complete history of cash and bank transfers
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchTransferHistory}
                    disabled={transferHistoryLoading}
                    className="whitespace-nowrap"
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${transferHistoryLoading ? "animate-spin" : ""}`} />
                    Refresh
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportTransferHistoryToCSV}
                    disabled={transferHistoryLoading || filteredTransfers.length === 0}
                    className="whitespace-nowrap"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Export CSV
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {transferHistoryProgress.status !== "idle" && (
                <div className="mb-4">
                  <AsyncOperationProgress
                    status={transferHistoryProgress.status}
                    title={transferHistoryProgress.phase}
                    description={transferHistoryProgress.description}
                    showSuccess={transferHistoryProgress.status === "success"}
                    compact={transferHistoryProgress.status === "running"}
                  />
                </div>
              )}
              {/* Filters */}
              <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
                <div>
                  <label className="text-sm font-medium mb-2 block">Search</label>
                  <Input
                    placeholder="Search by name or type..."
                    value={transferSearchTerm}
                    onChange={(e) => setTransferSearchTerm(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">Transfer Type</label>
                  <Select value={transferFilterType} onValueChange={setTransferFilterType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Types</SelectItem>
                      <SelectItem value="admin_to_cashier">Admin → Cashier</SelectItem>
                      <SelectItem value="admin_to_employee">Admin → Employee</SelectItem>
                      <SelectItem value="admin_to_engineer">Admin → Manager</SelectItem>
                      <SelectItem value="admin_to_admin">Admin → Admin</SelectItem>
                      <SelectItem value="cashier_to_employee">Cashier → Employee</SelectItem>
                      <SelectItem value="cashier_to_engineer">Cashier → Manager</SelectItem>
                      <SelectItem value="cashier_to_admin">Cashier → Admin</SelectItem>
                      <SelectItem value="employee_to_cashier">Employee → Cashier</SelectItem>
                      <SelectItem value="engineer_to_cashier">Manager → Cashier</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">Role</label>
                  <Select value={transferFilterRole} onValueChange={setTransferFilterRole}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Roles</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="cashier">Cashier</SelectItem>
                      <SelectItem value="engineer">Manager</SelectItem>
                      <SelectItem value="employee">Employee</SelectItem>
                      <SelectItem value="team_leader">Team Leader</SelectItem>
                      <SelectItem value="executive">Executive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">Payment Mode</label>
                  <Select value={transferFilterMode} onValueChange={setTransferFilterMode}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Modes</SelectItem>
                      <SelectItem value="cash">Cash</SelectItem>
                      <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">Source Bank</label>
                  <Select value={transferFilterBank} onValueChange={setTransferFilterBank}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Banks</SelectItem>
                      {bankAccounts.map((bank) => (
                        <SelectItem key={bank.id} value={bank.id}>
                          {bank.bank_name} ({maskAccountNumber(bank.account_number)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Transfer History Table */}
              {transferHistoryLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                  <span className="ml-2 text-sm text-gray-600">Loading...</span>
                </div>
              ) : filteredTransfers.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No transfers found
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="whitespace-nowrap">Date & Time</TableHead>
                        <TableHead className="whitespace-nowrap">From</TableHead>
                        <TableHead className="whitespace-nowrap">To</TableHead>
                        <TableHead className="whitespace-nowrap">Amount</TableHead>
                        <TableHead className="whitespace-nowrap">Type</TableHead>
                        <TableHead className="whitespace-nowrap">Mode</TableHead>
                        <TableHead className="whitespace-nowrap">Source</TableHead>
                        <TableHead className="whitespace-nowrap">Notes</TableHead>
                        {userRole === "admin" && <TableHead className="whitespace-nowrap text-right">Actions</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TooltipProvider>
                        {pagedTransfers.map((transfer) => (
                          <TableRow key={transfer.id}>
                            <TableCell className="whitespace-nowrap">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span>{format(new Date(transfer.transferred_at), "MMM d, yyyy h:mm a")}</span>
                                {transfer.date_edited && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Badge variant="secondary" className="text-xs cursor-help">
                                        Edited
                                      </Badge>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-xs">
                                      <p className="font-medium">Date was backdated</p>
                                      {transfer.transferred_at_original && (
                                        <p className="text-xs mt-1">Original: {format(new Date(transfer.transferred_at_original), "MMM d, yyyy h:mm a")}</p>
                                      )}
                                      {transfer.edited_by_name && transfer.transferred_at_edited_at && (
                                        <p className="text-xs mt-0.5">By {transfer.edited_by_name} on {format(new Date(transfer.transferred_at_edited_at), "MMM d, yyyy h:mm a")}</p>
                                      )}
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div>
                                <div className="font-medium truncate max-w-[150px]">
                                  {transfer.transferrer_name || "Unknown"}
                                </div>
                                <div className="mt-1">
                                  <RoleBadgeWithLabels role={transfer.transferrer_role} />
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div>
                                <div className="font-medium truncate max-w-[150px]">
                                  {transfer.recipient_name || "Unknown"}
                                </div>
                                <div className="mt-1">
                                  <RoleBadgeWithLabels role={transfer.recipient_role} />
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="font-semibold">
                              {formatINR(transfer.amount)}
                            </TableCell>
                            <TableCell>
                              <Badge variant="secondary">
                                {getTransferTypeLabel(transfer.transfer_type, transfer.transferrer_role, transfer.recipient_role)}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <Badge variant={transfer.payment_mode === "bank_transfer" ? "default" : "secondary"}>
                                {transfer.payment_mode === "bank_transfer" ? "Bank Transfer" : "Cash"}
                              </Badge>
                            </TableCell>
                            <TableCell className="max-w-[220px]">
                              {transfer.payment_mode === "bank_transfer" ? (
                                <div className="text-xs">
                                  <div className="font-medium truncate">{transfer.source_bank_name_snapshot || "-"}</div>
                                  <div className="text-muted-foreground truncate">
                                    {transfer.source_account_number_masked_snapshot || "-"}
                                  </div>
                                </div>
                              ) : (
                                "-"
                              )}
                            </TableCell>
                            <TableCell className="max-w-[200px] truncate">
                              {transfer.notes || "-"}
                            </TableCell>
                            {userRole === "admin" && (
                              <TableCell className="text-right">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="gap-1"
                                  onClick={() => openEditTransferDateModal(transfer)}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                  Edit date
                                </Button>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TooltipProvider>
                    </TableBody>
                  </Table>
                  <ListPagination
                    page={clampedTransfersPage}
                    pageSize={transfersPageSize}
                    totalItems={filteredTransfers.length}
                    onPageChange={setTransfersPage}
                    onPageSizeChange={setTransfersPageSize}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Edit transfer date (backdate) modal - admin only */}
          <Dialog open={editTransferModalOpen} onOpenChange={(open) => { if (!open) { setEditTransferModalOpen(false); setEditTransferRow(null); setEditTransferNewDate(""); } }}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Edit transfer date</DialogTitle>
                <DialogDescription>
                  Change the date shown for this transfer. Original date is stored for audit. New date cannot be in the future.
                </DialogDescription>
              </DialogHeader>
              {editTransferRow && (
                <div className="space-y-4 py-2">
                  <div className="rounded-lg border p-3 text-sm">
                    <p><span className="text-muted-foreground">From:</span> {editTransferRow.transferrer_name}</p>
                    <p><span className="text-muted-foreground">To:</span> {editTransferRow.recipient_name}</p>
                    <p><span className="text-muted-foreground">Amount:</span> {formatINR(editTransferRow.amount)}</p>
                    <p><span className="text-muted-foreground">Current date:</span> {format(new Date(editTransferRow.transferred_at), "MMM d, yyyy h:mm a")}</p>
                    {editTransferRow.date_edited && editTransferRow.transferred_at_original && (
                      <p className="text-amber-600 text-xs mt-1">Original: {format(new Date(editTransferRow.transferred_at_original), "MMM d, yyyy h:mm a")}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-transfer-date">New date & time</Label>
                    <Input
                      id="edit-transfer-date"
                      type="datetime-local"
                      value={editTransferNewDate}
                      onChange={(e) => setEditTransferNewDate(e.target.value)}
                      max={format(new Date(), "yyyy-MM-dd'T'HH:mm")}
                    />
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => { setEditTransferModalOpen(false); setEditTransferRow(null); setEditTransferNewDate(""); }}>
                  Cancel
                </Button>
                <Button onClick={saveEditTransferDate} disabled={editTransferSaving || !editTransferNewDate}>
                  {editTransferSaving ? "Saving..." : "Save date"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>
      </Tabs>
    </div>
  );
}


