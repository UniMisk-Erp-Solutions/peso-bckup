import { Fragment, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatINR } from "@/lib/format";
import {
  describeInboundJob, getInboundProblems, listInboundJobs, PWT_INBOUND_STATE_LABEL, PWT_INBOUND_STATUS_LABEL,
  type PwtInboundJob, type PwtInboundProblem,
} from "@/lib/pwt/pwtInbound";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
}

function statusBadge(j: PwtInboundJob) {
  const label = PWT_INBOUND_STATUS_LABEL[j.status];
  if (j.status === "completed") return <Badge variant="success">{label}</Badge>;
  if (j.status === "failed" || j.status === "needs_attention") return <Badge variant="destructive">{label}</Badge>;
  return <Badge variant="secondary">{label}</Badge>;
}

/** Tally history: every "Sync from Tally" run (like Import History, but for payments read from TallyPrime). */
export function TallyHistoryDialog({ open, onOpenChange, organizationId }: Props) {
  const [jobs, setJobs] = useState<PwtInboundJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, PwtInboundProblem[]>>({});

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setJobs(await listInboundJobs(organizationId, 30));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the Tally history");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (j: PwtInboundJob) => {
    if (expanded === j.id) return setExpanded(null);
    setExpanded(j.id);
    if (!problems[j.id] && j.status !== "failed") {
      try {
        const p = await getInboundProblems(organizationId, j.id);
        setProblems((prev) => ({ ...prev, [j.id]: p }));
      } catch {
        setProblems((prev) => ({ ...prev, [j.id]: [] }));
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Tally History</DialogTitle>
          <DialogDescription>
            Every Sync from Tally: the payments read from TallyPrime and added to employee balances. Open a row for the details.
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
          <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
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
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => void toggle(j)}>
                          {expanded === j.id ? "Hide" : "Details"}
                        </Button>
                      </TableCell>
                    </TableRow>
                    {expanded === j.id && (
                      <TableRow>
                        <TableCell colSpan={6} className="bg-muted/30">
                          <p className="mb-2 text-sm">{describeInboundJob(j)}</p>
                          {(problems[j.id] ?? []).length > 0 && (
                            <table className="w-full text-left text-xs">
                              <thead>
                                <tr><th className="p-1.5">Voucher</th><th className="p-1.5">Date</th><th className="p-1.5">Ledger</th><th className="p-1.5 text-right">Amount</th><th className="p-1.5">Result</th></tr>
                              </thead>
                              <tbody>
                                {(problems[j.id] ?? []).map((p, i) => (
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
    </Dialog>
  );
}
