import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Copy, RefreshCw, Plug, Server, FileText } from "lucide-react";
import { fetchTallyCompanyName, saveTallyCompanyName } from "@/lib/tallyOrgConfig";
import {
  createTallyConnectorPairingCode,
  cancelUntouchedTallySyncJob,
  fetchTallyPendingBatches,
  fetchRecentTallySyncJobs,
  fetchTallyConnectorDevices,
  isConnectorDeviceOnline,
  revokeTallyConnectorDevice,
  quarantineTallyPendingBatches,
  type TallyPendingBatch,
  type TallyConnectorDeviceRow,
  type TallySyncJobHealthRow,
} from "@/lib/tallyConnectorCloud";
import { pesoWiseTallyConnectUrl } from "@/lib/tallySetupLinks";
import { fetchLocalTallyBridgeHealth, localTallyBridgeMatches } from "@/lib/localTallyBridge";

const DEFAULT_COMPANY =
  (import.meta.env.VITE_DEFAULT_TALLY_COMPANY_NAME as string | undefined)?.trim() ||
  "PesoWise Integration Test";

function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

export default function TallyIntegration() {
  const { organizationId, userRole } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState<TallyConnectorDeviceRow[]>([]);
  const [jobs, setJobs] = useState<TallySyncJobHealthRow[]>([]);
  const [company, setCompany] = useState("");
  const [companySaving, setCompanySaving] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [pendingBatches, setPendingBatches] = useState<TallyPendingBatch[]>([]);
  const [pendingJobLookup, setPendingJobLookup] = useState("");
  const [lookedUpPendingBatches, setLookedUpPendingBatches] = useState<TallyPendingBatch[]>([]);
  const [pendingLookupBusy, setPendingLookupBusy] = useState(false);
  const [quarantiningJobId, setQuarantiningJobId] = useState<string | null>(null);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [localCompanyVerified, setLocalCompanyVerified] = useState(false);

  const refresh = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    try {
      const [devs, recentJobs, co, pending, localBridgeHealth] = await Promise.all([
        fetchTallyConnectorDevices(organizationId),
        fetchRecentTallySyncJobs(organizationId),
        fetchTallyCompanyName(organizationId).catch(() => null),
        fetchTallyPendingBatches(organizationId),
        fetchLocalTallyBridgeHealth(),
      ]);
      const expectedCompany = (co ?? DEFAULT_COMPANY).trim();
      setDevices(devs);
      setJobs(recentJobs);
      setCompany(expectedCompany);
      setPendingBatches(pending);
      setLocalCompanyVerified(
        localTallyBridgeMatches(localBridgeHealth, organizationId, expectedCompany),
      );
    } catch (e) {
      toast({
        title: "Could not load Tally integration",
        description: e instanceof Error ? e.message : "Try again",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [organizationId, toast]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  const prepareThisPc = async () => {
    if (!organizationId) return;
    setPairingBusy(true);
    try {
      const trimmed = company.trim() || DEFAULT_COMPANY;
      await saveTallyCompanyName(organizationId, trimmed);
      const { pairing_code } = await createTallyConnectorPairingCode(organizationId, 45);
      setPairingCode(pairing_code);
      toast({
        title: "Ready to connect",
        description: "On the Tally PC: run PesoWiseSync.exe and paste this code (or use Connect this PC).",
      });
    } catch (e) {
      toast({
        title: "Could not create pairing code",
        description: e instanceof Error ? e.message : "Try again",
        variant: "destructive",
      });
    } finally {
      setPairingBusy(false);
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `${label} copied` });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  const saveCompany = async () => {
    if (!organizationId || !company.trim()) return;
    setCompanySaving(true);
    try {
      await saveTallyCompanyName(organizationId, company);
      toast({ title: "Tally company saved" });
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : "Try again",
        variant: "destructive",
      });
    } finally {
      setCompanySaving(false);
    }
  };

  const revoke = async (id: string) => {
    setRevokingId(id);
    try {
      await revokeTallyConnectorDevice(id);
      toast({ title: "Connector revoked" });
      await refresh();
    } catch (e) {
      toast({
        title: "Revoke failed",
        description: e instanceof Error ? e.message : "Try again",
        variant: "destructive",
      });
    } finally {
      setRevokingId(null);
    }
  };

  const quarantinePendingJob = async (jobId: string, batches: TallyPendingBatch[]) => {
    if (!organizationId || batches.length === 0) return;
    const message = `Quarantine ${batches.length} pending Tally batch(es) for job ${jobId}? This preserves their history and marks them skipped so they cannot be delivered.`;
    if (!window.confirm(message)) return;
    setQuarantiningJobId(jobId);
    try {
      await quarantineTallyPendingBatches(
        organizationId,
        batches.map((batch) => batch.id),
        `Admin quarantined pending batches for job ${jobId}; delivery is not authorized.`,
      );
      setLookedUpPendingBatches((current) => current.filter((batch) => batch.job_id !== jobId));
      toast({ title: "Pending batches quarantined", description: `${batches.length} batch(es) for job ${jobId} were marked skipped.` });
      await refresh();
    } catch (error) {
      toast({ title: "Could not quarantine pending batches", description: error instanceof Error ? error.message : "Try again", variant: "destructive" });
    } finally {
      setQuarantiningJobId(null);
    }
  };

  const cancelPendingJob = async (jobId: string, batches: TallyPendingBatch[]) => {
    if (!organizationId || batches.length === 0) return;
    const records = batches.reduce((sum, batch) => sum + batch.message_count, 0);
    const message = `Cancel only job ${jobId} and mark its ${batches.length} pending batch(es) (${records} records) skipped? Imported or review batches are never modified.`;
    if (!window.confirm(message)) return;
    setCancellingJobId(jobId);
    try {
      const result = await cancelUntouchedTallySyncJob(
        organizationId,
        jobId,
        `Admin cancelled untouched sync job ${jobId} to start a fresh test.`,
      );
      setLookedUpPendingBatches((current) => current.filter((batch) => batch.job_id !== jobId));
      toast({ title: "Sync job cancelled", description: `${result.skippedBatches} batch(es) containing ${result.skippedRecords.toLocaleString()} records were skipped. History is preserved.` });
      await refresh();
    } catch (error) {
      toast({ title: "Could not cancel sync job", description: error instanceof Error ? error.message : "Try again", variant: "destructive" });
      await refresh();
    } finally {
      setCancellingJobId(null);
    }
  };

  const cancelAllUntouchedPendingJobs = async () => {
    if (!organizationId) return;
    setCancellingJobId("all");
    try {
      // Re-read the org-scoped queue immediately before acting. The server RPC
      // independently locks and validates each exact job before cancelling it.
      const current = await fetchTallyPendingBatches(organizationId);
      const jobsById = new Map<string, TallyPendingBatch[]>();
      for (const batch of current) {
        const group = jobsById.get(batch.job_id) ?? [];
        group.push(batch);
        jobsById.set(batch.job_id, group);
      }
      if (jobsById.size === 0) {
        setPendingBatches([]);
        setLookedUpPendingBatches([]);
        toast({ title: "No pending batches", description: "This organization has no pending Tally delivery batches." });
        return;
      }
      const recordCount = current.reduce((sum, batch) => sum + batch.message_count, 0);
      const confirmed = window.confirm(
        `Cancel pending delivery in ${jobsById.size} untouched job(s), covering ${current.length} batches and ${recordCount.toLocaleString()} rows? Each job is checked by the server. Jobs with claimed, delivered, failed, or review-held batches are protected. Audit history is retained.`,
      );
      if (!confirmed) return;

      let cancelledJobs = 0;
      let cancelledBatches = 0;
      let cancelledRecords = 0;
      let notCancelledJobs = 0;
      for (const [jobId] of jobsById) {
        try {
          const result = await cancelUntouchedTallySyncJob(
            organizationId,
            jobId,
            `Organization admin cancelled untouched pending job ${jobId} for a fresh sync.`,
          );
          cancelledJobs += 1;
          cancelledBatches += result.skippedBatches;
          cancelledRecords += result.skippedRecords;
        } catch {
          // Continue; the server refused the job or the request failed. Never
          // force a state change outside the organization-admin RPC.
          notCancelledJobs += 1;
        }
      }
      setLookedUpPendingBatches([]);
      toast({
        title: `${cancelledJobs} pending job(s) cancelled`,
        description: `${cancelledBatches} batches / ${cancelledRecords.toLocaleString()} rows stopped. ${notCancelledJobs} job(s) were not cancelled and remain unchanged. Audit history is retained.`,
      });
      await refresh();
    } catch (error) {
      toast({ title: "Could not cancel pending jobs", description: error instanceof Error ? error.message : "Try again", variant: "destructive" });
      await refresh();
    } finally {
      setCancellingJobId(null);
    }
  };

  const lookupPendingJob = async () => {
    if (!organizationId || !pendingJobLookup.trim()) return;
    setPendingLookupBusy(true);
    try {
      const batches = await fetchTallyPendingBatches(organizationId, pendingJobLookup.trim());
      setLookedUpPendingBatches(batches);
      if (batches.length === 0) {
        toast({ title: "No pending batches found", description: `Job ${pendingJobLookup.trim()} has no pending batches in this organization.` });
      }
    } catch (error) {
      toast({ title: "Could not look up pending job", description: error instanceof Error ? error.message : "Try again", variant: "destructive" });
    } finally {
      setPendingLookupBusy(false);
    }
  };

  const quarantineAllPendingJobs = async () => {
    if (!organizationId) return;
    setQuarantiningJobId("all");
    try {
      // Re-read the complete organization-scoped queue immediately before acting.
      const current = await fetchTallyPendingBatches(organizationId);
      if (current.length === 0) {
        setPendingBatches([]);
        setLookedUpPendingBatches([]);
        toast({ title: "No pending batches", description: "This organization has no pending Tally delivery batches." });
        return;
      }
      const recordCount = current.reduce((sum, batch) => sum + batch.message_count, 0);
      const confirmed = window.confirm(
        `Quarantine all ${current.length} currently pending Tally batch(es) (${recordCount} records) in this organization? They will be marked skipped and cannot be delivered; audit history is preserved.`,
      );
      if (!confirmed) return;
      await quarantineTallyPendingBatches(
        organizationId,
        current.map((batch) => batch.id),
        `Admin quarantined all pending batches for a fresh PesoWise sync; delivery is not authorized.`,
      );
      setPendingBatches([]);
      setLookedUpPendingBatches([]);
      toast({ title: "Pending batches quarantined", description: `${current.length} batch(es) containing ${recordCount} records were marked skipped. Their history is retained.` });
      await refresh();
    } catch (error) {
      toast({ title: "Could not quarantine all pending batches", description: error instanceof Error ? error.message : "Try again", variant: "destructive" });
      await refresh();
    } finally {
      setQuarantiningJobId(null);
    }
  };

  if (userRole !== "admin") {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Admin access required for Tally integration setup.
      </div>
    );
  }

  const anyOnline = devices.some(
    (d) => !d.revoked_at && d.is_enabled && isConnectorDeviceOnline(d.last_seen_at),
  );
  const pendingByJob = Object.values([...pendingBatches, ...lookedUpPendingBatches].reduce<Record<string, TallyPendingBatch[]>>((groups, batch) => {
    if (groups[batch.job_id]?.some((existing) => existing.id === batch.id)) return groups;
    (groups[batch.job_id] ??= []).push(batch);
    return groups;
  }, {}));

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tally integration</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Each new report sync verifies the paired organization, active Tally company, and metadata setup before delivery. Historical jobs are never replayed automatically.
        </p>
      </div>

      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Plug className="h-5 w-5" />
            Connect a Tally PC (one time)
          </CardTitle>
          <CardDescription>Do this on the computer where TallyPrime is installed.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            {localCompanyVerified
              ? "This PC's local connector confirms the paired organization, active company, and metadata readiness. Connector downloads remain quarantined until all four reports pass live verification."
              : "The local connector has not verified this organization, active Tally company, and metadata setup together. A new report sync will stay blocked until local preflight passes. Connector downloads remain quarantined. Existing prepared jobs will not be imported automatically."}
          </div>

          <div className="space-y-2">
            <Label htmlFor="tally-co">Tally company name</Label>
            <div className="flex flex-wrap gap-2">
              <Input id="tally-co" value={company} onChange={(e) => setCompany(e.target.value)} className="max-w-md" />
              <Button variant="secondary" disabled={companySaving} onClick={() => void saveCompany()}>
                {companySaving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
              </Button>
            </div>
          </div>

          <Button onClick={() => void prepareThisPc()} disabled>
            Prepare this PC (paused)
          </Button>

          {pairingCode && (
            <div className="rounded-md border bg-muted/40 p-4 space-y-3">
              <p className="text-sm font-medium">Pairing code (paste into PesoWiseSync window)</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-2xl font-mono font-bold tracking-[0.2em]">{pairingCode}</span>
                <Button variant="outline" size="sm" onClick={() => void copyText(pairingCode, "Code")}>
                  <Copy className="h-3.5 w-3.5 mr-1" /> Copy
                </Button>
              </div>
              <Button asChild variant="default" className="w-full sm:w-auto">
                <a href={pesoWiseTallyConnectUrl(pairingCode)}>Connect this PC automatically</a>
              </Button>
              <p className="text-xs text-muted-foreground">
                Use the button on the Tally PC after you have run PesoWiseSync.exe once. Otherwise paste the code in the browser page.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Server className="h-5 w-5" />
              Connector status
            </CardTitle>
          <CardDescription>Cloud heartbeat indicates reachability; local company verification is checked separately on this PC.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <Badge variant={anyOnline ? "default" : "secondary"}>
            {anyOnline
              ? localCompanyVerified
                ? "Connector online — active company and metadata verified"
                : "Connector online — waiting for local company verification"
              : localCompanyVerified
                ? "Local connector online — cloud heartbeat was stale"
                : "Waiting for connector on Tally PC"}
          </Badge>
          {devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">Complete setup above first.</p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {devices.map((d) => {
                const active = !d.revoked_at && d.is_enabled;
                const online = active && isConnectorDeviceOnline(d.last_seen_at);
                return (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <div>
                      <span className="font-medium">{d.device_name}</span>
                      <div className="text-xs text-muted-foreground">
                        Last seen {formatRelative(d.last_seen_at)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Badge variant={online ? "default" : "outline"}>{online ? "Cloud online" : "Cloud heartbeat offline"}</Badge>
                        {localCompanyVerified && active && (
                          <Badge variant="default">This PC connected</Badge>
                        )}
                      {active && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          disabled={revokingId === d.id}
                          onClick={() => void revoke(d.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Pending delivery batches</CardTitle>
          <CardDescription>Cancel untouched queued jobs here. Jobs with activity or an uncertain Tally response remain protected, and audit history is retained.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap gap-2">
            <Input
              value={pendingJobLookup}
              onChange={(event) => setPendingJobLookup(event.target.value)}
              placeholder="Look up pending batches by exact job ID"
              aria-label="Look up pending batches by exact job ID"
            />
            <Button variant="outline" onClick={() => void lookupPendingJob()} disabled={pendingLookupBusy || !pendingJobLookup.trim()}>
              {pendingLookupBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Find job
            </Button>
            <Button
              variant="destructive"
              onClick={() => void quarantineAllPendingJobs()}
              disabled={quarantiningJobId !== null || pendingBatches.length + lookedUpPendingBatches.length === 0}
            >
              {quarantiningJobId === "all" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Quarantine all pending batches
            </Button>
            <Button
              variant="destructive"
              onClick={() => void cancelAllUntouchedPendingJobs()}
              disabled={cancellingJobId !== null || pendingBatches.length + lookedUpPendingBatches.length === 0}
            >
              {cancellingJobId === "all" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Cancel all untouched pending jobs
            </Button>
          </div>
          {pendingByJob.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending delivery batches.</p>
          ) : (
            <ul className="space-y-3">
              {pendingByJob.map((batches) => {
                const jobId = batches[0].job_id;
                return (
                  <li key={jobId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                    <div className="text-sm">
                      <div>Job <code>{jobId}</code></div>
                      <div className="text-xs text-muted-foreground">
                        {batches.length} pending batch(es) · {batches.reduce((sum, batch) => sum + batch.message_count, 0)} records · indexes {batches.map((batch) => batch.batch_index + 1).join(", ")}
                      </div>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={quarantiningJobId !== null}
                      onClick={() => void quarantinePendingJob(jobId, batches)}
                    >
                      {quarantiningJobId === jobId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Quarantine pending batches
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={quarantiningJobId !== null || cancellingJobId !== null}
                      onClick={() => void cancelPendingJob(jobId, batches)}
                    >
                      {cancellingJobId === jobId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Cancel untouched job
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent sync jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sync jobs yet.</p>
          ) : (
            <ul className="text-sm divide-y border rounded-md">
              {jobs.map((j) => (
                <li key={j.id} className="px-3 py-2 flex flex-wrap justify-between gap-2">
                  <span className="font-mono text-xs">{j.report_type}</span>
                  <Badge variant="outline">{j.status}</Badge>
                  <span className="text-xs text-muted-foreground w-full">{new Date(j.created_at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
