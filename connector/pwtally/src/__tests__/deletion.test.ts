import { describe, expect, it } from "vitest";
import { TallyOfflineError, type TallyIO } from "../engine.ts";
import {
  alterVoucherXml, applyDeletion, deleteVoucherXml, narrationOf, planCorrection, reversalLines, reversalNarration, reversalVoucherXml,
  runDeletionJob, sameLines, voucherByNarrationRequest, type DeletionJob,
} from "../deletion.ts";
import type { InboundVoucher } from "../inbound.ts";

const COMPANY = "Demo Co";
const A = "Amit Test-1001", B = "Bina Test-1002", X = "Consumable Stores - URD";

const job = (over: Partial<DeletionJob> = {}): DeletionJob => ({
  job_id: "11111111-aaaa", tally_company: COMPANY, voucher_number: "PESO/08/02", voucher_date: "2026-08-31", amount: 100, employee_ledger: A, expense_ledger: X,
  transaction_number: "TXN-7", known_total: 100, siblings: 0, force_reversal: false, voucher_type: "Journal", expense_side: "debit", narration_tag: "PWT", ...over,
});
const voucher = (entries: [string, number][], over: Partial<InboundVoucher> = {}): InboundVoucher => ({
  guid: "G1", number: "12", date: "2026-08-31", type: "Journal", narration: "PWT PESO/08/02", alter_id: 1, master_id: 1, cancelled: false, optional: false,
  entries: entries.map(([ledger, amount]) => ({ ledger, amount, parent: null })), ...over,
});

describe("planCorrection (pure decision)", () => {
  it("voucher absent in Tally -> nothing to do (already gone)", () => {
    expect(planCorrection(job(), []).kind).toBe("already_gone");
    expect(planCorrection(job(), [voucher([[X, -100], [A, 100]], { cancelled: true })]).kind).toBe("already_gone");
  });
  it("voucher holds only this expense -> delete", () => {
    expect(planCorrection(job(), [voucher([[X, -100], [A, 100]])]).kind).toBe("delete");
  });
  it("several expenses -> alter, removing only this amount from its two ledgers", () => {
    const p = planCorrection(job({ amount: 50, known_total: 350, siblings: 2 }), [voucher([[X, -350], [A, 150], [B, 200]])]);
    expect(p.kind).toBe("alter");
    if (p.kind === "alter") expect(p.lines).toEqual([{ ledger: X, amount: -300 }, { ledger: A, amount: 100 }, { ledger: B, amount: 200 }]);
  });
  it("an employee's last expense removes that employee's line", () => {
    const p = planCorrection(job({ amount: 100, known_total: 300, siblings: 1 }), [voucher([[X, -300], [A, 100], [B, 200]])]);
    expect(p.kind === "alter" && p.lines).toEqual([{ ledger: X, amount: -200 }, { ledger: B, amount: 200 }]);
  });
  it("a lost acknowledgement is recognised (already reduced) and not reduced twice", () => {
    expect(planCorrection(job({ amount: 50, known_total: 350, siblings: 2 }), [voucher([[X, -300], [A, 100], [B, 200]])]).kind).toBe("already_altered");
  });
  it("a voucher changed outside PesoWise is BLOCKED and never touched", () => {
    const p = planCorrection(job({ known_total: 100 }), [voucher([[X, -90], [A, 90]])]);
    expect(p.kind).toBe("blocked");
    expect(p.kind === "blocked" && p.reason).toMatch(/changed outside PesoWise/);
  });
  it("duplicates, wrong type, optional or unbalanced vouchers are BLOCKED", () => {
    expect(planCorrection(job(), [voucher([[X, -100], [A, 100]]), voucher([[X, -100], [A, 100]], { guid: "G2" })]).kind).toBe("blocked");
    expect(planCorrection(job(), [voucher([[X, -100], [A, 100]], { type: "Payment" })]).kind).toBe("blocked");
    expect(planCorrection(job(), [voucher([[X, -100], [A, 100]], { optional: true })]).kind).toBe("blocked");
    expect(planCorrection(job(), [voucher([[X, -100], [A, 90]])]).kind).toBe("blocked");
  });
  it("unknown ledgers (voucher posted before the feature): a lone-expense voucher is still deleted, anything else is blocked", () => {
    const legacy = { employee_ledger: null, expense_ledger: null, known_total: null };
    expect(planCorrection(job(legacy), [voucher([[X, -100], [A, 100]])]).kind).toBe("delete");
    expect(planCorrection(job({ ...legacy, siblings: 2 }), [voucher([[X, -300], [A, 100], [B, 200]])]).kind).toBe("blocked");
  });
  it("the debit/credit sides must be what PesoWise posted", () => {
    expect(planCorrection(job({ amount: 50, known_total: 350, siblings: 2 }), [voucher([[X, 350], [A, -150], [B, -200]])]).kind).toBe("blocked");
  });
  it("a voucher already corrected by a reversal is never deleted or altered again", () => {
    expect(planCorrection(job({ force_reversal: true }), [voucher([[X, -100], [A, 100]])]).kind).toBe("reverse");
  });
});

