import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowDown, ArrowUp, Download, RefreshCw } from "lucide-react";
import { formatINR } from "@/lib/format";
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
import { useRequireOperationalCashier } from "@/hooks/useRequireOperationalCashier";
import { Badge } from "@/components/ui/badge";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileCashierTransactionsView } from "@/components/mobile/MobileCashierTransactionsView";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";

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

export default function CashierTransactions() {
  const { blocked } = useRequireOperationalCashier();
  const { t, i18n } = useTranslation(["cashier", "common"]);
  const { user, userRole } = useAuth();
  const { toast } = useToast();
  const moneyLocale = getDateLocale(i18n.language);
  const [loading, setLoading] = useState(true);
  const [moneyAssignments, setMoneyAssignments] = useState<MoneyAssignment[]>([]);
  const [returnRequests, setReturnRequests] = useState<MoneyReturnRequest[]>([]);
  const [activeTab, setActiveTab] = useState<"assignments" | "returns">("assignments");
  const { isMobile } = useViewportMode();
  const {
    progress: loadProgress,
    startOperation: startLoadProgress,
    completeOperation: completeLoadProgress,
  } = useOperationProgress();
  const prevLoadingRef = useRef(false);

  useEffect(() => {
    if (user && userRole === "cashier") {
      fetchData();
    }
  }, [user, userRole]);

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

  const fetchData = async () => {
    if (!user?.id) return;
    try {
      setLoading(true);
      // Fetch both in parallel, but handle errors individually
      await Promise.allSettled([
        fetchMoneyAssignments().catch(err => {
          console.error("Error fetching money assignments:", err);
          // Don't show toast for missing table, just log
          if (!err.message?.includes("does not exist") && !err.message?.includes("relation") && err.code !== "42P01") {
            throw err;
          }
        }),
        fetchReturnRequests().catch(err => {
          console.error("Error fetching return requests:", err);
          // Don't show toast for missing table, just log
          if (!err.message?.includes("does not exist") && !err.message?.includes("relation") && err.code !== "42P01") {
            throw err;
          }
        })
      ]);
    } catch (error: any) {
      console.error("Error fetching transaction data:", error);
      // Only show error if it's not a missing table error
      if (!error?.message?.includes("does not exist") && !error?.message?.includes("relation") && error?.code !== "42P01") {
        toast({
          variant: "destructive",
          title: t("common:error"),
          description: error?.message || t("cashier:transactions.toast.loadFailed"),
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchMoneyAssignments = async () => {
    if (!user?.id) return;
    try {
      console.log("Fetching money assignments for cashier:", user.id);
      
      // Fetch all money assignments where this cashier is the cashier_id
      // Also try without filter first to see if RLS is blocking
      const { data: assignments, error } = await supabase
        .from("money_assignments")
        .select("*")
        .eq("cashier_id", user.id)
        .order("assigned_at", { ascending: false });
      
      // Removed the broader query check - it will fail if table doesn't exist

      if (error) {
        // If table doesn't exist (PGRST205 is PostgREST error for missing table)
        if (error.code === "PGRST205" || error.message?.includes("does not exist") || error.message?.includes("relation") || error.code === "42P01") {
          console.warn("money_assignments table does not exist yet. Please run migration: 20250118000001_track_money_assignments.sql", error);
          setMoneyAssignments([]);
          return;
        }
        console.error("Error fetching money assignments:", error);
        throw error;
      }

      console.log("Raw assignments from database:", assignments);
      console.log("Number of assignments found:", assignments?.length || 0);

      // Always set assignments, even if empty
      if (assignments && assignments.length > 0) {
        // Type assertion to ensure proper typing
        const typedAssignments = assignments as any[];
        
        // Fetch recipient names
        const recipientIds = [...new Set(typedAssignments.map(a => a.recipient_id))];
        console.log("Recipient IDs to fetch names for:", recipientIds);
        
        const { data: profiles, error: profilesError } = await supabase
          .from("profiles")
          .select("user_id, name")
          .in("user_id", recipientIds);

        if (profilesError) {
          console.error("Error fetching recipient profiles:", profilesError);
        }

        const nameMap = new Map(profiles?.map(p => [p.user_id, p.name]) || []);
        const assignmentsWithNames: MoneyAssignment[] = typedAssignments.map(a => ({
          id: a.id,
          recipient_id: a.recipient_id,
          recipient_name: nameMap.get(a.recipient_id) || "Unknown",
          amount: Number(a.amount),
          assigned_at: a.assigned_at,
          is_returned: a.is_returned || false,
          returned_at: a.returned_at || undefined,
          return_transaction_id: a.return_transaction_id || undefined,
        }));
        console.log("Assignments with names:", assignmentsWithNames);
        setMoneyAssignments(assignmentsWithNames);
      } else {
        console.log("No assignments found, setting empty array");
        setMoneyAssignments([]);
      }
    } catch (error) {
      console.error("Error fetching money assignments:", error);
      throw error;
    }
  };

  const fetchReturnRequests = async () => {
    if (!user?.id) return;
    try {
      // Fetch all return requests for this cashier (both pending and completed)
      const { data: requests, error } = await supabase
        .from("money_return_requests")
        .select("*")
        .eq("cashier_id", user.id)
        .order("requested_at", { ascending: false });

      if (error) {
        // If table doesn't exist (PGRST205 is PostgREST error for missing table)
        if (error.code === "PGRST205" || error.message?.includes("does not exist") || error.message?.includes("relation") || error.code === "42P01") {
          console.warn("money_return_requests table does not exist yet. Please run migration: 20250124000000_create_money_return_requests.sql", error);
          setReturnRequests([]);
          return;
        }
        throw error;
      }

      // Type assertion to ensure proper typing
      const typedRequests = (requests || []) as any[];

      // Fetch requester names
      const requesterIds = [...new Set(typedRequests.map(r => r.requester_id))];
      if (requesterIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("user_id, name")
          .in("user_id", requesterIds);

        const nameMap = new Map(profiles?.map(p => [p.user_id, p.name]) || []);
        const requestsWithNames: MoneyReturnRequest[] = typedRequests.map(r => ({
          id: r.id,
          requester_id: r.requester_id,
          requester_name: nameMap.get(r.requester_id) || "Unknown",
          amount: Number(r.amount),
          status: r.status as "pending" | "approved" | "rejected",
          requested_at: r.requested_at,
          approved_at: r.approved_at || undefined,
          rejected_at: r.rejected_at || undefined,
          rejection_reason: r.rejection_reason || undefined,
        }));
        setReturnRequests(requestsWithNames);
      } else {
        setReturnRequests([]);
      }
    } catch (error) {
      console.error("Error fetching return requests:", error);
      throw error;
    }
  };

  const exportToCSV = () => {
    const allTransactions: any[] = [];

    // Add money assignments
    moneyAssignments.forEach(assignment => {
      allTransactions.push({
        Type: "Money Assignment",
        Recipient: assignment.recipient_name || "Unknown",
        Amount: assignment.amount,
        Date: format(new Date(assignment.assigned_at), "yyyy-MM-dd HH:mm:ss"),
        Status: assignment.is_returned ? "Returned" : "Active",
        ReturnedDate: assignment.returned_at ? format(new Date(assignment.returned_at), "yyyy-MM-dd HH:mm:ss") : "",
      });
    });

    // Add return requests
    returnRequests.forEach(request => {
      allTransactions.push({
        Type: "Money Return",
        Requester: request.requester_name || "Unknown",
        Amount: request.amount,
        Date: format(new Date(request.requested_at), "yyyy-MM-dd HH:mm:ss"),
        Status: request.status === "approved" ? "Approved" : request.status === "rejected" ? "Rejected" : "Pending",
        ApprovedDate: request.approved_at ? format(new Date(request.approved_at), "yyyy-MM-dd HH:mm:ss") : "",
        RejectedDate: request.rejected_at ? format(new Date(request.rejected_at), "yyyy-MM-dd HH:mm:ss") : "",
      });
    });

    // Sort by date (newest first)
    allTransactions.sort((a, b) => new Date(b.Date).getTime() - new Date(a.Date).getTime());

    // Convert to CSV
    const headers = Object.keys(allTransactions[0] || {});
    const csvRows = [
      headers.join(","),
      ...allTransactions.map(row =>
        headers.map(header => {
          const value = row[header];
          return typeof value === "string" && value.includes(",")
            ? `"${value}"`
            : value;
        }).join(",")
      ),
    ];

    const csvContent = csvRows.join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `cashier-transactions-${format(new Date(), "yyyy-MM-dd")}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    toast({
      title: "Export Successful",
      description: "Transaction history has been exported to CSV.",
    });
  };

  if (blocked) return null;

  if (userRole !== "cashier") {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="p-6">
            <p className="text-center text-muted-foreground">
              {t("cashier:transactions.cashierOnly")}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isMobile) {
    return (
      <MobileCashierTransactionsView
        moneyAssignments={moneyAssignments}
        returnRequests={returnRequests}
        loading={loading}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
      />
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{t("cashier:transactions.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("cashier:transactions.description")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchData}
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
            disabled={loading || (moneyAssignments.length === 0 && returnRequests.length === 0)}
            className="whitespace-nowrap"
          >
            <Download className="h-4 w-4 mr-2" />
            {t("common:exportCsv")}
          </Button>
        </div>
      </div>

      {loadProgress.status !== "idle" && (
        <AsyncOperationProgress
          status={loadProgress.status}
          title={loadProgress.phase}
          showSuccess={loadProgress.status === "success"}
          compact={loadProgress.status === "running"}
        />
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "assignments" | "returns")} className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="assignments" className="whitespace-nowrap">
            <ArrowDown className="h-4 w-4 mr-2" />
            {t("cashier:transactions.assignmentsTab", { count: moneyAssignments.length })}
          </TabsTrigger>
          <TabsTrigger value="returns" className="whitespace-nowrap">
            <ArrowUp className="h-4 w-4 mr-2" />
            {t("cashier:transactions.returnsTab", { count: returnRequests.length })}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="assignments" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("cashier:transactions.moneyAssignments")}</CardTitle>
              <CardDescription>
                {t("cashier:transactions.moneyAssignmentsDescription")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                  <span className="ml-2 text-sm text-gray-600">{t("common:loading")}</span>
                </div>
              ) : moneyAssignments.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  {t("cashier:transactions.noAssignments")}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="whitespace-nowrap">{t("cashier:transactions.recipient")}</TableHead>
                        <TableHead className="whitespace-nowrap">{t("cashier:transactions.amount")}</TableHead>
                        <TableHead className="whitespace-nowrap">{t("cashier:transactions.assignedDate")}</TableHead>
                        <TableHead className="whitespace-nowrap">{t("cashier:transactions.status")}</TableHead>
                        <TableHead className="whitespace-nowrap">{t("cashier:transactions.returnedDate")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {moneyAssignments.map((assignment) => (
                        <TableRow key={assignment.id}>
                          <TableCell className="font-medium truncate max-w-[200px]">
                            {assignment.recipient_name || t("common:unknown")}
                          </TableCell>
                          <TableCell className="font-semibold">
                            {formatINR(assignment.amount, moneyLocale)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {format(new Date(assignment.assigned_at), "MMM d, yyyy h:mm a")}
                          </TableCell>
                          <TableCell>
                            <Badge variant={assignment.is_returned ? "secondary" : "default"}>
                              {assignment.is_returned ? t("cashier:transactions.returned") : t("cashier:transactions.active")}
                            </Badge>
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {assignment.returned_at
                              ? format(new Date(assignment.returned_at), "MMM d, yyyy h:mm a")
                              : "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="returns" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("cashier:transactions.returnRequests")}</CardTitle>
              <CardDescription>
                {t("cashier:transactions.returnRequestsDescription")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                  <span className="ml-2 text-sm text-gray-600">{t("common:loading")}</span>
                </div>
              ) : returnRequests.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  {t("cashier:transactions.noReturns")}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="whitespace-nowrap">Requester</TableHead>
                        <TableHead className="whitespace-nowrap">Amount</TableHead>
                        <TableHead className="whitespace-nowrap">Requested Date</TableHead>
                        <TableHead className="whitespace-nowrap">Status</TableHead>
                        <TableHead className="whitespace-nowrap">Processed Date</TableHead>
                        <TableHead className="whitespace-nowrap">Rejection Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {returnRequests.map((request) => (
                        <TableRow key={request.id}>
                          <TableCell className="font-medium truncate max-w-[200px]">
                            {request.requester_name || t("common:unknown")}
                          </TableCell>
                          <TableCell className="font-semibold">
                            {formatINR(request.amount, moneyLocale)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {format(new Date(request.requested_at), "MMM d, yyyy h:mm a")}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                request.status === "approved"
                                  ? "default"
                                  : request.status === "rejected"
                                  ? "destructive"
                                  : "secondary"
                              }
                            >
                              {request.status === "approved"
                                ? t("cashier:transactions.approved")
                                : request.status === "rejected"
                                ? t("cashier:transactions.rejected")
                                : t("cashier:transactions.pending")}
                            </Badge>
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {request.approved_at
                              ? format(new Date(request.approved_at), "MMM d, yyyy h:mm a")
                              : request.rejected_at
                              ? format(new Date(request.rejected_at), "MMM d, yyyy h:mm a")
                              : "-"}
                          </TableCell>
                          <TableCell className="max-w-[200px] truncate">
                            {request.rejection_reason || "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

