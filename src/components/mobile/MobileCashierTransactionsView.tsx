import { format } from "date-fns";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { formatINR } from "@/lib/format";

interface MoneyAssignment {
  id: string;
  recipient_id: string;
  recipient_name?: string;
  amount: number;
  assigned_at: string;
  is_returned: boolean;
  returned_at?: string;
  return_transaction_id?: string;
}

interface MoneyReturnRequest {
  id: string;
  requester_id: string;
  requester_name?: string;
  amount: number;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  approved_at?: string;
  rejected_at?: string;
  rejection_reason?: string;
}

interface Props {
  moneyAssignments: MoneyAssignment[];
  returnRequests: MoneyReturnRequest[];
  loading: boolean;
  activeTab: "assignments" | "returns";
  setActiveTab: (v: "assignments" | "returns") => void;
}

export function MobileCashierTransactionsView({
  moneyAssignments,
  returnRequests,
  loading,
  activeTab,
  setActiveTab,
}: Props) {
  return (
    <div className="px-4 py-4">
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "assignments" | "returns")}>
        <TabsList className="w-full">
          <TabsTrigger value="assignments" className="flex-1 gap-1.5">
            <ArrowDownToLine className="h-4 w-4" />
            Assignments
          </TabsTrigger>
          <TabsTrigger value="returns" className="flex-1 gap-1.5">
            <ArrowUpFromLine className="h-4 w-4" />
            Returns
          </TabsTrigger>
        </TabsList>

        <TabsContent value="assignments" className="mt-4 space-y-3">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="h-5 w-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            </div>
          ) : moneyAssignments.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2"
              data-testid="assignments-empty"
            >
              <ArrowDownToLine className="h-8 w-8 opacity-30" />
              <p className="text-sm">No money assignments</p>
            </div>
          ) : (
            moneyAssignments.map((a) => (
              <div
                key={a.id}
                className="rounded-xl border bg-card p-4 shadow-sm mobile-cashier-assignment-card"
                data-testid="assignment-card"
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="text-sm font-semibold truncate max-w-[180px]">
                    {a.recipient_name || "—"}
                  </p>
                  <Badge variant={a.is_returned ? "secondary" : "default"}>
                    {a.is_returned ? "Returned" : "Active"}
                  </Badge>
                </div>
                <p className="text-lg font-bold">{formatINR(a.amount)}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Assigned: {format(new Date(a.assigned_at), "MMM d, yyyy")}
                </p>
                {a.returned_at && (
                  <p className="text-xs text-muted-foreground">
                    Returned: {format(new Date(a.returned_at), "MMM d, yyyy")}
                  </p>
                )}
              </div>
            ))
          )}
        </TabsContent>

        <TabsContent value="returns" className="mt-4 space-y-3">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="h-5 w-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            </div>
          ) : returnRequests.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2"
              data-testid="returns-empty"
            >
              <ArrowUpFromLine className="h-8 w-8 opacity-30" />
              <p className="text-sm">No return requests</p>
            </div>
          ) : (
            returnRequests.map((r) => (
              <div
                key={r.id}
                className="rounded-xl border bg-card p-4 shadow-sm"
                data-testid="return-card"
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="text-sm font-semibold truncate max-w-[180px]">
                    {r.requester_name || "—"}
                  </p>
                  <Badge
                    variant={
                      r.status === "approved"
                        ? "default"
                        : r.status === "rejected"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {r.status}
                  </Badge>
                </div>
                <p className="text-lg font-bold">{formatINR(r.amount)}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Requested: {format(new Date(r.requested_at), "MMM d, yyyy")}
                </p>
                {r.rejection_reason && (
                  <p className="text-xs text-destructive mt-1">Reason: {r.rejection_reason}</p>
                )}
              </div>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