describe("XML is exact and scoped", () => {
  it("delete targets one voucher by its Tally number, date and type", () => {
    const x = deleteVoucherXml(COMPANY, voucher([[X, -100], [A, 100]]));
    expect(x).toContain('ACTION="Delete"');
    expect(x).toContain('TAGNAME="Voucher Number" TAGVALUE="12"');
    expect(x).toContain('DATE="20260831"');
    expect(x).toContain(`<SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>`);
  });
  it("alter keeps number, date and narration and carries signed lines", () => {
    const x = alterVoucherXml(COMPANY, voucher([[X, -350], [A, 150], [B, 200]]), [{ ledger: X, amount: -300 }, { ledger: A, amount: 100 }, { ledger: B, amount: 200 }]);
    expect(x).toContain('ACTION="Alter"');
    expect(x).toContain("<NARRATION>PWT PESO/08/02</NARRATION>");
    expect(x).toContain("<AMOUNT>-300.00</AMOUNT>");
    expect(x).toContain("<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>");
  });
  it("reversal mirrors the original sides and has its own idempotent reference", () => {
    expect(reversalLines(job())).toEqual([{ ledger: X, amount: 100 }, { ledger: A, amount: -100 }]);
    expect(reversalLines(job({ expense_side: "credit" }))).toEqual([{ ledger: X, amount: -100 }, { ledger: A, amount: 100 }]);
    expect(reversalNarration(job())).toBe("PWT REV PESO/08/02 TXN-7");
    expect(reversalVoucherXml(COMPANY, job())).toContain('ACTION="Create"');
  });
  it("the lookup is read-only, exact-narration and one day wide", () => {
    const x = voucherByNarrationRequest(COMPANY, narrationOf(job()), "2026-08-31");
    expect(x).toContain("<TALLYREQUEST>Export</TALLYREQUEST>");
    expect(x).toContain('$Narration = "PWT PESO/08/02"');
    expect(x).toContain("<SVFROMDATE>20260831</SVFROMDATE><SVTODATE>20260831</SVTODATE>");
    expect(x).not.toMatch(/Import Data/);
  });
  it("sameLines compares by ledger, ignoring order", () => {
    expect(sameLines(voucher([[A, 1], [X, -1]]), [{ ledger: X, amount: -1 }, { ledger: A, amount: 1 }])).toBe(true);
    expect(sameLines(voucher([[A, 1], [X, -1]]), [{ ledger: X, amount: -2 }, { ledger: A, amount: 2 }])).toBe(false);
  });
});

