import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  anyConnectorOnline, describePwtJob, isPwtActive, listPwtConnectors, listPwtJobs, PWT_STATUS_LABEL, startPwtSync, toPwtReportType,
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

/** "Sync to Tally" for one report: button, live status, recent history and actionable errors. */
export function PwtSyncControl({ organizationId, disabled = false, params }: Props) {
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [jobs, setJobs] = useState<PwtJob[]>([]);
  const [connectorOnline, setConnectorOnline] = useState<boolean | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

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
    <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2" data-testid="pwt-sync">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void start()}
          disabled={disabled || starting || active || !organizationId || !report}
          data-testid="sync-to-tally"
        >
          {starting || active ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {starting ? "Starting sync…" : active ? "Sync in progress" : "Sync to Tally"}
        </Button>
        {latest && <Badge variant={statusVariant(latest.status)}>{PWT_STATUS_LABEL[latest.status]}</Badge>}
        <Link to="/admin/pwtally" className="text-xs text-primary hover:underline">
          Tally connector &amp; setup
        </Link>
      </div>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
      {latest && <p className="text-xs text-foreground" data-testid="pwt-latest">{describePwtJob(latest, connectorOnline)}</p>}
      {jobs.length > 1 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground" aria-label="Recent Tally syncs">
          {jobs.slice(1).map((j) => (
            <li key={j.id}>
              {new Date(j.created_at).toLocaleString()} · {PWT_STATUS_LABEL[j.status]} · {j.row_count.toLocaleString()} rows
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
