/**
 * Admin Submission History — server-paginated list of expenses created via
 * admin_submit_expense_for_employee_v2 (created_by_admin_id IS NOT NULL).
 *
 * Phase 22 requirement: never fetch every admin-submitted expense then
 * paginate locally. Every query below is bounded with .range() and carries
 * its own predicate's total_count via { count: "exact" }, so "total" always
 * reflects the CURRENT search/filter scope, not the unfiltered whole table.
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchProfileNamesByUserIds } from "@/lib/supabaseInQuery";
import { enrichAuditLogsWithDisplay, type AuditLogRow, type EnrichedAuditLog } from "@/lib/auditLogDisplay";
import { ExpenseTimeline } from "@/components/ExpenseTimeline";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const PAGE_SIZE = 25;

type HistoryRow = {
  id: string;
  user_id: string;
  created_by_admin_id: string;
  title: string;
  category: string;
  total_amount: number;
  status: string;
  created_at: string;
};

export function AdminExpenseHistoryTab({ organizationId }: { organizationId: string | null }) {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedExpenseId, setSelectedExpenseId] = useState<string | null>(null);
  const [selectedLogs, setSelectedLogs] = useState<EnrichedAuditLog[]>([]);

  const totalPages = useMemo(
    () => (totalCount == null ? null : Math.max(1, Math.ceil(totalCount / PAGE_SIZE))),
    [totalCount],
  );

  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        let query = db
          .from("expenses")
          .select("id, user_id, created_by_admin_id, title, category, total_amount, status, created_at", {
            count: "exact",
          })
          .eq("organization_id", organizationId)
          .not("created_by_admin_id", "is", null)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

        const trimmed = search.trim();
        if (trimmed) {
          query = query.ilike("title", `%${trimmed}%`);
        }

        const { data, error, count } = await query;
        if (error) throw error;
        if (cancelled) return;

        const fetched = (data ?? []) as HistoryRow[];
        setRows(fetched);
        setTotalCount(count ?? 0);

        const userIds = [
          ...fetched.map((r) => r.user_id),
          ...fetched.map((r) => r.created_by_admin_id),
        ];
        const resolved = await fetchProfileNamesByUserIds(supabase, userIds);
        if (!cancelled) setNames(resolved);
      } catch {
        if (!cancelled) {
          setRows([]);
          setTotalCount(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [organizationId, page, search]);

  async function openDetail(expenseId: string) {
    setSelectedExpenseId(expenseId);
    const { data } = await db
      .from("audit_logs")
      .select("user_id, action, comment, created_at")
      .eq("expense_id", expenseId)
      .order("created_at", { ascending: true });
    const enriched = await enrichAuditLogsWithDisplay((data ?? []) as AuditLogRow[]);
    setSelectedLogs(enriched);
  }

  function displayName(userId: string): string {
    return names.get(userId) ?? "Unknown";
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search by expense title…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          className="max-w-sm"
        />
        {totalCount != null && (
          <span className="text-sm text-muted-foreground">{totalCount} total</span>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Expense</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Created by</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer"
                onClick={() => void openDetail(row.id)}
              >
                <TableCell>{displayName(row.user_id)}</TableCell>
                <TableCell>
                  {row.title} <span className="text-muted-foreground">({row.category})</span>
                </TableCell>
                <TableCell>₹{Number(row.total_amount).toFixed(2)}</TableCell>
                <TableCell>{displayName(row.created_by_admin_id)}</TableCell>
                <TableCell>{new Date(row.created_at).toLocaleString()}</TableCell>
                <TableCell>
                  <Badge variant="outline">{row.status}</Badge>
                </TableCell>
              </TableRow>
            ))}
            {!loading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No admin-submitted expenses found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 0 || loading}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
        >
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          Page {page + 1}
          {totalPages != null ? ` of ${totalPages}` : ""}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || (totalPages != null && page + 1 >= totalPages)}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
      </div>

      <Dialog open={!!selectedExpenseId} onOpenChange={(open) => !open && setSelectedExpenseId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Expense history</DialogTitle>
          </DialogHeader>
          <ExpenseTimeline logs={selectedLogs} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