/** A tiny in-memory TallyPrime: vouchers by narration/date; honours the three import actions this feature uses. */
class FakeTally implements TallyIO {
  vouchers: InboundVoucher[] = [];
  active = COMPANY;
  offline = false;
  rejectDelete = false;
  rejectAlter = false;
  writes: string[] = [];
  private nextNo = 100;
  add(narration: string, entries: [string, number][], date = "2026-08-31") {
    this.vouchers.push(voucher(entries, { number: String(this.nextNo++), narration, date, guid: `G${this.nextNo}` }));
  }
  async post(xml: string): Promise<string> {
    if (this.offline) throw new TallyOfflineError();
    if (xml.includes("<ID>PWTCur</ID>")) return `<ENVELOPE><COMPANY NAME="x"><PWTCURCO TYPE="String">${this.active}</PWTCURCO></COMPANY></ENVELOPE>`;
    if (xml.includes("<ID>PWTDel</ID>")) {
      const narr = /\$Narration = "([^"]*)"/.exec(xml)![1];
      const d = /<SVFROMDATE>(\d{8})/.exec(xml)![1];
      const hits = this.vouchers.filter((v) => v.narration === narr && v.date.replace(/-/g, "") === d);
      return `<ENVELOPE><DATA><COLLECTION>${hits.map((v) =>
        `<VOUCHER REMOTEID="${v.guid}"><DATE TYPE="Date">${v.date.replace(/-/g, "")}</DATE><GUID>${v.guid}</GUID><NARRATION>${v.narration}</NARRATION><VOUCHERTYPENAME>${v.type}</VOUCHERTYPENAME><VOUCHERNUMBER>${v.number}</VOUCHERNUMBER><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>` +
        v.entries.map((e) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${e.ledger}</LEDGERNAME><AMOUNT>${e.amount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join("") + `</VOUCHER>`).join("")}</COLLECTION></DATA></ENVELOPE>`;
    }
    this.writes.push(xml);
    const resp = (c: number, a: number, d: number, e = 0) => `<RESPONSE><CREATED>${c}</CREATED><ALTERED>${a}</ALTERED><DELETED>${d}</DELETED><ERRORS>${e}</ERRORS></RESPONSE>`;
    const number = /TAGVALUE="([^"]*)"/.exec(xml)?.[1];
    if (xml.includes('ACTION="Delete"')) {
      if (this.rejectDelete) return resp(0, 0, 0, 1);
      this.vouchers = this.vouchers.filter((v) => v.number !== number);
      return resp(0, 0, 1);
    }
    if (xml.includes('ACTION="Alter"')) {
      if (this.rejectAlter) return resp(0, 0, 0, 1);
      const v = this.vouchers.find((x) => x.number === number)!;
      v.entries = [...xml.matchAll(/<LEDGERNAME>([^<]*)<\/LEDGERNAME><ISDEEMEDPOSITIVE>[^<]*<\/ISDEEMEDPOSITIVE><AMOUNT>([^<]*)<\/AMOUNT>/g)]
        .map((m) => ({ ledger: m[1], amount: Number(m[2]), parent: null }));
      return resp(0, 1, 0);
    }
    if (xml.includes('ACTION="Create"')) {
      const narr = /<NARRATION>([^<]*)<\/NARRATION>/.exec(xml)![1];
      const date = /<DATE>(\d{8})/.exec(xml)![1];
      this.add(narr, [...xml.matchAll(/<LEDGERNAME>([^<]*)<\/LEDGERNAME><ISDEEMEDPOSITIVE>[^<]*<\/ISDEEMEDPOSITIVE><AMOUNT>([^<]*)<\/AMOUNT>/g)].map((m) => [m[1], Number(m[2])] as [string, number]),
        `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`);
      return resp(1, 0, 0);
    }
    throw new Error("unexpected request");
  }
}

