/**
 * History tab on the admin submit-for-employee page — every expense this
 * org's admins have created on behalf of an employee (single or bulk),
 * newest first, with a full per-expense audit trail on demand.
 *
 * Reuses the exact same UUID-safety primitive ExpenseDetail.tsx already
 * relies on (enrichAuditLogsWithDisplay + fetchProfileNamesByUserIds) —
 * this codebase has a documented past incident about a raw UUID leaking
 * into a display surface, so names are never read directly off a row.
 */
import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { History, Loader2, ChevronRight, RotateCcw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { enrichAuditLogsWithDisplay, type EnrichedAuditLog } from "@/lib/auditLogDisplay";
import { ExpenseTimeline } from "@/components/ExpenseTimeline";
import { fetchProfileNamesByUserIds } from "@/lib/supabaseInQuery";

const PAGE_SIZE = 50;
const AUDIT_ACTIONS = [
  "expense_created", "expense_submitted", "expense_resubmitted",
  "expense_verified", "expense_approved", "expense_rejected",
];

interface HistoryRow {
  id: string;
  title: string;
  total_amount: number;
  category: string;
  status: string;
  created_at: string;
  user_id: string;
  created_by_admin_id: string;
}

/** DD-MM-YYYY · h:mm a — the exact format requested, distinct from every
 *  other date format already used elsewhere in this codebase (date-fns'
 *  "MMM d, yyyy" style), so this is a small local formatter, not a shared one. */
function formatHistoryDateTime(iso: string): string {
  return format(new Date(iso), "dd-MM-yyyy · h:mm a");
}

const STATUS_BADGE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  submitted: "secondary",
  verified: "outline",
  approved: "default",
  rejected: "destructive",
};

interface AdminExpenseHistoryTabProps {
  organizationId: string | null;
}

export function AdminExpenseHistoryTab({ organizationId }: AdminExpenseHistoryTabProps) {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [nameByUserId, setNameByUserId] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [selectedExpense, setSelectedExpense] = useState<HistoryRow | null>(null);
  const [detailLogs, setDetailLogs] = useState<EnrichedAuditLog[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchPage = async (offset: number, append: boolean) => {
    if (!organizationId) return;
    append ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      // expenses.created_by_admin_id predates the generated types.ts (same
      // root cause documented in src/lib/adminSubmitExpense.ts) — narrow
      // cast, not a new pattern.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any;
      const { data, error: fetchError } = await db
        .from("expenses")
        .select("id, title, total_amount, category, status, created_at, user_id, created_by_admin_id")
        .eq("organization_id", organizationId)
        .not("created_by_admin_id", "is", null)
        .order("created_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (fetchError) throw fetchError;

      const page = (data ?? []) as HistoryRow[];
      const nextRows = append ? [...rows, ...page] : page;
      setRows(nextRows);
      setHasMore(page.length === PAGE_SIZE);

      const ids = new Set<string>();
      for (const r of page) { ids.add(r.user_id); ids.add(r.created_by_admin_id); }
      if (ids.size > 0) {
        const names = await fetchProfileNamesByUserIds(supabase, [...ids]);
        setNameByUserId((prev) => new Map([...prev, ...names]));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      append ? setLoadingMore(false) : setLoading(false);
    }
  };

  useEffect(() => {
    setRows([]);
    setNameByUserId(new Map());
    setHasMore(false);
    if (organizationId) void fetchPage(0, false);
  }, [organizationId]);

  const displayName = (userId: string): string => nameByUserId.get(userId.toLowerCase()) || "Unknown user";

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const emp = displayName(r.user_id).toLowerCase();
      const admin = displayName(r.created_by_admin_id).toLowerCase();
      return emp.includes(q) || admin.includes(q) || r.title.toLowerCase().includes(q);
    });
    // nameByUserId intentionally in deps — filter must react once names resolve
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, nameByUserId]);

  const openDetail = async (row: HistoryRow) => {
    setSelectedExpense(row);
    setDetailLogs(null);
    setDetailLoading(true);
    try {
      const { data: auditData, error: auditError } = await supabase
        .from("audit_logs")
        .select("user_id, action, comment, created_at")
        .eq("expense_id", row.id)
        .in("action", AUDIT_ACTIONS)
        .order("created_at", { ascending: false });
      if (auditError) throw auditError;
      const enriched = await enrichAuditLogsWithDisplay(auditData ?? []);
      setDetailLogs(enriched);
    } catch {
      setDetailLogs([]);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <History className="h-4 w-4" />
            Submission history
          </CardTitle>
          <CardDescription>
            Every expense an admin has submitted on behalf of an employee on this page — who, for whom, and when.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            placeholder="Search by employee, admin, or title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />

          {error && <p className="text-sm text-destructive">{error}</p>}

          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : filteredRows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {rows.length === 0 ? "No admin-submitted expenses yet." : "No rows match your search."}
            </p>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Submitted by</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.map((r) => (
                    <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50" onClick={() => void openDetail(r)}>
                      <TableCell className="truncate max-w-[160px]">{displayName(r.user_id)}</TableCell>
                      <TableCell className="truncate max-w-[160px]">{displayName(r.created_by_admin_id)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{formatHistoryDateTime(r.created_at)}</TableCell>
                      <TableCell className="truncate max-w-[200px]">{r.title}</TableCell>
                      <TableCell className="truncate max-w-[140px]">{r.category}</TableCell>
                      <TableCell className="text-right tabular-nums">{Number(r.total_amount).toFixed(2)}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_BADGE_VARIANT[r.status] ?? "outline"}>{r.status}</Badge>
                      </TableCell>
                      <TableCell><ChevronRight className="h-4 w-4 text-muted-foreground" /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {hasMore && !search && (
            <Button variant="outline" onClick={() => void fetchPage(rows.length, true)} disabled={loadingMore}>
              {loadingMore ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Load more
            </Button>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!selectedExpense} onOpenChange={(open) => { if (!open) setSelectedExpense(null); }}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {selectedExpense && (
            <>
              <SheetHeader>
                <SheetTitle>{selectedExpense.title}</SheetTitle>
                <SheetDescription>
                  {displayName(selectedExpense.user_id)} · {selectedExpense.category} · {Number(selectedExpense.total_amount).toFixed(2)}
                  <br />
                  Submitted by {displayName(selectedExpense.created_by_admin_id)} on {formatHistoryDateTime(selectedExpense.created_at)}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-6">
                {detailLoading ? (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                ) : detailLogs && detailLogs.length > 0 ? (
                  <ExpenseTimeline logs={detailLogs} />
                ) : (
                  <p className="text-sm text-muted-foreground">No history entries found for this expense.</p>
                )}
                <Button
                  variant="ghost" size="sm" className="mt-4"
                  onClick={() => void openDetail(selectedExpense)}
                  disabled={detailLoading}
                >
                  <RotateCcw className="mr-2 h-3.5 w-3.5" /> Refresh
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
