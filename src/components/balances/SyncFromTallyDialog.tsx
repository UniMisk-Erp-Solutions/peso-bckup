import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { formatINR } from "@/lib/format";
import { describePwtError } from "@/lib/pwt/pwtErrors";
import { listPwtConnectors, anyConnectorOnline } from "@/lib/pwt/pwtSync";
import {
  describeInboundDates, describeInboundJob, getInboundProblems, inboundSupportsDates, getInboundVoucherType, setInboundVoucherType, isInboundActive, lastSuccessful, listInboundJobs, PWT_INBOUND_STATE_LABEL,
  PWT_INBOUND_STATUS_LABEL, startInboundSync, type InboundRange, type PwtInboundJob, type PwtInboundProblem,
} from "@/lib/pwt/pwtInbound";

const POLL_MS = 2000;

/** Local yyyy-mm-dd (never UTC, so "today" and "first of the month" match the user's calendar). */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const firstOfThisMonth = () => { const n = new Date(); return ymd(new Date(n.getFullYear(), n.getMonth(), 1)); };
const lastMonthRange = () => { const n = new Date(); return { from: ymd(new Date(n.getFullYear(), n.getMonth() - 1, 1)), to: ymd(new Date(n.getFullYear(), n.getMonth(), 0)) }; };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  /** Called once per finished sync so the Employee Balances table can reload. */
  onSynced: () => void;
}

