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
import { fetchExpenseCategoryNames } from "@/lib/fetchExpenseCategoryNames";
import {
  createPairingCode, DEFAULT_PWT_CATEGORIES, describePwtJob, PWT_LEDGER_CHOICES, withNaRow, autoMapRules, getPwtConfig, listPwtConnectors, listPwtJobs, PWT_STATUS_LABEL,
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
/** Drop-down of Tally ledgers; "New ledger…" lets the accountant type a name that is not in the list. */
function LedgerSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [custom, setCustom] = useState(false);
  const known = PWT_LEDGER_CHOICES.includes(value);
  if (custom || (value && !known)) {
    return (
      <div className="flex gap-1">
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Ledger name" aria-label="Tally ledger" autoFocus={custom} />
        <Button size="sm" variant="ghost" type="button" onClick={() => { setCustom(false); onChange(PWT_LEDGER_CHOICES[0]); }}>List</Button>
      </div>
    );
  }
  return (
    <select
      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
      value={value}
      aria-label="Tally ledger"
      onChange={(e) => (e.target.value === "__new" ? (setCustom(true), onChange("")) : onChange(e.target.value))}
    >
      <option value="" disabled>Choose ledger</option>
      {PWT_LEDGER_CHOICES.map((l) => <option key={l} value={l}>{l}</option>)}
      <option value="__new">New ledger…</option>
    </select>
  );
}

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
  const [savedRules, setSavedRules] = useState<PwtCategoryRule[]>([]);
  const [prefix, setPrefix] = useState("PESO");
  const [mapMsg, setMapMsg] = useState<string | null>(null);
  const [reportRows, setReportRows] = useState(false);
  const [datePolicy, setDatePolicy] = useState<"month_end" | "month_start">("month_end");

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
        setRules(withNaRow(c.categories));
        setSavedRules(c.categories);
        if (c.voucherPrefix) setPrefix(c.voucherPrefix);
      }
      setReportRows(c?.reportRowsInTally === true);
      setDatePolicy(c?.postingDatePolicy === "month_start" ? "month_start" : "month_end");
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


  const [autoNote, setAutoNote] = useState("");
  const saveMapping = async () => {
    if (!organizationId) return;
    setMapMsg(null);
    try {
      await savePwtConfig(organizationId, { categories: rules, voucherPrefix: prefix, reportRowsInTally: reportRows, postingDatePolicy: datePolicy });
      setSavedRules(rules);
      setMapMsg("Saved.");
    } catch (e) {
      setMapMsg(e instanceof Error ? e.message : "Could not save");
    }
  };
  const autoMap = async () => {
    if (!organizationId) return;
    try {
      const names = [...(await fetchExpenseCategoryNames(organizationId)), ...unmapped];
      const r = autoMapRules(rules, names);
      setRules(r.rules);
      setAutoNote(r.added + r.filled === 0 ? "Everything is already mapped." : `Added ${r.added} and completed ${r.filled}. Check the ledgers, then press Save.`);
    } catch {
      setAutoNote("Could not load the expense types.");
    }
  };
  const nextSerial = () => Math.min(98, Math.max(0, ...rules.filter((r) => r.serial < 99).map((r) => r.serial)) + 1);
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
          <li>Add <code className="text-xs">PesoWise-Tally.tdl</code> in Tally.</li>
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
          <Card><CardContent className="space-y-4 p-4">
            <p className="text-sm text-muted-foreground">Choose the Tally ledger each expense type is booked to. Not sure? Press <b>Auto map</b>.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void autoMap()} data-testid="pwt-auto-map">Auto map</Button>
              <Button size="sm" variant="outline" onClick={() => setRules((rs) => [...rs, { expenseType: "", expenseLedger: "", serial: nextSerial() }])}>Add row</Button>
              <Button size="sm" variant="ghost" onClick={() => { setRules(DEFAULT_PWT_CATEGORIES); setPrefix("PESO"); }}>Reset</Button>
              <Button size="sm" className="ml-auto" onClick={() => void saveMapping()} disabled={!!mappingError}>Save</Button>
            </div>
            <label className="flex flex-wrap items-center gap-2 text-sm">
              Voucher date
              <select
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={datePolicy}
                onChange={(e) => setDatePolicy(e.target.value as "month_end" | "month_start")}
                aria-label="Voucher date"
                data-testid="pwt-date-policy"
              >
                <option value="month_end">Last day of the month</option>
                <option value="month_start">First day of the month</option>
              </select>
              <span className="text-xs text-muted-foreground">Choose the first day if Tally refuses the last day.</span>
            </label>
            {autoNote && <p className="text-xs text-muted-foreground" data-testid="pwt-auto-note">{autoNote}</p>}
            {mappingError && <p className="text-xs text-destructive">{mappingError}</p>}
            {mapMsg && <p className="text-xs">{mapMsg}</p>}
            {unmapped.length > 0 && (
              <p className="flex flex-wrap items-center gap-2 text-sm">
                Not mapped yet:
                {unmapped.map((t) => (
                  <Button key={t} size="sm" variant="outline" onClick={() => setRules((rs) => [...rs, { expenseType: t, expenseLedger: "", serial: nextSerial() }])}>+ {t}</Button>
                ))}
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="text-xs text-muted-foreground"><th className="p-1 font-medium">Expense type</th><th className="p-1 font-medium">Goes to Tally ledger</th><th className="p-1 font-medium">Voucher no.</th><th /></tr></thead>
                <tbody>
                  {rules.map((r, i) => (
                    <tr key={i}>
                      <td className="p-1"><Input value={r.expenseType} onChange={(e) => update(i, { expenseType: e.target.value })} aria-label="Expense type" /></td>
                      <td className="p-1"><LedgerSelect value={r.expenseLedger} onChange={(v) => update(i, { expenseLedger: v })} /></td>
                      <td className="w-24 p-1"><Input type="number" min={1} max={99} value={r.serial} onChange={(e) => update(i, { serial: Number(e.target.value) })} aria-label="Voucher number" title={`Last part of the Voucher ID, e.g. ${prefix || "PESO"}/07/${String(r.serial).padStart(2, "0")}`} /></td>
                      <td className="p-1"><Button size="sm" variant="ghost" onClick={() => setRules((rs) => rs.filter((_, k) => k !== i))}>Remove</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
