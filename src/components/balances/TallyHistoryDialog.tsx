import { Fragment, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { formatINR } from "@/lib/format";
import { reverseImportBatchV3 } from "@/services/BalanceLedgerService";
import { getImportRows, type ImportRowDetail } from "@/services/BalanceImportService";
import { describePwtError } from "@/lib/pwt/pwtErrors";
import {
  describeInboundJob, getInboundProblems, listInboundJobs, PWT_INBOUND_STATE_LABEL, PWT_INBOUND_STATUS_LABEL,
  type PwtInboundJob, type PwtInboundProblem,
} from "@/lib/pwt/pwtInbound";

/** The balance engine records a reason with every reversal; the screen does not ask for one. */
const REVERSE_REASON = "Reversed from Tally History";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
}

function statusBadge(j: PwtInboundJob) {
  if (j.batch_status === "reversed") return <Badge variant="secondary">Reversed</Badge>;
  const label = PWT_INBOUND_STATUS_LABEL[j.status];
  if (j.status === "completed") return <Badge variant="success">{label}</Badge>;
  if (j.status === "failed" || j.status === "needs_attention") return <Badge variant="destructive">{label}</Badge>;
  return <Badge variant="secondary">{label}</Badge>;
}

/** Tally history: every "Sync from Tally" run, per employee, with Reverse import (same engine as Import History). */
export function TallyHistoryDialog({ open, onOpenChange, organizationId }: Props) {
  const { toast } = useToast();
  const [jobs, setJobs] = useState<PwtInboundJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [rows, setRows] = useState<ImportRowDetail[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<PwtInboundProblem[]>([]);

  const [reverseJob, setReverseJob] = useState<PwtInboundJob | null>(null);
  const [reversing, setReversing] = useState(false);
  const [reversedCount, setReversedCount] = useState<{ jobId: string; count: number } | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setJobs(await listInboundJobs(organizationId, 30));
    } catch (e) {
      setError(describePwtError(e, "Could not load the Tally history. Press Refresh."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      void load();
    } else {
      setExpanded(null);
      setRows([]);
      setProblems([]);
      setReverseJob(null);
      setReversedCount(null);
    }
  }, [open, organizationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (j: PwtInboundJob) => {
    if (expanded === j.id) {
      setExpanded(null);
      return;
    }
    setExpanded(j.id);
    setDetailLoading(true);
    setRows([]);
    setNames({});
    setProblems([]);
    try {
      if (j.batch_id) {
        const r = await getImportRows(j.batch_id);
        setRows(r);
        const ids = Array.from(new Set(r.map((x) => x.matched_user_id).filter((id): id is string => !!id)));
        if (ids.length > 0) {
          const { data } = await supabase.from("profiles").select("user_id, name").in("user_id", ids);
          const m: Record<string, string> = {};
          (data ?? []).forEach((p: { user_id: string; name: string | null }) => { m[p.user_id] = p.name || p.user_id; });
          setNames(m);
        }
      }
      if (j.status !== "failed") setProblems(await getInboundProblems(organizationId, j.id));
    } catch (e) {
      toast({ variant: "destructive", title: "Could not load the details", description: describePwtError(e, "Please try again.") });
    } finally {
      setDetailLoading(false);
    }
  };

  const confirmReverse = async () => {
    if (!reverseJob?.batch_id) return;
    setReversing(true);
    try {
      const res = await reverseImportBatchV3(reverseJob.batch_id, REVERSE_REASON);
      setReversedCount({ jobId: reverseJob.id, count: res.reversed_count });
      setReverseJob(null);
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Reversal failed", description: describePwtError(e, "Nothing was changed. Try again.") });
    } finally {
      setReversing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Tally History</DialogTitle>
          <DialogDescription>
            Every Sync from Tally: the payments read from TallyPrime and added to employee balances. Open a row to see each employee.
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Refresh
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {!error && !loading && jobs.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No Sync from Tally has been run yet.</p>
        )}

        {jobs.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Imported</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((j) => (
                  <Fragment key={j.id}>
                    <TableRow>
                      <TableCell className="whitespace-nowrap">{new Date(j.created_at).toLocaleString()}</TableCell>
                      <TableCell>{j.tally_company}</TableCell>
                      <TableCell>{statusBadge(j)}</TableCell>
                      <TableCell className="text-right">{j.imported_count}</TableCell>
                      <TableCell className="text-right">{formatINR(j.imported_amount)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <Button variant="ghost" size="sm" onClick={() => void toggle(j)}>
                          {expanded === j.id ? "Hide" : "Details"}
                        </Button>
                        {j.batch_id && j.batch_status === "applied" && j.imported_count > 0 && (
                          <Button variant="destructive" size="sm" onClick={() => setReverseJob(j)}>
                            Reverse Import
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>

                    {expanded === j.id && (
                      <TableRow>
                        <TableCell colSpan={6} className="bg-muted/30">
                          <div className="space-y-3 py-1">
                            <p className="text-sm">{describeInboundJob(j)}</p>
                            {reversedCount?.jobId === j.id && (
                              <p className="text-sm text-emerald-700">Reversed {reversedCount.count} employee(s).</p>
                            )}
                            {detailLoading ? (
                              <p className="text-sm text-muted-foreground">Loading…</p>
                            ) : (
                              <>
                                {rows.length > 0 && (
                                  <div className="overflow-x-auto rounded-md border bg-background">
                                    <Table>
                                      <TableHeader>
                                        <TableRow>
                                          <TableHead>Employee ID</TableHead>
                                          <TableHead>Employee</TableHead>
                                          <TableHead className="text-right">Before</TableHead>
                                          <TableHead className="text-right">Added</TableHead>
                                          <TableHead className="text-right">After</TableHead>
                                          <TableHead>Note</TableHead>
                                        </TableRow>
                                      </TableHeader>
                                      <TableBody>
                                        {rows.map((r) => (
                                          <TableRow key={r.id}>
                                            <TableCell className="font-mono text-xs">{r.raw_employee_id || "-"}</TableCell>
                                            <TableCell className="text-xs">
                                              {(r.matched_user_id && names[r.matched_user_id]) || (r.matched_user_id ? r.matched_user_id : "Unmatched")}
                                            </TableCell>
                                            <TableCell className="text-right text-xs">
                                              {r.current_balance_snapshot !== null ? formatINR(r.current_balance_snapshot) : "-"}
                                            </TableCell>
                                            <TableCell className="text-right text-xs">
                                              {r.input_amount !== null ? formatINR(r.input_amount) : "-"}
                                            </TableCell>
                                            <TableCell className="text-right text-xs">
                                              {r.calculated_new_balance !== null ? formatINR(r.calculated_new_balance) : "-"}
                                            </TableCell>
                                            <TableCell className="text-xs">{r.note || "-"}</TableCell>
                                          </TableRow>
                                        ))}
                                      </TableBody>
                                    </Table>
                                  </div>
                                )}
                                {problems.length > 0 && (
                                  <table className="w-full text-left text-xs">
                                    <thead>
                                      <tr><th className="p-1.5">Voucher</th><th className="p-1.5">Date</th><th className="p-1.5">Ledger</th><th className="p-1.5 text-right">Amount</th><th className="p-1.5">Not imported because</th></tr>
                                    </thead>
                                    <tbody>
                                      {problems.map((p, i) => (
                                        <tr key={i} className="border-t border-border align-top">
                                          <td className="p-1.5">{p.voucher_number ?? "-"}</td>
                                          <td className="p-1.5">{p.voucher_date ?? "-"}</td>
                                          <td className="p-1.5">{p.ledger_name}</td>
                                          <td className="p-1.5 text-right">{formatINR(p.amount)}</td>
                                          <td className="p-1.5"><b>{PWT_INBOUND_STATE_LABEL[p.state] ?? p.state}</b>{p.reason ? `: ${p.reason}` : ""}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                                {rows.length === 0 && problems.length === 0 && (
                                  <p className="text-xs text-muted-foreground">No employee payments in this sync.</p>
                                )}
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>

      <Dialog open={reverseJob !== null} onOpenChange={(o) => { if (!o) setReverseJob(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reverse Import</DialogTitle>
            <DialogDescription>
              This removes the amounts this sync added to the employees' balances (a compensating entry for each employee).
              The vouchers stay in Tally and are not imported again by a later sync.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseJob(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void confirmReverse()} disabled={reversing}>
              {reversing ? "Reversing..." : "Reverse Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
