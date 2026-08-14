import { format } from "date-fns";
import { Search, History, Users, Banknote, Building2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { blurFocusedNumberInputOnWheel } from "@/lib/numberInputWheel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TransferSentOffersPanel } from "@/components/TransferSentOffersPanel";
import { formatINR } from "@/lib/format";
import { useTranslation } from "@/i18n";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import type { OperationStatus } from "@/hooks/useOperationProgress";

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

interface CashTransfer {
  id: string;
  transferrer_id?: string;
  transferrer_name?: string;
  transferrer_role?: string;
  recipient_id?: string;
  recipient_name?: string;
  recipient_role?: string;
  amount: number;
  transfer_type: string;
  payment_mode?: "cash" | "bank_transfer";
  transferred_at: string;
  notes?: string;
}

interface Props {
  activeTab: "balances" | "history" | "offers";
  setActiveTab: (v: "balances" | "history" | "offers") => void;
  transferAcceptanceEnabled: boolean;
  userRole: string;
  cashierBalance: number;
  // Balances tab
  rows: ProfileRow[];
  loading: boolean;
  searchTerm: string;
  setSearchTerm: (v: string) => void;
  addAmounts: Record<string, number>;
  setAddAmounts: (v: Record<string, number>) => void;
  addNotes: Record<string, string>;
  setAddNotes: (v: Record<string, string>) => void;
  allocationMode: "cash" | "bank_transfer";
  setAllocationMode: (v: "cash" | "bank_transfer") => void;
  bankAccounts: BankAccountRow[];
  selectedBankAccountByUser: Record<string, string>;
  setSelectedBankAccountByUser: (v: Record<string, string>) => void;
  savingId: string | null;
  onAddToUser: (
    userId: string,
    amount: number,
    note: string,
    options?: { paymentMode?: "cash" | "bank_transfer"; sourceBankAccountId?: string },
  ) => Promise<void>;
  // History tab
  filteredTransfers: CashTransfer[];
  transferHistoryLoading: boolean;
  transferSearchTerm: string;
  setTransferSearchTerm: (v: string) => void;
  getTransferTypeLabel: (type: string, transferrerRole?: string, recipientRole?: string) => string;
  loadProgressStatus?: OperationStatus;
  loadProgressTitle?: string;
  loadProgressDescription?: string;
  transferHistoryProgressStatus?: OperationStatus;
  transferHistoryProgressTitle?: string;
  employeeIdLoginEnabled?: boolean;
}

export function MobileBalancesView({
  activeTab,
  setActiveTab,
  transferAcceptanceEnabled,
  userRole,
  cashierBalance,
  rows,
  loading,
  searchTerm,
  setSearchTerm,
  addAmounts,
  setAddAmounts,
  addNotes,
  setAddNotes,
  allocationMode,
  setAllocationMode,
  bankAccounts,
  selectedBankAccountByUser,
  setSelectedBankAccountByUser,
  savingId,
  onAddToUser,
  filteredTransfers,
  transferHistoryLoading,
  transferSearchTerm,
  setTransferSearchTerm,
  getTransferTypeLabel,
  loadProgressStatus = "idle",
  loadProgressTitle,
  loadProgressDescription,
  transferHistoryProgressStatus = "idle",
  transferHistoryProgressTitle,
  employeeIdLoginEnabled = false,
}: Props) {
  const { t } = useTranslation(["balances", "transfers", "common"]);

  const activeBankAccounts = bankAccounts.filter((b) => b.is_active);

  const filteredRows = rows.filter(
    (r) =>
      searchTerm === "" ||
      r.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (employeeIdLoginEnabled
        ? (r.employee_id ?? "").toLowerCase().includes(searchTerm.toLowerCase())
        : r.email.toLowerCase().includes(searchTerm.toLowerCase())),
  );

  const tabCount = transferAcceptanceEnabled ? 3 : 2;

  return (
    <div className="flex flex-col">
      {userRole === "cashier" && (
        <div className="mx-4 mt-4 rounded-xl bg-primary/10 border border-primary/20 px-4 py-3">
          <p className="text-xs text-muted-foreground">Your Balance</p>
          <p className="text-xl font-bold text-primary">{formatINR(cashierBalance)}</p>
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "balances" | "history" | "offers")}
        className="flex-1 mt-3"
      >
        <TabsList className={`mx-4 w-[calc(100%-2rem)] grid grid-cols-${tabCount}`}>
          <TabsTrigger value="balances" className="gap-1.5 text-xs">
            <Users className="h-3.5 w-3.5" />
            {t("balances:balancesTab", { defaultValue: "Balances" })}
          </TabsTrigger>
          {transferAcceptanceEnabled && (
            <TabsTrigger value="offers" className="text-xs">
              {t("transfers:sentOffersTab", { defaultValue: "Offers" })}
            </TabsTrigger>
          )}
          <TabsTrigger value="history" className="gap-1.5 text-xs">
            <History className="h-3.5 w-3.5" />
            {t("balances:historyTab", { defaultValue: "History" })}
          </TabsTrigger>
        </TabsList>

        {/* ── Balances tab ─────────────────────────────────────── */}
        <TabsContent value="balances" className="px-4 pt-3 space-y-3">
          {/* Allocation mode toggle */}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={allocationMode === "cash" ? "default" : "outline"}
              className="flex-1 h-9 text-xs gap-1.5"
              onClick={() => setAllocationMode("cash")}
            >
              <Banknote className="h-3.5 w-3.5" />
              Cash
            </Button>
            <Button
              size="sm"
              variant={allocationMode === "bank_transfer" ? "default" : "outline"}
              className="flex-1 h-9 text-xs gap-1.5"
              onClick={() => setAllocationMode("bank_transfer")}
            >
              <Building2 className="h-3.5 w-3.5" />
              Bank Transfer
            </Button>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={employeeIdLoginEnabled ? "Search by name or employee ID..." : "Search users..."}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 h-9 text-sm"
            />
          </div>

          {loading ? (
            <div className="py-6 px-4">
              <AsyncOperationProgress
                status={loadProgressStatus !== "idle" ? loadProgressStatus : "running"}
                title={loadProgressTitle}
                description={loadProgressDescription}
                showSuccess={false}
              />
            </div>
          ) : filteredRows.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2"
              data-testid="balances-empty"
            >
              <Users className="h-8 w-8 opacity-30" />
              <p className="text-sm">No users found</p>
            </div>
          ) : (
            <div className="space-y-3 pb-4">
              {filteredRows.map((row) => {
                const amount = addAmounts[row.user_id] ?? 0;
                const note = addNotes[row.user_id] ?? "";
                const isSaving = savingId === row.user_id;
                const selectedBank = selectedBankAccountByUser[row.user_id] ?? "";

                return (
                  <div
                    key={row.user_id}
                    className="rounded-xl border bg-card p-4 shadow-sm mobile-balance-user-card"
                    data-testid="balance-user-card"
                  >
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">{row.name}</p>
                        <p className="text-xs text-muted-foreground truncate font-mono">
                          {employeeIdLoginEnabled ? (row.employee_id || row.email) : row.email}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <Badge variant="outline" className="text-xs capitalize">
                          {row.role}
                        </Badge>
                        <span
                          className={`text-sm font-bold ${
                            (row.balance ?? 0) < 0 ? "text-destructive" : "text-foreground"
                          }`}
                        >
                          {formatINR(row.balance ?? 0)}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Input
                        type="number"
                        min={0}
                        inputMode="decimal"
                        onWheelCapture={blurFocusedNumberInputOnWheel}
                        placeholder="Amount (₹)"
                        value={amount === 0 ? "" : amount}
                        onChange={(e) =>
                          setAddAmounts({
                            ...addAmounts,
                            [row.user_id]: Number(e.target.value) || 0,
                          })
                        }
                        className="h-9 text-sm"
                      />
                      <Input
                        placeholder="Note (optional)"
                        value={note}
                        onChange={(e) =>
                          setAddNotes({ ...addNotes, [row.user_id]: e.target.value })
                        }
                        className="h-9 text-sm"
                      />
                      {allocationMode === "bank_transfer" && activeBankAccounts.length > 0 && (
                        <Select
                          value={selectedBank}
                          onValueChange={(v) =>
                            setSelectedBankAccountByUser({
                              ...selectedBankAccountByUser,
                              [row.user_id]: v,
                            })
                          }
                        >
                          <SelectTrigger className="h-9 text-xs">
                            <SelectValue placeholder="Select source bank" />
                          </SelectTrigger>
                          <SelectContent>
                            {activeBankAccounts.map((b) => (
                              <SelectItem key={b.id} value={b.id}>
                                {b.bank_name} ···{b.account_number.slice(-4)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <Button
                        size="sm"
                        className="w-full h-9 text-sm"
                        disabled={amount <= 0 || isSaving}
                        onClick={() =>
                          onAddToUser(row.user_id, amount, note, {
                            paymentMode: allocationMode,
                            sourceBankAccountId:
                              allocationMode === "bank_transfer" ? selectedBank : undefined,
                          })
                        }
                      >
                        {isSaving ? "Adding…" : allocationMode === "bank_transfer" ? "Transfer" : "Add Money"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── Offers tab ────────────────────────────────────────── */}
        {transferAcceptanceEnabled && (
          <TabsContent value="offers" className="px-4 pt-3">
            <TransferSentOffersPanel />
          </TabsContent>
        )}

        {/* ── History tab ───────────────────────────────────────── */}
        <TabsContent value="history" className="px-4 pt-3 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={employeeIdLoginEnabled ? "Search by name or employee ID..." : "Search history..."}
              value={transferSearchTerm}
              onChange={(e) => setTransferSearchTerm(e.target.value)}
              className="pl-9 h-9 text-sm"
              data-testid="balances-history-search"
            />
          </div>

          {transferHistoryLoading ? (
            <div className="py-6 px-4">
              <AsyncOperationProgress
                status={transferHistoryProgressStatus !== "idle" ? transferHistoryProgressStatus : "running"}
                title={transferHistoryProgressTitle}
                showSuccess={false}
                compact
              />
            </div>
          ) : filteredTransfers.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2"
              data-testid="balances-history-empty"
            >
              <History className="h-8 w-8 opacity-30" />
              <p className="text-sm">No transfer history</p>
            </div>
          ) : (
            <div className="space-y-3 pb-4">
              {filteredTransfers.map((tr) => (
                <div
                  key={tr.id}
                  className="rounded-xl border bg-card p-4 shadow-sm"
                  data-testid="history-transfer-card"
                >
                  <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                    <span className="text-lg font-bold">{formatINR(tr.amount)}</span>
                    <Badge variant="secondary" className="text-xs">
                      {getTransferTypeLabel(tr.transfer_type)}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    {tr.transferrer_name && (
                      <p>
                        <span className="font-medium text-foreground">From:</span>{" "}
                        {tr.transferrer_name}
                        {tr.transferrer_role ? ` (${tr.transferrer_role})` : ""}
                      </p>
                    )}
                    {tr.recipient_name && (
                      <p>
                        <span className="font-medium text-foreground">To:</span>{" "}
                        {tr.recipient_name}
                        {tr.recipient_role ? ` (${tr.recipient_role})` : ""}
                      </p>
                    )}
                    <p>
                      <span className="font-medium text-foreground">Date:</span>{" "}
                      {format(new Date(tr.transferred_at), "MMM d, yyyy")}
                    </p>
                    {tr.payment_mode && (
                      <p>
                        <span className="font-medium text-foreground">Mode:</span>{" "}
                        {tr.payment_mode === "bank_transfer" ? "Bank Transfer" : "Cash"}
                      </p>
                    )}
                    {tr.notes && (
                      <p>
                        <span className="font-medium text-foreground">Notes:</span> {tr.notes}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