function Tile({ label, value, tone }: { label: string; value: string | number; tone?: "bad" | "good" }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold ${tone === "bad" ? "text-destructive" : tone === "good" ? "text-green-700" : ""}`}>{value}</div>
    </div>
  );
}

/** Admin dialog: pull employee payments entered in TallyPrime ("PesoWise Payment" vouchers) into PesoWise balances. */
export function SyncFromTallyDialog({ open, onOpenChange, organizationId, onSynced }: Props) {
  const [jobs, setJobs] = useState<PwtInboundJob[]>([]);
  const [problems, setProblems] = useState<PwtInboundProblem[]>([]);
  const [connectorOnline, setConnectorOnline] = useState<boolean | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [voucherType, setVoucherType] = useState("PesoWise Payment");
  const [savedType, setSavedType] = useState("PesoWise Payment");
  // Which payments to read, by the VOUCHER date in Tally. The safe default is "this month onwards"; "all dates" needs an explicit tick.
  const [mode, setMode] = useState<"range" | "all">("range");
  const [dateFrom, setDateFrom] = useState(firstOfThisMonth);
  const [dateTo, setDateTo] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);
  const refreshedFor = useRef<string | null>(null);
  /** True once this dialog has seen (or started) an active sync, so its completion reloads the balances exactly once. */
  const sawActive = useRef(false);

  const latest = jobs[0];
  const active = !!latest && isInboundActive(latest.status);

  const refresh = useCallback(async () => {
    try {
      const j = await listInboundJobs(organizationId, 10);
      setJobs(j);
      setConnectorOnline(anyConnectorOnline(await listPwtConnectors(organizationId)));
      const top = j[0];
      if (top && isInboundActive(top.status)) sawActive.current = true;
      if (top && !isInboundActive(top.status) && refreshedFor.current !== top.id) {
        // a sync finished: load the reasons for anything not imported, and reload balances once if we watched it run
        refreshedFor.current = top.id;
        if (top.status !== "failed") setProblems(await getInboundProblems(organizationId, top.id));
        if (sawActive.current) {
          sawActive.current = false;
          onSynced();
        }
      }
    } catch (e) {
      setMessage(describePwtError(e, "Could not load the sync status. Close and reopen this window."));
    }
  }, [organizationId, onSynced]);

  useEffect(() => {
    if (!open) return;
    refreshedFor.current = null;
    sawActive.current = false;
    void refresh();
    void getInboundVoucherType(organizationId).then((t) => { setVoucherType(t); setSavedType(t); }).catch(() => undefined);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !active) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [open, active, refresh]);

  const start = async () => {
    let range: InboundRange = {};
    if (mode === "range") {
      if (!dateFrom && !dateTo) { setMessage("Choose a start date, or switch to All dates."); return; }
      if (dateFrom && dateTo && dateFrom > dateTo) { setMessage("The start date is after the end date."); return; }
      range = { from: dateFrom || null, to: dateTo || null };
    } else if (!confirmAll) {
      setMessage("Tick the box to confirm that all dates should be read.");
      return;
    }
    setStarting(true);
    setMessage(null);
    setProblems([]);
    try {
      // dates are sent only in range mode; an old server would ignore them and read every date, so refuse instead
      if (mode === "range" && !(await inboundSupportsDates())) {
        setMessage("The server has not been updated for date selection yet, so nothing was started. Ask the administrator to finish the update.");
        return;
      }
      const r = await startInboundSync(organizationId, range);
      refreshedFor.current = null;
      sawActive.current = true;
      setMessage(r.deduplicated ? "A sync is already running." : "Sync started. Reading vouchers from TallyPrime…");
      await refresh();
    } catch (e) {
      setMessage(describePwtError(e, "Sync from Tally could not be started. Try again."));
    } finally {
      setStarting(false);
    }
  };

  const saveType = async () => {
    setMessage(null);
    try {
      await setInboundVoucherType(organizationId, voucherType);
      setSavedType(voucherType.trim());
      setMessage("Voucher type saved. The next sync reads this exact type.");
    } catch (e) {
      setMessage(describePwtError(e, "Could not save the voucher type. Try again."));
    }
  };

  const last = lastSuccessful(jobs);
  const pct = latest?.progress_total ? Math.round((latest.progress_current / latest.progress_total) * 100) : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Sync from Tally</DialogTitle>
          <DialogDescription>
            Imports employee payments entered in TallyPrime as vouchers of type <b>{savedType}</b> (Dr employee ledger, Cr cash/bank) and adds
            each one to that employee's balance. Each voucher is imported once; running this again never duplicates a payment.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1 space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="pwt-inbound-type">Tally voucher type (exact name)</label>
              <Input id="pwt-inbound-type" value={voucherType} onChange={(e) => setVoucherType(e.target.value)} disabled={active} />
            </div>
            <Button variant="outline" size="sm" onClick={() => void saveType()} disabled={active || !voucherType.trim() || voucherType.trim() === savedType}>Save</Button>
          </div>
          <div className="space-y-2 rounded-md border border-border p-3" data-testid="sync-from-tally-dates">
            <div className="text-xs font-medium">Which payments to read (by the voucher date in Tally)</div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="pwt-range-mode" checked={mode === "range"} onChange={() => setMode("range")} disabled={active} data-testid="sync-mode-range" />
                Date range
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="pwt-range-mode" checked={mode === "all"} onChange={() => setMode("all")} disabled={active} data-testid="sync-mode-all" />
                All dates (no filter)
              </label>
            </div>
            {mode === "range" ? (
              <>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground" htmlFor="pwt-date-from">From</label>
                    <Input id="pwt-date-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} disabled={active} />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground" htmlFor="pwt-date-to">To (optional)</label>
                    <Input id="pwt-date-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} disabled={active} />
                  </div>
                  <Button variant="outline" size="sm" disabled={active} onClick={() => { setDateFrom(firstOfThisMonth()); setDateTo(""); }}>This month</Button>
                  <Button variant="outline" size="sm" disabled={active} onClick={() => { const r = lastMonthRange(); setDateFrom(r.from); setDateTo(r.to); }}>Last month</Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Only vouchers dated in this range are read. Leave "To" empty to read from the start date onwards. Payments outside the range are never imported.
                </p>
              </>
            ) : (
              <>
                <p className="text-xs text-amber-700">
                  Reads every voucher of this type from all months. Payments that are already part of the employee balances would be credited again.
                </p>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={confirmAll} onChange={(e) => setConfirmAll(e.target.checked)} disabled={active} data-testid="sync-confirm-all" />
                  I understand, read all dates
                </label>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void start()} disabled={starting || active} data-testid="sync-from-tally-start">
              {starting || active ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {starting ? "Starting…" : active ? "Sync in progress" : "Sync now"}
            </Button>
            {latest && <Badge variant={latest.status === "completed" ? "success" : latest.status === "failed" ? "destructive" : latest.status === "needs_attention" ? "destructive" : "secondary"}>
              {PWT_INBOUND_STATUS_LABEL[latest.status]}
            </Badge>}
            <span className="text-xs text-muted-foreground">
              {last?.completed_at ? `Last sync: ${new Date(last.completed_at).toLocaleString()}` : "No sync yet"}
            </span>
          </div>

          {message && <p className="text-xs text-muted-foreground">{message}</p>}
          {latest && <p className="text-sm" data-testid="sync-from-tally-summary">{describeInboundJob(latest, connectorOnline)}</p>}
          {latest && latest.date_from !== undefined && (
            <p className="text-xs text-muted-foreground" data-testid="sync-from-tally-dates-read">Dates read: {describeInboundDates(latest.date_from, latest.date_to)}</p>
          )}
          {active && pct !== undefined && <Progress value={pct} />}

          {latest && !active && latest.status !== "failed" && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="sync-from-tally-tiles">
              <Tile label="Vouchers fetched" value={latest.vouchers_fetched} />
              <Tile label="Payments imported" value={latest.imported_count} tone={latest.imported_count ? "good" : undefined} />
              <Tile label="Already imported" value={latest.already_imported_count} />
              <Tile label="Amount imported" value={formatINR(latest.imported_amount)} tone={latest.imported_amount ? "good" : undefined} />
              <Tile label="Skipped" value={latest.skipped_count} />
              <Tile label="Employee not matched" value={latest.unmatched_count} tone={latest.unmatched_count ? "bad" : undefined} />
              <Tile label="Failed" value={latest.failed_count} tone={latest.failed_count ? "bad" : undefined} />
              <Tile label="Flagged for review" value={latest.flagged_count} tone={latest.flagged_count ? "bad" : undefined} />
            </div>
          )}

          {problems.length > 0 && (
            <div className="max-h-56 overflow-auto rounded-md border border-border">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr><th className="p-1.5">Voucher</th><th className="p-1.5">Date</th><th className="p-1.5">Ledger</th><th className="p-1.5 text-right">Amount</th><th className="p-1.5">Result</th></tr>
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
            </div>
          )}

          {jobs.length > 1 && (
            <ul className="space-y-0.5 text-xs text-muted-foreground" aria-label="Recent syncs from Tally">
              {jobs.slice(1, 6).map((j) => (
                <li key={j.id}>{new Date(j.created_at).toLocaleString()} · {PWT_INBOUND_STATUS_LABEL[j.status]} · {j.imported_count} imported ({formatINR(j.imported_amount)}){j.date_from !== undefined ? ` · ${describeInboundDates(j.date_from, j.date_to)}` : ""}</li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
