import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  anyConnectorOnline, continuePwtJob, describePwtJob, isPwtActive, listPwtConnectors, listPwtJobs, PWT_STATUS_LABEL, startPwtSync, toPwtReportType,
  type PwtJob, type PwtJobStatus, type PwtSyncParams,
} from "@/lib/pwt/pwtSync";

const POLL_MS = 3000;

function statusVariant(s: PwtJobStatus): "default" | "secondary" | "outline" | "destructive" | "success" {
  if (s === "completed") return "success";
  if (s === "failed" || s === "needs_attention") return "destructive";
  if (s === "queued") return "outline";
  return "secondary";
}

interface Props {
  organizationId: string | null;
  disabled?: boolean;
  /** Same filter inputs the existing report panel already holds, so Sync sees exactly what the report shows. */
  params: PwtSyncParams;
}

/** "Sync to Tally" for one report: button, live status, and actionable errors (no history list). */
export function PwtSyncControl({ organizationId, disabled = false, params }: Props) {
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
      setJobs(all.filter((j) => j.report_type === report).slice(0, 5));
      setConnectorOnline(anyConnectorOnline(await listPwtConnectors(organizationId)));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not load sync history");
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
    if (!organizationId || !report) return;
    setStarting(true);
    setMessage(null);
    try {
      const r = await startPwtSync({ ...params, organizationId });
      setMessage(r.deduplicated ? "An identical sync is already running." : "Sync queued.");
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Unable to start Tally sync");
    } finally {
      setStarting(false);
    }
  };

  const latest = jobs[0];
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm" data-testid="pwt-sync">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
            <RefreshCw className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold">Tally sync</h4>
              {latest && <Badge variant={statusVariant(latest.status)}>{PWT_STATUS_LABEL[latest.status]}</Badge>}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">Post these expenses to TallyPrime as vouchers.</p>
            {latest && <p className="mt-1 text-sm text-foreground" data-testid="pwt-latest">{describePwtJob(latest, connectorOnline)}</p>}
            {message && <p className="mt-1 text-xs text-muted-foreground">{message}</p>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            type="button"
            onClick={() => void start()}
            disabled={disabled || starting || active || !organizationId || !report}
            data-testid="sync-to-tally"
          >
            {starting || active ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {starting ? "Starting sync…" : active ? "Sync in progress" : "Sync to Tally"}
          </Button>
          <Link to="/admin/pwtally" className="text-xs text-primary hover:underline">
            Tally connector &amp; setup
          </Link>
        </div>
      </div>
    </div>
  );
}
