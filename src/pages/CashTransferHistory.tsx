import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, RefreshCw, ArrowDown, ArrowUp } from "lucide-react";
import { formatINR } from "@/lib/format";
import { fetchProfileNamesByUserIds } from "@/lib/supabaseInQuery";
import { getDateLocale } from "@/lib/formatLocale";
import { format } from "date-fns";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { RoleBadgeWithLabels } from "@/components/RoleBadgeWithLabels";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCashierCapabilities } from "@/hooks/useCashierCapabilities";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileCashTransferHistoryView } from "@/components/mobile/MobileCashTransferHistoryView";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";

interface CashTransfer {
  id: string;
  transferrer_id: string;
  transferrer_name?: string;
  transferrer_role: string;
  recipient_id: string;
  recipient_name?: string;
  recipient_role: string;
  amount: number;
  transfer_type: string;
  payment_mode?: "cash" | "bank_transfer";
  source_bank_account_id?: string | null;
  source_bank_name_snapshot?: string | null;
  source_account_number_masked_snapshot?: string | null;
  transferred_at: string;
  notes?: string;
}

interface BankAccountRow {
  id: string;
  bank_name: string;
  account_number: string;
}

export default function CashTransferHistory() {
  const { canViewTransferHistory, isAccountantCashier } = useCashierCapabilities();
  const { t, i18n } = useTranslation(["cashier", "common"]);
  const { user, userRole, organizationId } = useAuth();
  const { toast } = useToast();
  const moneyLocale = getDateLocale(i18n.language);
  const [loading, setLoading] = useState(true);
  const [transfers, setTransfers] = useState<CashTransfer[]>([]);
  const [filteredTransfers, setFilteredTransfers] = useState<CashTransfer[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterRole, setFilterRole] = useState<string>("all");
  const [filterMode, setFilterMode] = useState<string>("all");
  const [filterBank, setFilterBank] = useState<string>("all");
  const [bankAccounts, setBankAccounts] = useState<BankAccountRow[]>([]);
  const { isMobile } = useViewportMode();
  const {
    progress: loadProgress,
    startOperation: startLoadProgress,
    completeOperation: completeLoadProgress,
  } = useOperationProgress();
  const prevLoadingRef = useRef(false);

  useEffect(() => {
    if (user && canViewTransferHistory) {
      fetchTransfers();
      fetchBankAccounts();
    }
  }, [user, canViewTransferHistory, organizationId, isAccountantCashier]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;
    if (loading && !wasLoading) {
      startLoadProgress(t("common:loading"));
    } else if (!loading && wasLoading) {
      completeLoadProgress(t("common:success"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  useEffect(() => {
    applyFilters();
  }, [transfers, searchTerm, filterType, filterRole, filterMode, filterBank]);

  const maskAccountNumber = (accountNumber?: string | null) => {
    if (!accountNumber) return "-";
    const trimmed = accountNumber.replace(/\s+/g, "");
    if (trimmed.length <= 4) return trimmed;
    return `${"*".repeat(Math.max(0, trimmed.length - 4))}${trimmed.slice(-4)}`;
  };

  const fetchBankAccounts = async () => {
    if (!organizationId) return;
    try {
      const { data, error } = await supabase
        .from("organization_bank_accounts")
        .select("id, bank_name, account_number")
        .eq("organization_id", organizationId)
        .order("bank_name", { ascending: true });
      if (error) throw error;
      setBankAccounts((data || []) as BankAccountRow[]);
    } catch (error) {
      console.warn("Failed to fetch bank accounts for history", error);
      setBankAccounts([]);
    }
  };

  const applyFilters = () => {
    let filtered = [...transfers];

    // Search filter
    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (t) =>
          t.transferrer_name?.toLowerCase().includes(search) ||
          t.recipient_name?.toLowerCase().includes(search) ||
          t.transfer_type.toLowerCase().includes(search) ||
          (t.payment_mode || "").toLowerCase().includes(search) ||
          (t.source_bank_name_snapshot || "").toLowerCase().includes(search) ||
          (t.source_account_number_masked_snapshot || "").toLowerCase().includes(search) ||
          (t.notes || "").toLowerCase().includes(search)
      );
    }

    // Type filter
    if (filterType !== "all") {
      filtered = filtered.filter((t) => t.transfer_type === filterType);
    }

    // Role filter
    if (filterRole !== "all") {
      if (userRole === "cashier") {
        // Cashiers can filter by recipient role
        filtered = filtered.filter((t) => t.recipient_role === filterRole);
      } else {
        // Admins can filter by transferrer or recipient role
        filtered = filtered.filter(
          (t) => t.transferrer_role === filterRole || t.recipient_role === filterRole
        );
      }
    }

    if (filterMode !== "all") {
      filtered = filtered.filter((t) => (t.payment_mode || "cash") === filterMode);
    }

    if (filterBank !== "all") {
      filtered = filtered.filter((t) => (t.source_bank_account_id || "") === filterBank);
    }

    setFilteredTransfers(filtered);
  };

  const fetchTransfers = async () => {
    if (!user?.id) return;
    try {
      setLoading(true);
      
      let query = supabase
        .from("cash_transfer_history")
        .select("*")
        .order("transferred_at", { ascending: false });

      // Operational cashiers see only their own transfers; admins & accountant cashiers see org-wide
      if (userRole === "cashier" && !isAccountantCashier) {
        query = query.or(`transferrer_id.eq.${user.id},recipient_id.eq.${user.id}`);
      } else if (organizationId) {
        query = query.eq("organization_id", organizationId);
      }

      const { data, error } = await query;

      if (error) {
        if (error.code === "PGRST205" || error.message?.includes("does not exist") || error.message?.includes("relation") || error.code === "42P01") {
          console.warn("cash_transfer_history table does not exist yet. Please run migration: 20250129000000_create_cash_transfer_history.sql", error);
          setTransfers([]);
          setFilteredTransfers([]);
          return;
        }
        throw error;
      }

      const typedTransfers = (data || []) as any[];

      // Fetch names for transferrers and recipients
      const userIds = new Set<string>();
      typedTransfers.forEach((t) => {
        userIds.add(t.transferrer_id);
        userIds.add(t.recipient_id);
      });

      if (userIds.size > 0) {
        const nameMap = await fetchProfileNamesByUserIds(
          supabase,
          Array.from(userIds),
        );

        const transfersWithNames: CashTransfer[] = typedTransfers.map((t) => ({
          id: t.id,
          transferrer_id: t.transferrer_id,
          transferrer_name: nameMap.get(t.transferrer_id) || "Unknown",
          transferrer_role: t.transferrer_role,
          recipient_id: t.recipient_id,
          recipient_name: nameMap.get(t.recipient_id) || "Unknown",
          recipient_role: t.recipient_role,
          amount: Number(t.amount),
          transfer_type: t.transfer_type,
          payment_mode: t.payment_mode || "cash",
          source_bank_account_id: t.source_bank_account_id ?? undefined,
          source_bank_name_snapshot: t.source_bank_name_snapshot ?? undefined,
          source_account_number_masked_snapshot: t.source_account_number_masked_snapshot ?? undefined,
          transferred_at: t.transferred_at,
          notes: t.notes || undefined,
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
      setLoading(false);
    }
  };

  const getTransferTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      admin_to_cashier: "Admin → Cashier",
      admin_to_employee: "Admin → Employee",
      admin_to_engineer: "Admin → Manager",
      admin_to_admin: "Admin → Admin",
      cashier_to_employee: "Cashier → Employee",
      cashier_to_engineer: "Cashier → Manager",
      cashier_to_admin: "Cashier → Admin",
      employee_to_cashier: "Employee → Cashier",
      engineer_to_cashier: "Manager → Cashier",
    };
    return labels[type] || type;
  };

  const exportToCSV = () => {
    const csvRows = [
      ["Date", "Transferrer", "Transferrer Role", "Recipient", "Recipient Role", "Amount", "Type", "Payment Mode", "Source Bank", "Source Account", "Notes"].join(","),
      ...filteredTransfers.map((t) => {
        const row = [
          format(new Date(t.transferred_at), "yyyy-MM-dd HH:mm:ss"),
          `"${t.transferrer_name || "Unknown"}"`,
          t.transferrer_role,
          `"${t.recipient_name || "Unknown"}"`,
          t.recipient_role,
          t.amount,
          getTransferTypeLabel(t.transfer_type),
          t.payment_mode === "bank_transfer" ? "Bank Transfer" : "Cash",
          t.source_bank_name_snapshot ? `"${String(t.source_bank_name_snapshot).replace(/"/g, '""')}"` : "",
          t.source_account_number_masked_snapshot ? `"${String(t.source_account_number_masked_snapshot).replace(/"/g, '""')}"` : "",
          t.notes ? `"${t.notes.replace(/"/g, '""')}"` : "",
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
      title: "Export Successful",
      description: "Transfer history has been exported to CSV.",
    });
  };

  if (!canViewTransferHistory) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="p-6">
            <p className="text-center text-muted-foreground">
              {t("common:accessDenied.adminOrCashier")}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isMobile) {
    return (
      <MobileCashTransferHistoryView
        filteredTransfers={filteredTransfers}
        loading={loading}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        isAccountantCashier={isAccountantCashier}
        getTransferTypeLabel={getTransferTypeLabel}
      />
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              {t("cashier:transferHistory.title")}
            </h1>
            {isAccountantCashier ? (
              <Badge variant="outline" className="border-slate-300 bg-slate-50 text-slate-700">
                {t("cashier:accountantReadOnlyBadge")}
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {isAccountantCashier
              ? t("cashier:transferHistory.descriptionAccountant")
              : t("cashier:transferHistory.description")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchTransfers}
            disabled={loading}
            className="whitespace-nowrap"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            {t("common:refresh")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportToCSV}
            disabled={loading || filteredTransfers.length === 0}
            className="whitespace-nowrap"
          >
            <Download className="h-4 w-4 mr-2" />
            {t("common:exportCsv")}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <label className="text-sm font-medium mb-2 block">{t("cashier:transferHistory.search")}</label>
              <Input
                placeholder={t("cashier:transferHistory.searchPlaceholder")}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">{t("cashier:transferHistory.transferType")}</label>
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("cashier:transferHistory.allTypes")}</SelectItem>
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
              <label className="text-sm font-medium mb-2 block">{t("cashier:transferHistory.role")}</label>
              <Select value={filterRole} onValueChange={setFilterRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("cashier:transferHistory.allRoles")}</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="cashier">Cashier</SelectItem>
                  <SelectItem value="engineer">Manager</SelectItem>
                  <SelectItem value="employee">Employee</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">{t("cashier:transferHistory.paymentMode")}</label>
              <Select value={filterMode} onValueChange={setFilterMode}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("cashier:transferHistory.allModes")}</SelectItem>
                  <SelectItem value="cash">{t("cashier:transferHistory.cash")}</SelectItem>
                  <SelectItem value="bank_transfer">{t("cashier:transferHistory.bankTransfer")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">{t("cashier:transferHistory.sourceBank")}</label>
              <Select value={filterBank} onValueChange={setFilterBank}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("cashier:transferHistory.allBanks")}</SelectItem>
                  {bankAccounts.map((bank) => (
                    <SelectItem key={bank.id} value={bank.id}>
                      {bank.bank_name} ({maskAccountNumber(bank.account_number)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transfer History</CardTitle>
          <CardDescription>
            {filteredTransfers.length} transfer{filteredTransfers.length !== 1 ? "s" : ""} found
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadProgress.status !== "idle" && (
            <div className="mb-4">
              <AsyncOperationProgress
                status={loadProgress.status}
                title={loadProgress.phase}
                showSuccess={loadProgress.status === "success"}
                compact={loadProgress.status === "running"}
              />
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
            </div>
          ) : filteredTransfers.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              {t("cashier:transferHistory.noTransfers")}
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTransfers.map((transfer) => (
                    <TableRow key={transfer.id}>
                      <TableCell className="whitespace-nowrap">
                        {format(new Date(transfer.transferred_at), "MMM d, yyyy h:mm a")}
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
                        {formatINR(transfer.amount, moneyLocale)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {getTransferTypeLabel(transfer.transfer_type)}
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
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

