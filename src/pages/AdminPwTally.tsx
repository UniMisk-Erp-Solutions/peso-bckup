import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import {
  createPairingCode, DEFAULT_PWT_CATEGORIES, describePwtJob, getPwtConfig, listPwtConnectors, listPwtJobs, PWT_STATUS_LABEL,
  revokePwtConnector, savePwtConfig, unmappedTypesFromJobs, validatePwtConfig,
  type PwtCategoryRule, type PwtConnector, type PwtJob,
} from "@/lib/pwt/pwtSync";

const online = (c: PwtConnector) => !!c.last_seen_at && Date.now() - new Date(c.last_seen_at).getTime() < 60_000;

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <details className="rounded-md border border-border p-3" open={!done}>
      <summary className="cursor-pointer text-sm font-medium">
        <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs">{done ? "✓" : n}</span>
        {title}
        {done && <Badge variant="success" className="ml-2 text-[10px]">Done</Badge>}
      </summary>
      <div className="mt-2 space-y-2 text-sm text-muted-foreground">{children}</div>
    </details>
  );
}

/** Admin page: one-time Tally setup for this organisation, mapping settings, connector health and sync history. */
export default function AdminPwTally() {
  const { organizationId } = useAuth() as { organizationId?: string | null };
  const [company, setCompany] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<PwtConnector[]>([]);
  const [jobs, setJobs] = useState<PwtJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [rules, setRules] = useState<PwtCategoryRule[]>(DEFAULT_PWT_CATEGORIES);
  const [prefix, setPrefix] = useState("PESO");
  const [customised, setCustomised] = useState(false);
  const [mapMsg, setMapMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!organizationId) return;
    try {
      const [c, j] = await Promise.all([listPwtConnectors(organizationId), listPwtJobs(organizationId, 25)]);
      setConnectors(c);
      setJobs(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!organizationId) return;
    void getPwtConfig(organizationId).then((c) => {
      if (c?.categories?.length) {
        setRules(c.categories);
        setCustomised(true);
        if (c.voucherPrefix) setPrefix(c.voucherPrefix);
      }
    }).catch(() => undefined);
  }, [organizationId]);

  const active = connectors.find((c) => c.status === "active");
  const paired = !!active;
  const connected = !!active && online(active);
  const matching = connected && active!.last_active_company === active!.tally_company;
  const unmapped = useMemo(() => unmappedTypesFromJobs(jobs).filter((t) => !rules.some((r) => r.expenseType.trim().toLowerCase() === t.trim().toLowerCase())), [jobs, rules]);

  const generate = async () => {
    if (!organizationId) return;
    setBusy(true);
    setError(null);
    try {
      setCode(await createPairingCode(organizationId, company));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create code");
    } finally {
      setBusy(false);
    }
  };

  const saveMapping = async () => {
    if (!organizationId) return;
    setMapMsg(null);
    try {
      await savePwtConfig(organizationId, { categories: rules, voucherPrefix: prefix });
      setCustomised(true);
      setMapMsg("Saved. The next Sync to Tally uses this mapping.");
    } catch (e) {
      setMapMsg(e instanceof Error ? e.message : "Could not save");
    }
  };

  const nextSerial = () => Math.min(99, Math.max(0, ...rules.map((r) => r.serial)) + 1);
  const update = (i: number, patch: Partial<PwtCategoryRule>) => setRules((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>Tally integration</CardTitle>
          <CardDescription>
            Set up once. After that, open any report, click <b>Sync to Tally</b>, and the calculated report appears in TallyPrime.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Step n={1} title="Download the connector and the Tally report file" done={paired}>
            <p>On the PC where TallyPrime runs, download both files:</p>
            <p className="flex flex-wrap gap-3">
              <a className="text-primary underline" href="/downloads/PesoWise-Tally-Setup.exe" download>PesoWise-Tally-Setup.exe</a>
              <a className="text-primary underline" href="/downloads/PesoWise-Tally.tdl" download>PesoWise-Tally.tdl</a>
            </p>
          </Step>
          <Step n={2} title="Prepare TallyPrime (once)" done={connected}>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Open TallyPrime and open the company that should receive the data.</li>
              <li>Press <b>F1 (Help) → Settings → Connectivity → Client/Server configuration</b> and enable the local port (default 9000).</li>
              <li>Press <b>F1 → Settings → Product &amp; Features → Manage Local TDLs</b>, set "Load TDL files on startup" to Yes and add <code>PesoWise-Tally.tdl</code> (it is installed to <code>%LOCALAPPDATA%\Programs\PesoWiseTally</code>).</li>
              <li>Restart TallyPrime and reopen the company. <b>Gateway of Tally → PesoWise Reports</b> now exists.</li>
            </ol>
          </Step>
          <Step n={3} title="Pair this PC with PesoWise" done={connected}>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[16rem] flex-1 space-y-1">
                <label className="text-xs" htmlFor="pwt-company">Exact name of the TallyPrime company (as shown in Tally)</label>
                <Input id="pwt-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Your Company Pvt Ltd" />
              </div>
              <Button onClick={() => void generate()} disabled={busy || !company.trim()}>Generate pairing code</Button>
            </div>
            {code && (
              <div className="rounded-md border border-border p-3 text-foreground">
                <p>Pairing code (valid 15 minutes, shown once). Run the installer and type it when asked:</p>
                <p className="font-mono text-lg tracking-widest" data-testid="pwt-code">{code}</p>
              </div>
            )}
            {error && <p className="text-destructive">{error}</p>}
            <ul className="space-y-1">
              {connectors.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2 text-foreground">
                  <Badge variant={c.status === "revoked" ? "outline" : online(c) ? "success" : "secondary"}>
                    {c.status === "revoked" ? "Revoked" : online(c) ? "Online" : "Offline"}
                  </Badge>
                  <span>{c.device_name || "PC"} → “{c.tally_company}”</span>
                  {c.status === "active" && c.last_active_company && c.last_active_company !== c.tally_company && (
                    <span className="text-destructive">Tally is on “{c.last_active_company}”. Open “{c.tally_company}”; nothing is written to other companies.</span>
                  )}
                  {c.last_error === "tally_offline" && <span className="text-muted-foreground">TallyPrime is not running or its port is off.</span>}
                  {c.status === "active" && organizationId && (
                    <Button size="sm" variant="ghost" onClick={() => void revokePwtConnector(organizationId, c.id).then(load)}>Revoke</Button>
                  )}
                </li>
              ))}
              {!connectors.length && <li>No connector paired yet.</li>}
            </ul>
          </Step>
          <Step n={4} title="Check the ledger mapping" done={customised}>
            <p>
              Each PesoWise expense type is posted to a Tally expense ledger. {customised ? "Your organisation's mapping is saved." : "Defaults are shown; save to make them yours."}
              Ask your accountant to confirm the ledger names. Missing ledgers are created in Tally automatically.
            </p>
            {unmapped.length > 0 && (
              <div className="rounded-md border border-destructive/40 p-2 text-foreground">
                <p className="text-sm">These expense types from recent syncs have no mapping:</p>
                <p className="flex flex-wrap gap-2 pt-1">
                  {unmapped.map((t) => (
                    <Button key={t} size="sm" variant="outline"
                      onClick={() => setRules((rs) => [...rs, { expenseType: t, expenseLedger: "", serial: nextSerial() }])}>+ {t}</Button>
                  ))}
                </p>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-foreground">
                <thead>
                  <tr className="text-muted-foreground"><th className="p-1">PesoWise expense type</th><th className="p-1">Tally expense ledger</th><th className="p-1">Serial</th><th /></tr>
                </thead>
                <tbody>
                  {rules.map((r, i) => (
                    <tr key={i}>
                      <td className="p-1"><Input value={r.expenseType} onChange={(e) => update(i, { expenseType: e.target.value })} aria-label="Expense type" /></td>
                      <td className="p-1"><Input value={r.expenseLedger} onChange={(e) => update(i, { expenseLedger: e.target.value })} aria-label="Tally ledger" /></td>
                      <td className="w-20 p-1"><Input type="number" min={1} max={99} value={r.serial} onChange={(e) => update(i, { serial: Number(e.target.value) })} aria-label="Serial" /></td>
                      <td className="p-1"><Button size="sm" variant="ghost" onClick={() => setRules((rs) => rs.filter((_, k) => k !== i))}>Remove</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-end gap-2 text-foreground">
              <Button size="sm" variant="outline" onClick={() => setRules((rs) => [...rs, { expenseType: "", expenseLedger: "", serial: nextSerial() }])}>Add row</Button>
              <Button size="sm" variant="ghost" onClick={() => { setRules(DEFAULT_PWT_CATEGORIES); setPrefix("PESO"); }}>Reset to defaults</Button>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground" htmlFor="pwt-prefix">Voucher ID prefix</label>
                <Input id="pwt-prefix" className="w-28" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
              </div>
              <Button size="sm" onClick={() => void saveMapping()} disabled={!!validatePwtConfig({ categories: rules, voucherPrefix: prefix })}>Save mapping</Button>
            </div>
            {validatePwtConfig({ categories: rules, voucherPrefix: prefix }) && (
              <p className="text-xs text-destructive">{validatePwtConfig({ categories: rules, voucherPrefix: prefix })}</p>
            )}
            {mapMsg && <p className="text-xs text-foreground">{mapMsg}</p>}
            <p className="text-xs">The serial makes the Voucher ID: <code>{prefix || "PESO"}/&lt;month&gt;/&lt;serial&gt;</code>. Keep each category's serial and ledger stable once vouchers are posted.</p>
          </Step>
          <Step n={5} title="Sync" done={jobs.some((j) => j.status === "completed")}>
            <p>
              Open <Link to="/reports" className="text-primary underline">Reports</Link>, choose a report and filters, and click <b>Sync to Tally</b>.
              {matching ? " Everything is connected." : " Waiting for the connector to be online with the right Tally company open."} Then in Tally:
              <b> Gateway of Tally → PesoWise Reports</b>. Every later sync is just that one click; keep TallyPrime open on the paired company.
            </p>
          </Step>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sync history</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {jobs.map((j) => (
              <li key={j.id}>
                <span className="font-medium">{j.report_type.replace(/_/g, " ")}</span> · {PWT_STATUS_LABEL[j.status]} ·{" "}
                {new Date(j.created_at).toLocaleString()}
                <div className="text-xs text-muted-foreground">{describePwtJob(j)}</div>
              </li>
            ))}
            {!jobs.length && <li className="text-muted-foreground">No syncs yet.</li>}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
