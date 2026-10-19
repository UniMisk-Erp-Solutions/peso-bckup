import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PwtDeletionHistory } from "@/components/PwtDeletionHistory";
import { useAuth } from "@/contexts/AuthContext";
import {
  createPairingCode, DEFAULT_PWT_CATEGORIES, describePwtJob, getPwtConfig, listPwtConnectors, listPwtJobs, PWT_STATUS_LABEL,
  revokePwtConnector, savePwtConfig, unmappedTypesFromJobs, validatePwtConfig,
  type PwtCategoryRule, type PwtConnector, type PwtJob,
} from "@/lib/pwt/pwtSync";

const online = (c: PwtConnector) => !!c.last_seen_at && Date.now() - new Date(c.last_seen_at).getTime() < 60_000;
const CODE_MINUTES = 15;

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <Card data-testid={`pwt-step-${n}`}>
      <CardContent className="flex gap-4 p-5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${done ? "bg-emerald-600 text-white" : "bg-primary text-primary-foreground"}`}>
          {done ? <Check className="h-4 w-4" /> : n}
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <h2 className="font-semibold">{title}</h2>
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

/** Tally integration setup: download, connect, done. Mapping and history are tucked into tabs below. */
export default function AdminPwTally() {
  const { organizationId } = useAuth() as { organizationId?: string | null };
  const [company, setCompany] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [codeAt, setCodeAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [connectors, setConnectors] = useState<PwtConnector[]>([]);
  const [jobs, setJobs] = useState<PwtJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [rules, setRules] = useState<PwtCategoryRule[]>(DEFAULT_PWT_CATEGORIES);
  const [prefix, setPrefix] = useState("PESO");
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
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!organizationId) return;
    void getPwtConfig(organizationId).then((c) => {
      if (c?.categories?.length) {
        setRules(c.categories);
        if (c.voucherPrefix) setPrefix(c.voucherPrefix);
      }
    }).catch(() => undefined);
  }, [organizationId]);

  const active = connectors.find((c) => c.status === "active");
  const connected = !!active && online(active);
  const matching = connected && active!.last_active_company === active!.tally_company;
  const unmapped = useMemo(
    () => unmappedTypesFromJobs(jobs).filter((t) => !rules.some((r) => r.expenseType.trim().toLowerCase() === t.trim().toLowerCase())),
    [jobs, rules],
  );
  const mappingError = validatePwtConfig({ categories: rules, voucherPrefix: prefix });

  const codeLeft = codeAt ? Math.max(0, CODE_MINUTES * 60 - Math.floor((now - codeAt) / 1000)) : 0;
  const mmss = `${Math.floor(codeLeft / 60)}:${String(codeLeft % 60).padStart(2, "0")}`;

  const generate = async () => {
    if (!organizationId) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setCode(await createPairingCode(organizationId, company));
      setCodeAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create code");
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* the code is on screen */ }
  };

  const saveMapping = async () => {
    if (!organizationId) return;
    setMapMsg(null);
    try {
      await savePwtConfig(organizationId, { categories: rules, voucherPrefix: prefix });
      setMapMsg("Saved.");
    } catch (e) {
      setMapMsg(e instanceof Error ? e.message : "Could not save");
    }
  };

  const nextSerial = () => Math.min(99, Math.max(0, ...rules.map((r) => r.serial)) + 1);
  const update = (i: number, patch: Partial<PwtCategoryRule>) => setRules((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  const status = matching
    ? { dot: "bg-emerald-500", title: "Connected", text: `Tally company: ${active!.tally_company}` }
    : connected
      ? { dot: "bg-amber-500", title: "Wrong company open in Tally", text: `Open “${active!.tally_company}” in TallyPrime.` }
      : active
        ? { dot: "bg-amber-500", title: "Connector is offline", text: "Open TallyPrime and start the connector on that PC." }
        : { dot: "bg-muted-foreground/50", title: "Not connected yet", text: "Follow the steps below." };

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4">
      <h1 className="text-2xl font-semibold">Tally integration</h1>

      <Card data-testid="pwt-status">
        <CardContent className="flex items-center gap-3 p-4">
          <span className={`h-3 w-3 shrink-0 rounded-full ${status.dot}`} />
          <div className="flex-1">
            <p className="font-medium" data-testid="pwt-status-title">{status.title}</p>
            <p className="text-sm text-muted-foreground">{status.text}</p>
          </div>
          {matching && <Button asChild size="sm"><Link to="/admin/reports">Open Reports</Link></Button>}
        </CardContent>
      </Card>

      <Step n={1} title="Download" done={!!active}>
        <div className="flex flex-wrap gap-2">
          <Button asChild><a href="/downloads/PesoWise-Tally-Setup.exe" download data-testid="pwt-download-exe"><Download className="mr-2 h-4 w-4" />Connector (.exe)</a></Button>
          <Button asChild variant="outline"><a href="/downloads/PesoWise-Tally.tdl" download data-testid="pwt-download-tdl"><Download className="mr-2 h-4 w-4" />Tally file (.tdl)</a></Button>
        </div>
      </Step>

      <Step n={2} title="Connect" done={connected}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <label className="mb-1 block text-xs text-muted-foreground" htmlFor="pwt-company">Tally company name</label>
            <Input id="pwt-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Exactly as shown in TallyPrime" />
          </div>
          <Button onClick={() => void generate()} disabled={busy || !company.trim()}>Get code</Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {code && (
          <div className="rounded-lg border-2 border-dashed border-primary/50 bg-primary/5 p-4" data-testid="pwt-code-box">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-3xl font-bold tracking-[0.3em]" data-testid="pwt-code">{code}</span>
              <Button size="sm" variant="outline" onClick={() => void copyCode()}>
                {copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}{copied ? "Copied" : "Copy"}
              </Button>
              <span className={`text-sm ${codeLeft === 0 ? "text-destructive" : "text-muted-foreground"}`}>{codeLeft === 0 ? "Expired" : mmss}</span>
            </div>
            <p className="mt-2 text-sm">Run the downloaded .exe and enter this code.</p>
          </div>
        )}
        {connectors.some((c) => c.status === "active") && (
          <ul className="space-y-1 text-sm">
            {connectors.filter((c) => c.status === "active").map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <Badge variant={online(c) ? "success" : "secondary"}>{online(c) ? "Online" : "Offline"}</Badge>
                <span>{c.device_name || "PC"} → {c.tally_company}</span>
                {organizationId && (
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void revokePwtConnector(organizationId, c.id).then(load)}>Disconnect</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Step>

      <Step n={3} title="Set up TallyPrime (once)" done={matching}>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Open your company, then <b>F1 → Settings → Connectivity → Client/Server</b>: turn on the port (9000).</li>
          <li><b>F1 → Settings → Product &amp; Features → Manage Local TDLs</b>: add <code className="text-xs">%LOCALAPPDATA%\Programs\PesoWiseTally\PesoWise-Tally.tdl</code>, then restart Tally.</li>
        </ol>
      </Step>

      <Tabs defaultValue="history">
        <TabsList>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="deletions">Deleted expenses</TabsTrigger>
          <TabsTrigger value="mapping">Ledger mapping</TabsTrigger>
        </TabsList>

        <TabsContent value="history">
          <Card><CardContent className="p-4">
            <ul className="space-y-3 text-sm">
              {jobs.map((j) => (
                <li key={j.id}>
                  <span className="font-medium">{j.report_type.replace(/_/g, " ")}</span> · {PWT_STATUS_LABEL[j.status]} · {new Date(j.created_at).toLocaleString()}
                  <div className="text-xs text-muted-foreground">{describePwtJob(j)}</div>
                </li>
              ))}
              {!jobs.length && <li className="text-muted-foreground">No syncs yet.</li>}
            </ul>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="deletions">
          {organizationId && <PwtDeletionHistory organizationId={organizationId} />}
        </TabsContent>

        <TabsContent value="mapping">
          <Card><CardContent className="space-y-3 p-4">
            {unmapped.length > 0 && (
              <p className="flex flex-wrap items-center gap-2 text-sm">
                Not mapped:
                {unmapped.map((t) => (
                  <Button key={t} size="sm" variant="outline" onClick={() => setRules((rs) => [...rs, { expenseType: t, expenseLedger: "", serial: nextSerial() }])}>+ {t}</Button>
                ))}
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead><tr className="text-muted-foreground"><th className="p-1">Expense type</th><th className="p-1">Tally ledger</th><th className="p-1">No.</th><th /></tr></thead>
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
            <div className="flex flex-wrap items-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setRules((rs) => [...rs, { expenseType: "", expenseLedger: "", serial: nextSerial() }])}>Add row</Button>
              <Button size="sm" variant="ghost" onClick={() => { setRules(DEFAULT_PWT_CATEGORIES); setPrefix("PESO"); }}>Reset</Button>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground" htmlFor="pwt-prefix">Voucher prefix</label>
                <Input id="pwt-prefix" className="w-24" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
              </div>
              <Button size="sm" onClick={() => void saveMapping()} disabled={!!mappingError}>Save</Button>
            </div>
            {mappingError && <p className="text-xs text-destructive">{mappingError}</p>}
            {mapMsg && <p className="text-xs">{mapMsg}</p>}
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