describe("applyDeletion against a simulated Tally (readback verified)", () => {
  it("single-expense voucher is deleted and verified gone", async () => {
    const t = new FakeTally();
    t.add("PWT PESO/08/02", [[X, -100], [A, 100]]);
    t.add("PWT PESO/08/03", [[X, -999], [B, 999]]);               // an unrelated voucher
    const r = await applyDeletion(job(), t);
    expect(r).toMatchObject({ outcome: "completed", correction: "delete_voucher" });
    expect(t.vouchers.map((v) => v.narration)).toEqual(["PWT PESO/08/03"]);   // only the target went; the other is untouched
  });
  it("grouped voucher: only this expense's amount is removed; others unaffected", async () => {
    const t = new FakeTally();
    t.add("PWT PESO/08/02", [[X, -350], [A, 150], [B, 200]]);
    const r = await applyDeletion(job({ amount: 50, known_total: 350, siblings: 2 }), t);
    expect(r).toMatchObject({ outcome: "completed", correction: "alter_voucher" });
    expect(t.vouchers[0].entries).toEqual([{ ledger: X, amount: -300, parent: null }, { ledger: A, amount: 100, parent: null }, { ledger: B, amount: 200, parent: null }]);
    expect(t.vouchers[0].narration).toBe("PWT PESO/08/02");
  });
  it("repeating a finished job changes nothing (no duplicate deletion or reversal)", async () => {
    const t = new FakeTally();
    t.add("PWT PESO/08/02", [[X, -350], [A, 150], [B, 200]]);
    const j = job({ amount: 50, known_total: 350, siblings: 2 });
    await applyDeletion(j, t);
    const writes = t.writes.length;
    expect((await applyDeletion(j, t)).correction).toBe("alter_voucher");
    expect(t.writes.length).toBe(writes);
    const lone = new FakeTally();
    lone.add("PWT PESO/08/02", [[X, -100], [A, 100]]);
    await applyDeletion(job(), lone);
    expect(await applyDeletion(job(), lone)).toMatchObject({ outcome: "completed", correction: "already_gone" });
    expect(lone.writes.length).toBe(1);
  });
  it("Tally refuses the alter -> a compensating reversal is posted once, the original untouched", async () => {
    const t = new FakeTally();
    t.rejectAlter = true;
    t.add("PWT PESO/08/02", [[X, -350], [A, 150], [B, 200]]);
    const j = job({ amount: 50, known_total: 350, siblings: 2 });
    expect(await applyDeletion(j, t)).toMatchObject({ outcome: "completed", correction: "reversal_voucher" });
    expect(t.vouchers.find((v) => v.narration === "PWT PESO/08/02")!.entries).toHaveLength(3);
    const rev = t.vouchers.find((v) => v.narration === reversalNarration(j))!;
    expect(rev.entries.map((e) => [e.ledger, e.amount])).toEqual([[X, 50], [A, -50]]);
    await applyDeletion({ ...j, force_reversal: true }, t);
    expect(t.vouchers.filter((v) => v.narration === reversalNarration(j))).toHaveLength(1);
  });
  it("Tally refuses the delete -> reversal; with unknown ledgers -> blocked", async () => {
    const t = new FakeTally();
    t.rejectDelete = true;
    t.add("PWT PESO/08/02", [[X, -100], [A, 100]]);
    expect((await applyDeletion(job(), t)).correction).toBe("reversal_voucher");
    const u = new FakeTally();
    u.rejectDelete = true;
    u.add("PWT PESO/08/02", [[X, -100], [A, 100]]);
    expect((await applyDeletion(job({ employee_ledger: null, expense_ledger: null }), u)).outcome).toBe("blocked");
    expect(u.vouchers).toHaveLength(1);
  });
  it("a voucher changed outside PesoWise is blocked and not touched", async () => {
    const t = new FakeTally();
    t.add("PWT PESO/08/02", [[X, -90], [A, 90]]);
    expect((await applyDeletion(job(), t)).outcome).toBe("blocked");
    expect(t.writes).toEqual([]);
  });
});

describe("runDeletionJob (acknowledgements)", () => {
  const api = () => { const calls: Record<string, unknown>[] = []; return { calls, call: async (b: Record<string, unknown>) => { calls.push(b); return {} as never; } }; };

  it("reports a verified correction to the backend", async () => {
    const t = new FakeTally(); t.add("PWT PESO/08/02", [[X, -100], [A, 100]]);
    const a = api();
    await runDeletionJob(job(), t, a);
    expect(a.calls).toEqual([{ action: "ack", job_id: "11111111-aaaa", outcome: "completed", correction: "delete_voucher", error: null, result: { tally_voucher_number: "100", offline: false } }]);
  });
  it("Tally closed: job is retried later without using an attempt, nothing written", async () => {
    const t = new FakeTally(); t.offline = true;
    const a = api();
    const r = await runDeletionJob(job(), t, a);
    expect(r.outcome).toBe("retry");
    expect(a.calls[0]).toMatchObject({ outcome: "retry", result: { offline: true } });
    expect(t.writes).toEqual([]);
  });
  it("wrong active company: nothing is read or changed, retried without using an attempt", async () => {
    const t = new FakeTally(); t.active = "Real Company Ltd";
    t.add("PWT PESO/08/02", [[X, -100], [A, 100]]);
    const a = api();
    await runDeletionJob(job(), t, a);
    expect(a.calls[0]).toMatchObject({ outcome: "retry", result: { offline: true } });
    expect(String(a.calls[0].error)).toMatch(/Real Company Ltd/);
    expect(t.vouchers).toHaveLength(1);
  });
  it("a failed acknowledgement never throws (the lease expires and the job is offered again)", async () => {
    const t = new FakeTally(); t.add("PWT PESO/08/02", [[X, -100], [A, 100]]);
    await expect(runDeletionJob(job(), t, { call: async () => { throw new Error("network"); } })).resolves.toMatchObject({ outcome: "completed" });
  });
});
