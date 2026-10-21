import { describe, expect, it } from "vitest";
import { buildJobPlan, DEFAULT_PWT_CONFIG } from "../../../../supabase/functions/_shared/pwt/index.ts";
import { processBatch, TallyOfflineError, type ClaimedBatch, type TallyIO } from "../engine.ts";

const COMPANY = "PesoWise Integration Demo";

/** A tiny in-memory TallyPrime: understands exactly the requests the connector sends. */
class FakeTally implements TallyIO {
  active = COMPANY;
  offline = false;
  ledgers = new Set<string>();
  groups = new Set<string>(["Sundry Debtors", "Indirect Expenses", "Suspense A/c"]);
  vouchers: { number: string; date: string; amounts: number[]; narration: string }[] = [];
  imports: string[] = [];
  breakReadback = false;

  async post(xml: string): Promise<string> {
    if (this.offline) throw new TallyOfflineError();
    if (xml.includes("<ID>PWTCur</ID>")) return `<ENVELOPE><COMPANY NAME="x"><PWTCURCO TYPE="String">${this.active}</PWTCURCO></COMPANY></ENVELOPE>`;
    if (xml.includes("<ID>PWTLedgerNames</ID>")) {
      const set = xml.includes("<TYPE>Group</TYPE>") ? this.groups : this.ledgers;
      const tag = xml.includes("<TYPE>Group</TYPE>") ? "GROUP" : "LEDGER";
      return `<ENVELOPE>${[...set].map((n) => `<${tag} NAME="${n.replace(/&/g, "&amp;")}"><NAME>${n.replace(/&/g, "&amp;")}</NAME></${tag}>`).join("")}</ENVELOPE>`;
    }
    if (xml.includes("<ID>PWTVouchers</ID>")) {
      if (this.breakReadback) return "<ENVELOPE></ENVELOPE>";
      return `<ENVELOPE>${this.vouchers.map((v) =>
        `<VOUCHER><DATE TYPE="Date">${v.date.replace(/-/g, "")}</DATE><VOUCHERNUMBER>${v.number}</VOUCHERNUMBER><NARRATION TYPE="String">${v.narration}</NARRATION>` +
        v.amounts.map((a) => `<ALLLEDGERENTRIES.LIST><AMOUNT TYPE="Amount">${a}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join("") + `</VOUCHER>`).join("")}</ENVELOPE>`;
    }
    this.imports.push(xml);
    if (xml.includes("<REPORTNAME>All Masters</REPORTNAME>")) {
      let created = 0;
      for (const m of xml.matchAll(/<LEDGER NAME="([^"]*)" ACTION="Delete"/g)) {
        if (this.ledgers.delete(m[1])) created++;
      }
      if (xml.includes('ACTION="Delete"')) return `<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><DELETED>${created}</DELETED><ERRORS>0</ERRORS></RESPONSE>`;
      for (const m of xml.matchAll(/<(LEDGER|GROUP) NAME="([^"]*)" ACTION="Create"/g)) {
        const name = m[2].replace(/&amp;/g, "&");
        const set = m[1] === "GROUP" ? this.groups : this.ledgers;
        if (set.has(name)) return `<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS><LINEERROR>${name} already exists</LINEERROR></RESPONSE>`;
        set.add(name);
        created++;
      }
      return `<RESPONSE><CREATED>${created}</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS></RESPONSE>`;
    }
    let created = 0;
    for (const m of xml.matchAll(/<TALLYMESSAGE[\s\S]*?<\/TALLYMESSAGE>/g)) {
      // Like real TallyPrime: Journal vouchers are auto-numbered; the PesoWise voucher id survives only in the narration.
      const num = String(this.vouchers.length + 1);
      const narration = /<NARRATION>(.*?)<\/NARRATION>/.exec(m[0])![1];
      const date = /<DATE>(\d{8})<\/DATE>/.exec(m[0])![1];
      const names = [...m[0].matchAll(/<LEDGERNAME>(.*?)<\/LEDGERNAME>/g)].map((x) => x[1].replace(/&amp;/g, "&"));
      const unknown = names.find((n) => !this.ledgers.has(n));
      if (unknown) return `<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS><LINEERROR>Ledger '${unknown}' does not exist</LINEERROR></RESPONSE>`;
      this.vouchers.push({
        number: num, narration, date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
        amounts: [...m[0].matchAll(/<AMOUNT>(.*?)<\/AMOUNT>/g)].map((x) => Number(x[1])),
      });
      created++;
    }
    return `<RESPONSE><CREATED>${created}</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS></RESPONSE>`;
  }
}

async function plan(reportRows = true) {
  const rows = [
    { event_id: "1", expense_id: "a", event_type: "expense_deduction", employee_code: "1001", employee_name: "Test Person", category: "Travelling (Public and Private Transport)", debit: 140, effective_date: "2026-08-05" },
    { event_id: "2", expense_id: "b", event_type: "expense_deduction", employee_code: "1002", employee_name: "Other Person", category: "Travelling (Public and Private Transport)", debit: 60.5, effective_date: "2026-08-06" },
  ];
  const p = await buildJobPlan({
    organizationId: "o", jobId: "j", report: "detailed_expense", company: COMPANY, rows,
    cfg: { ...DEFAULT_PWT_CONFIG, reportRowsInTally: reportRows }, state: { postedSourceIds: new Set(), voucherCounts: {} }, revision: 1,
  });
  return p.batches.map((b) => ({ batch_id: `b${b.seq}`, kind: b.kind, xml: b.xml, tally_company: COMPANY, expected: b.expected }) as ClaimedBatch);
}

async function deliverAll(t: FakeTally, batches: ClaimedBatch[]) {
  const out = [];
  for (const b of batches) out.push(await processBatch(b, t));
  return out;
}

describe("connector engine against a fake TallyPrime", () => {
  it("delivers masters -> (prune-only report batch) -> vouchers, each verified by readback; Detailed Expense stores no report rows", async () => {
    const t = new FakeTally();
    const out = await deliverAll(t, await plan());
    expect(out.map((o) => o.verified)).toEqual([true, true, true]);
    expect(t.vouchers).toHaveLength(1);
    expect(t.vouchers[0].narration).toBe("PWT PESO/08/01"); // Tally auto-numbers; the stable id lives in the narration
    expect(t.vouchers[0].amounts.reduce((s, x) => s + x, 0)).toBeCloseTo(0, 2); // balanced
    expect(t.groups.has("PesoWise Report Data")).toBe(false);   // the Detailed Expense screen reads the real vouchers instead
  });

  it("is safe to redeliver: nothing is created twice (duplicate prevention at the Tally edge)", async () => {
    const t = new FakeTally();
    const batches = await plan();
    await deliverAll(t, batches);
    const again = await deliverAll(t, batches);
    expect(again.every((o) => o.verified)).toBe(true);
    expect(t.vouchers).toHaveLength(1);
    expect(t.imports.length).toBe(2); // masters + vouchers on the first run (the report batch only prunes), none on replay
  });

  it("recovers a crash after import but before ack (vouchers present, not re-imported)", async () => {
    const t = new FakeTally();
    const batches = await plan();
    await processBatch(batches[0], t);
    await processBatch(batches[1], t);
    await processBatch(batches[2], t); // imported, ack lost
    const n = t.imports.length;
    const r = await processBatch(batches[2], t);
    expect(r.verified).toBe(true);
    expect(t.imports.length).toBe(n);
  });

  it("wrong-company protection: refuses when another company is active and writes nothing", async () => {
    const t = new FakeTally();
    t.active = "Some Real Company";
    const r = await processBatch((await plan())[0], t);
    expect(r.verified).toBe(false);
    expect((r as { error: string }).error).toMatch(/Some Real Company/);
    expect(t.imports).toHaveLength(0);
  });

  it("Tally offline -> non-permanent, flagged offline (retry later, attempt refunded)", async () => {
    const t = new FakeTally();
    t.offline = true;
    const r = await processBatch((await plan())[0], t);
    expect(r).toMatchObject({ verified: false, permanent: false, offline: true });
  });

  it("missing ledger -> vouchers rejected permanently with Tally's message (never marked done)", async () => {
    const t = new FakeTally();
    const [, , v] = await plan(); // skip masters on purpose
    const r = await processBatch(v, t);
    expect(r).toMatchObject({ verified: false, permanent: true });
    expect((r as { error: string }).error).toMatch(/does not exist/);
  });

  it("existing voucher with different amounts is a permanent conflict, not an overwrite", async () => {
    const t = new FakeTally();
    const batches = await plan();
    await processBatch(batches[0], t);
    t.vouchers.push({ number: "9", narration: "PWT PESO/08/01", date: "2026-08-31", amounts: [-1, 1] });
    const r = await processBatch(batches[2], t);
    expect(r).toMatchObject({ verified: false, permanent: true });
  });

  it("does not trust a clean import response when readback cannot see the vouchers", async () => {
    const t = new FakeTally();
    const batches = await plan();
    await processBatch(batches[0], t);
    t.breakReadback = true;
    const r = await processBatch(batches[2], t);
    expect(r.verified).toBe(false);
    expect((r as { error: string }).error).toMatch(/Readback failed/);
  });
});

import { supersededRevisions } from "../engine.ts";
import { mastersEnvelope, reportGroupMasterXml, reportRowMasterXml } from "../../../../supabase/functions/_shared/pwt/index.ts";

describe("report row revisions", () => {
  const rowBatch = (name: string): ClaimedBatch => ({
    batch_id: "r", kind: "report_rows", tally_company: COMPANY, expected: { ledgers: [name] },
    xml: mastersEnvelope(COMPANY, reportRowMasterXml({ report: "claim_approval", key: "k", revision: 1, jobId: "j", name, flat: "a|b" })),
  });

  it("finds only older revisions of the same record", () => {
    const existing = new Set(["PWT-CA-aaaaaaaaaaaaaaaa-11111111", "PWT-CA-bbbbbbbbbbbbbbbb-22222222", "Travelling Expenses"]);
    expect(supersededRevisions(existing, ["PWT-CA-aaaaaaaaaaaaaaaa-33333333"])).toEqual(["PWT-CA-aaaaaaaaaaaaaaaa-11111111"]);
    expect(supersededRevisions(existing, ["PWT-CA-aaaaaaaaaaaaaaaa-11111111"])).toEqual([]);
  });

  it("a changed row replaces the previous revision: one row per record in Tally", async () => {
    const t = new FakeTally();
    t.groups.add("PesoWise Report Data");
    const v1 = "PWT-CA-aaaaaaaaaaaaaaaa-11111111";
    const v2 = "PWT-CA-aaaaaaaaaaaaaaaa-22222222";
    expect((await processBatch(rowBatch(v1), t)).verified).toBe(true);
    const r = await processBatch(rowBatch(v2), t);
    expect(r.verified).toBe(true);
    expect([...t.ledgers]).toEqual([v2]);
    void reportGroupMasterXml;
  });
});

describe("report rows OFF (the default)", () => {
  it("writes only vouchers, creates no report ledgers, and removes leftovers of that report from earlier syncs", async () => {
    const t = new FakeTally();
    t.groups.add("PesoWise Report Data");
    t.ledgers.add("PWT-DE-aaaaaaaaaaaaaaaa-11111111");        // left by an earlier sync of the same report
    t.ledgers.add("PWT-CA-bbbbbbbbbbbbbbbb-22222222");        // another report: untouched
    t.ledgers.add("Travelling Expenses");                      // a real ledger: untouched
    const batches = await plan(false);
    expect(batches.map((b) => b.kind)).toEqual(["masters", "report_rows", "vouchers"]);
    const out = await deliverAll(t, batches);
    expect(out.every((o) => o.verified)).toBe(true);
    expect(t.vouchers).toHaveLength(1);              // both employees share the one month/category voucher
    expect([...t.ledgers].some((n) => n.startsWith("PWT-DE-"))).toBe(false);
    expect(t.ledgers.has("PWT-CA-bbbbbbbbbbbbbbbb-22222222")).toBe(true);
    expect(t.ledgers.has("Travelling Expenses")).toBe(true);
  });
});

describe("duplicate vouchers in Tally", () => {
  it("refuses to proceed (permanent, needs review) when a planned voucher already exists twice", async () => {
    const t = new FakeTally();
    const batches = await plan();
    await processBatch(batches[0], t);
    await processBatch(batches[2], t);
    t.vouchers.push({ ...t.vouchers[0], number: "99" });
    const r = await processBatch(batches[2], t);
    expect(r).toMatchObject({ verified: false, permanent: true });
    expect((r as { error: string }).error).toMatch(/more than once/);
  });
});
