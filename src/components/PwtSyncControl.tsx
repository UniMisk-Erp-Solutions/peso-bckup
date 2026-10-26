import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, History, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describePwtError } from "@/lib/pwt/pwtErrors";
import {
  anyConnectorOnline, continuePwtJob, describePwtJob, isPwtActive, listPwtConnectors, listPwtJobs, startPwtSync, toPwtReportType,
  type PwtJob, type PwtSyncParams,
} from "@/lib/pwt/pwtSync";

const POLL_MS = 3000;


interface Props {
  organizationId: string | null;
  disabled?: boolean;
  /** Same filter inputs the existing report panel already holds, so Sync sees exactly what the report shows. */
  params: PwtSyncParams;
  /** Receives the Sync button and the status box so the page can place each where it wants. */
  children: (parts: { button: ReactNode; status: ReactNode; history: ReactNode }) => ReactNode;
}

/** "Sync to Tally" for one report: button, live status, and actionable errors (no history list). */
export function PwtSyncGroup({ organizationId, disabled = false, params, children }: Props) {
  const [shown, setShown] = useState(false);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [jobs, setJobs] = useState<PwtJob[]>([]);
  const [connectorOnline, setConnectorOnline] = useState<boolean | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const driving = useRef(false);
  let report: ReturnType<typeof toPwtReportType> | null = null;
  try {
    report = toPwtReportType(params.reportType as string);
  } catch {
    report = null;
  }

  const refresh = useCallback(async () => {
    if (!organizationId) return;
    try {
      const all = await listPwtJobs(organizationId, 25);
      setJobs(all.filter((j) => j.report_type === report).slice(0, 10));
      setConnectorOnline(anyConnectorOnline(await listPwtConnectors(organizationId)));
    } catch (e) {
      setMessage(describePwtError(e, "Could not load the sync history. Refresh the page."));
    }
  }, [organizationId, report]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = jobs.some((j) => isPwtActive(j.status));
  useEffect(() => {
    if (!active) return;
    timer.current = setInterval(() => void refresh(), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [active, refresh]);

  // A large report is prepared in short slices; while a job is preparing, this page asks for the next slice until it is ready.
  const preparing = jobs.find((j) => j.status === "queued" || j.status === "preparing");
  const preparingId = preparing?.id ?? null;
  const wantedJob = useRef<string | null>(null);
  wantedJob.current = preparingId;
  useEffect(() => {
    if (!organizationId || !preparingId || driving.current) return;
    driving.current = true;
    void (async () => {
      try {
        // keep going while this job is still the one being prepared (one loop per page, never two at once). A slice that the server cut off
        // (or a dropped connection) is simply asked for again; the job resumes from its last saved position.
        let failures = 0;
        const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));
        while (wantedJob.current === preparingId && failures < 40) {
          try {
            const r = await continuePwtJob(organizationId, preparingId);
            if (r.done) break;
            if (r.error) { failures += 1; await pause(2500); continue; }
            failures = 0;
            if (!r.claimed) await pause(1500); // another slice is running; check again shortly
          } catch {
            failures += 1;
            await pause(2500);
          }
        }
      } catch {
        /* the normal status refresh shows any failure */
      } finally {
        driving.current = false;
        void refresh();
      }
    })();
  }, [organizationId, preparingId, refresh]);
  useEffect(() => () => { wantedJob.current = null; }, []);

  const start = async () => {
    setShown(true);
    if (!organizationId || !report) return;
    setStarting(true);
    setMessage(null);
    try {
      const r = await startPwtSync({ ...params, organizationId });
      setMessage(r.deduplicated ? "An identical sync is already running." : null);
      await refresh();
    } catch (e) {
      setMessage(describePwtError(e, "The sync could not be started. Try again."));
    } finally {
      setStarting(false);
    }
  };

  const latest = jobs[0];
  const done = !!latest && latest.status === "completed" && !!latest.completed_at;
  const failed = !!latest && (latest.status === "failed" || latest.status === "needs_attention");
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) : "";

  const button = (
    <Button
      type="button"
      className="bg-emerald-600 text-white hover:bg-emerald-700"
      onClick={() => void start()}
      disabled={disabled || starting || active || !organizationId || !report}
      data-testid="sync-to-tally"
    >
      {starting || active ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
      {starting ? "Starting sync…" : active ? "Sync in progress" : "Sync to Tally"}
    </Button>
  );

  // The progress / result box only appears once someone has pressed Sync (or a sync is already running).
  const status = !(shown || active) ? null : (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm" data-testid="pwt-sync">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
            <RefreshCw className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <h4 className="text-sm font-semibold">Send expenses to Tally</h4>
            <p className="text-xs text-muted-foreground">
              Posts the expenses of this report to TallyPrime as vouchers. Each expense is sent only once.
            </p>
            {!latest && !message && <p className="pt-1 text-sm text-muted-foreground">Starting…</p>}
            {latest && active && (
              <p className="flex items-center gap-2 pt-1 text-sm" data-testid="pwt-latest">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span>{describePwtJob(latest, connectorOnline)}</span>
              </p>
            )}
            {latest && done && !active && (
              <p className="flex items-center gap-2 pt-1 text-sm" data-testid="pwt-latest">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                <span>
                  {latest.voucher_count
                    ? `${latest.posted_count.toLocaleString()} expenses sent to Tally in ${latest.voucher_count} voucher(s)`
                    : "Everything is already in Tally. Nothing new to send"}
                  <span className="text-muted-foreground"> · {when(latest.completed_at)}</span>
                </span>
              </p>
            )}
            {latest && failed && !active && (
              <div className="mt-1 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm" data-testid="pwt-latest">
                <p className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <span>{describePwtJob(latest, connectorOnline)}</span>
                </p>
              </div>
            )}
            {message && <p className="text-xs text-muted-foreground">{message}</p>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {connectorOnline !== undefined && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={`h-2 w-2 rounded-full ${connectorOnline ? "bg-emerald-500" : "bg-amber-500"}`} />
              {connectorOnline ? "Tally PC connected" : "Tally PC offline"}
            </span>
          )}
          <Link to="/admin/pwtally" className="text-xs text-primary hover:underline">
            Tally setup
          </Link>
        </div>
      </div>
    </div>
  );

  const history = (
    <section aria-label="Sync history" className="rounded-lg border border-border bg-background p-3 shadow-sm space-y-2" data-testid="pwt-history">
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <h4 className="text-sm font-semibold">Tally sync history</h4>
      </div>
      {jobs.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">Nothing has been sent to Tally yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {jobs.map((j) => (
            <li key={j.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{when(j.created_at)}</p>
                <p className="text-xs text-muted-foreground">
                  {j.status === "completed"
                    ? j.voucher_count
                      ? `${j.posted_count.toLocaleString()} expenses · ${j.voucher_count} voucher(s)`
                      : "Nothing new to send"
                    : j.status === "failed" || j.status === "needs_attention"
                      ? "Not completed. Open the latest sync for details"
                      : "In progress"}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  j.status === "completed" ? "bg-emerald-100 text-emerald-800"
                    : j.status === "failed" || j.status === "needs_attention" ? "bg-red-100 text-red-800"
                      : "bg-slate-100 text-slate-700"}`}
              >
                {j.status === "completed" ? "Sent" : j.status === "failed" || j.status === "needs_attention" ? "Needs attention" : "In progress"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return <>{children({ button, status, history })}</>;
}

/** Stand-alone layout (button, then the box once Sync was pressed). */
export function PwtSyncControl(props: Omit<Props, "children">) {
  return <PwtSyncGroup {...props}>{({ button, status, history }) => <div className="space-y-2">{button}{status}{history}</div>}</PwtSyncGroup>;
}
