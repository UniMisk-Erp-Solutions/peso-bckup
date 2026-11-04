/**
 * Balance credit history (admin): every credit added to an employee balance, labelled by where it came from —
 * typed by an admin ("Manual entry"), imported from TallyPrime ("Tally sync") or from a file ("Import").
 * Read-only view of the immutable balance ledger; it never changes a balance.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { fetchProfileNamesByUserIds } from "@/lib/supabaseInQuery";
import { formatINR } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ListPagination } from "@/components/ListPagination";

export type CreditOrigin = "manual" | "tally" | "import" | "reversal";

export interface LedgerCreditRow {
  id: string;
  user_id: string;
  amount_delta: number;
  balance_after: number;
  entry_type: string;
  source_type: string;
  actor_user_id: string | null;
  effective_at: string;
  created_at: string;
  note: string | null;
  idempotency_key: string | null;
}

export const ORIGIN_LABEL: Record<CreditOrigin, string> = {
  manual: "Manual entry",
  tally: "Tally sync",
  import: "Import",
  reversal: "Reversal",
};

/** Where a ledger credit came from. Tally payments carry the `tally:` idempotency key set by Sync from Tally. */
export function creditOrigin(r: Pick<LedgerCreditRow, "entry_type" | "source_type" | "idempotency_key">): CreditOrigin {
  if (r.entry_type === "credit_reversal") return "reversal";
  if ((r.idempotency_key ?? "").startsWith("tally:")) return "tally";
  if (r.source_type === "admin_credit_v3") return "manual";
  return "import";
}

/** The ledger stores the business date as a UTC anchor (00:00 / 23:59:59 UTC); show that calendar day, not the viewer-timezone shift. */
export const voucherDay = (iso: string) => format(new Date(`${iso.slice(0, 10)}T12:00:00`), "MMM d, yyyy");

const CREDIT_TYPES = ["opening_credit", "balance_credit", "credit_reversal"];
const KIND_LABEL: Record<string, string> = {
  opening_credit: "Opening Credit",
  balance_credit: "Balance Credit",
  credit_reversal: "Reversal",
};

interface Props {
  organizationId: string;
  /** Bump to reload (e.g. after a Tally sync). */
  refreshKey?: number;
}

export function BalanceCreditHistory({ organizationId, refreshKey = 0 }: Props) {
  const [rows, setRows] = useState<LedgerCreditRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<"all" | CreditOrigin>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: e } = await (supabase as unknown as { from: (t: string) => any })
        .from("balance_ledger")
        .select("id,user_id,amount_delta,balance_after,entry_type,source_type,actor_user_id,effective_at,created_at,note,idempotency_key")
        .eq("organization_id", organizationId)
        .in("entry_type", CREDIT_TYPES)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (e) throw e;
      const list = ((data ?? []) as unknown as LedgerCreditRow[]).map((r) => ({
        ...r,
        amount_delta: Number(r.amount_delta),
        balance_after: Number(r.balance_after),
      }));
      setRows(list);
      const ids = new Set<string>();
      list.forEach((r) => {
        ids.add(r.user_id);
        if (r.actor_user_id) ids.add(r.actor_user_id);
      });
      setNames(ids.size ? await fetchProfileNamesByUserIds(supabase, Array.from(ids)) : new Map());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load balance credits.");
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const nameOf = (id: string | null) => (id ? names.get(id.toLowerCase()) || names.get(id) || "Unknown" : "-");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (origin !== "all" && creditOrigin(r) !== origin) return false;
      if (!q) return true;
      return nameOf(r.user_id).toLowerCase().includes(q) || (r.note ?? "").toLowerCase().includes(q);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, origin, search, names]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pageCount);
  const paged = filtered.slice((current - 1) * pageSize, current * pageSize);

  const counts = useMemo(() => {
    const c: Record<CreditOrigin, number> = { manual: 0, tally: 0, import: 0, reversal: 0 };
    rows.forEach((r) => { c[creditOrigin(r)] += 1; });
    return c;
  }, [rows]);

  return (
    <Card data-testid="balance-credit-history">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Balance credit history</CardTitle>
            <CardDescription>
              Every credit added to an employee balance: typed by an admin, synced from Tally, or imported from a file.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="whitespace-nowrap">
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="text-sm font-medium mb-2 block">Search</label>
            <Input placeholder="Search by employee or note..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <div>
            <label className="text-sm font-medium mb-2 block">Source</label>
            <Select value={origin} onValueChange={(v) => { setOrigin(v as "all" | CreditOrigin); setPage(1); }}>
              <SelectTrigger data-testid="credit-history-source"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources ({rows.length})</SelectItem>
                <SelectItem value="manual">Manual entry ({counts.manual})</SelectItem>
                <SelectItem value="tally">Tally sync ({counts.tally})</SelectItem>
                <SelectItem value="import">Import ({counts.import})</SelectItem>
                <SelectItem value="reversal">Reversal ({counts.reversal})</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {error ? (
          <p className="text-center text-destructive py-6">{error}</p>
        ) : loading && rows.length === 0 ? (
          <p className="text-center text-muted-foreground py-6">Loading...</p>
        ) : filtered.length === 0 ? (
          <p className="text-center text-muted-foreground py-6">No balance credits found</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">Date & Time</TableHead>
                  <TableHead className="whitespace-nowrap">Employee</TableHead>
                  <TableHead className="whitespace-nowrap">Amount</TableHead>
                  <TableHead className="whitespace-nowrap">Kind</TableHead>
                  <TableHead className="whitespace-nowrap">Source</TableHead>
                  <TableHead className="whitespace-nowrap">Entered by</TableHead>
                  <TableHead className="whitespace-nowrap">Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.map((r) => {
                  const o = creditOrigin(r);
                  return (
                    <TableRow key={r.id} data-testid="credit-history-row" data-origin={o}>
                      <TableCell className="whitespace-nowrap">
                        <div>{format(new Date(r.created_at), "MMM d, yyyy h:mm a")}</div>
                        <div className="text-xs text-muted-foreground">{o === "tally" ? "voucher date" : "effective date"} {voucherDay(r.effective_at)}</div>
                      </TableCell>
                      <TableCell className="font-medium">{nameOf(r.user_id)}</TableCell>
                      <TableCell className={`font-semibold ${r.amount_delta < 0 ? "text-destructive" : ""}`}>{formatINR(r.amount_delta)}</TableCell>
                      <TableCell>{KIND_LABEL[r.entry_type] ?? r.entry_type}</TableCell>
                      <TableCell>
                        <Badge variant={o === "tally" ? "default" : "secondary"}>{ORIGIN_LABEL[o]}</Badge>
                      </TableCell>
                      <TableCell>{o === "tally" ? "Tally connector" : nameOf(r.actor_user_id)}</TableCell>
                      <TableCell className="max-w-[260px] truncate" title={r.note ?? undefined}>{r.note || "-"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <ListPagination page={current} pageSize={pageSize} totalItems={filtered.length} onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(1); }} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
