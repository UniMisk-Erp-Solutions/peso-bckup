import { format } from "date-fns";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatINR } from "@/lib/format";

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
  source_bank_name_snapshot?: string | null;
  source_account_number_masked_snapshot?: string | null;
  transferred_at: string;
  notes?: string;
}

interface Props {
  filteredTransfers: CashTransfer[];
  loading: boolean;
  searchTerm: string;
  setSearchTerm: (v: string) => void;
  isAccountantCashier: boolean;
  getTransferTypeLabel: (type: string) => string;
}

export function MobileCashTransferHistoryView({
  filteredTransfers,
  loading,
  searchTerm,
  setSearchTerm,
  isAccountantCashier,
  getTransferTypeLabel,
}: Props) {
  return (
    <div className="px-4 py-4 space-y-3">
      {isAccountantCashier && (
        <Badge
          variant="outline"
          className="border-slate-300 bg-slate-50 text-slate-700 text-xs self-start"
        >
          Read-Only
        </Badge>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search transfers..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-9 h-9 text-sm"
          data-testid="transfer-history-search"
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-10">
          <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      ) : filteredTransfers.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2"
          data-testid="transfer-history-empty"
        >
          <Search className="h-10 w-10 opacity-30" />
          <p className="text-sm">No transfers found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredTransfers.map((tr) => (
            <div
              key={tr.id}
              className="rounded-xl border bg-card p-4 shadow-sm mobile-cash-transfer-card"
              data-testid="transfer-history-card"
            >
              <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                <span className="text-lg font-bold">{formatINR(tr.amount)}</span>
                <Badge variant="secondary" className="text-xs">
                  {getTransferTypeLabel(tr.transfer_type)}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p>
                  <span className="font-medium text-foreground">From:</span>{" "}
                  {tr.transferrer_name || "—"} ({tr.transferrer_role})
                </p>
                <p>
                  <span className="font-medium text-foreground">To:</span>{" "}
                  {tr.recipient_name || "—"} ({tr.recipient_role})
                </p>
                <p>
                  <span className="font-medium text-foreground">Date:</span>{" "}
                  {format(new Date(tr.transferred_at), "MMM d, yyyy h:mm a")}
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
    </div>
  );
}
