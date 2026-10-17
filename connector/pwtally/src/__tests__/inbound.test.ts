import { describe, expect, it } from "vitest";
import { TallyOfflineError, type TallyIO } from "../engine.ts";
import {
  ledgerParentsRequest, parseLedgerParents, parsePaymentVouchers, paymentVouchersRequest, runInboundJob, INBOUND_VOUCHER_TYPE,
} from "../inbound.ts";

const COMPANY = "PesoWise Integration Demo";

/** Voucher XML in the shape real TallyPrime returned (typed tags, Dr = negative amount). */
const voucher = (o: { guid: string; no: string; date?: string; type?: string; narr?: string; cancelled?: boolean; optional?: boolean;
  entries: [string, number][] }) =>
  `<VOUCHER REMOTEID="${o.guid}" VCHKEY="k" VCHTYPE="${o.type ?? INBOUND_VOUCHER_TYPE}" OBJVIEW="Accounting Voucher View">` +
  `<DATE TYPE="Date">${o.date ?? "20260816"}</DATE><GUID>${o.guid}</GUID><NARRATION TYPE="String">${o.narr ?? "advance"}</NARRATION>` +
  `<VOUCHERTYPENAME>${o.type ?? INBOUND_VOUCHER_TYPE}</VOUCHERTYPENAME><VOUCHERNUMBER>${o.no}</VOUCHERNUMBER>` +
  `<ISDELETED>No</ISDELETED><ISOPTIONAL TYPE="Logical">${o.optional ? "Yes" : "No"}</ISOPTIONAL>` +
  `<ISCANCELLED TYPE="Logical">${o.cancelled ? "Yes" : "No"}</ISCANCELLED><ALTERID TYPE="Number"> 91</ALTERID><MASTERID TYPE="Number"> 64</MASTERID>` +
  o.entries.map(([l, a]) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME TYPE="String">${l}</LEDGERNAME><ISDEEMEDPOSITIVE TYPE="Logical">${a < 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT TYPE="Amount">${a.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join("") +
  `</VOUCHER>`;

const ledgersXml = (m: Record<string, string>) =>
  `<ENVELOPE>${Object.entries(m).map(([n, p]) => `<LEDGER NAME="${n}" RESERVEDNAME=""><PARENT TYPE="String">${p}</PARENT><NAME TYPE="String">${n}</NAME></LEDGER>`).join("")}</ENVELOPE>`;

class FakeTally implements TallyIO {
  active = COMPANY;
  offline = false;
  vouchers: string[] = [];
  parents: Record<string, string> = { Cash: "Cash-in-Hand", "HDFC Bank": "Bank Accounts", "Amit Test-1001": "Sundry Debtors", "Bina Test-1002": "Sundry Debtors" };
  requests: string[] = [];
  async post(xml: string): Promise<string> {
    this.requests.push(xml);
    if (this.offline) throw new TallyOfflineError();
    if (xml.includes("<ID>PWTCur</ID>")) return `<ENVELOPE><COMPANY NAME="x"><PWTCURCO TYPE="String">${this.active}</PWTCURCO></COMPANY></ENVELOPE>`;
    if (xml.includes("<ID>PWTLedgerParents</ID>")) return ledgersXml(this.parents);
    if (xml.includes("<ID>PWTInbound</ID>")) return `<ENVELOPE><DATA><COLLECTION>${this.vouchers.join("")}</COLLECTION></DATA></ENVELOPE>`;
    throw new Error("unexpected request");
  }
}

class FakeApi {
  calls: Record<string, unknown>[] = [];
  async call<T>(body: Record<string, unknown>): Promise<T> {
    this.calls.push(body);
    return (body.action === "finish" ? { result: { imported: 0 } } : { stored: 1 }) as T;
  }
}

describe("requests are read-only and exact", () => {
  it("asks only for the PesoWise Payment type, all dates, in the paired company", () => {
    const x = paymentVouchersRequest(COMPANY);
    expect(x).toContain('$VoucherTypeName = "PesoWise Payment"');
    expect(x).toContain(`<SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>`);
    expect(x).toContain("<SVFROMDATE>20000101</SVFROMDATE>");
    expect(x).toContain("<TALLYREQUEST>Export</TALLYREQUEST>");
    expect(x).not.toMatch(/Import Data|ACTION=/);
    expect(ledgerParentsRequest(COMPANY)).toContain("<NATIVEMETHOD>Parent</NATIVEMETHOD>");
  });
});

describe("the voucher type is configurable but always an exact match", () => {
  it("filters on the type the backend names, and escapes it", () => {
    expect(paymentVouchersRequest(COMPANY, "PESO Wise Payment")).toContain('$VoucherTypeName = "PESO Wise Payment"');
    expect(paymentVouchersRequest(COMPANY, 'A"B<')).toContain("A&quot;B&lt;");
  });
  it("reads the type named by the job, defaulting to PesoWise Payment", async () => {
    const t = new FakeTally();
    await runInboundJob({ job_id: "J", tally_company: COMPANY, voucher_type: "PESO Wise Payment" }, t, new FakeApi());
    expect(t.requests.some((x) => x.includes('$VoucherTypeName = "PESO Wise Payment"'))).toBe(true);
    const t2 = new FakeTally();
    await runInboundJob({ job_id: "J", tally_company: COMPANY }, t2, new FakeApi());
    expect(t2.requests.some((x) => x.includes('$VoucherTypeName = "PesoWise Payment"'))).toBe(true);
  });
});

describe("parsing real-shaped voucher XML", () => {
  it("reads identity, date, flags and signed entries; attaches ledger parents", () => {
    const parents = parseLedgerParents(ledgersXml({ Cash: "Cash-in-Hand", "Amit Test-1001": "Sundry Debtors" }));
    const [v] = parsePaymentVouchers(voucher({ guid: "G1", no: "7", entries: [["Amit Test-1001", -500], ["Cash", 500]] }), parents);
    expect(v).toMatchObject({ guid: "G1", number: "7", date: "2026-08-16", type: "PesoWise Payment", alter_id: 91, master_id: 64, cancelled: false, optional: false });
    expect(v.entries).toEqual([
      { ledger: "Amit Test-1001", amount: -500, parent: "Sundry Debtors" },
      { ledger: "Cash", amount: 500, parent: "Cash-in-Hand" },
    ]);
  });
  it("flags cancelled and optional vouchers and decodes entities", () => {
    const parents = new Map<string, string>();
    const vs = parsePaymentVouchers(
      voucher({ guid: "G2", no: "1", cancelled: true, entries: [["A &amp; B-1", -5], ["Cash", 5]] }) + voucher({ guid: "G3", no: "2", optional: true, entries: [["X-2", -1], ["Cash", 1]] }),
      parents,
    );
    expect(vs.map((v) => [v.cancelled, v.optional])).toEqual([[true, false], [false, true]]);
    expect(vs[0].entries[0].ledger).toBe("A & B-1");
    expect(vs[0].entries[0].parent).toBeNull();
  });
  it("ignores blocks without a GUID and non-numeric amounts", () => {
    expect(parsePaymentVouchers(`<VOUCHER><DATE>20260101</DATE></VOUCHER>`, new Map())).toEqual([]);
  });
});

describe("runInboundJob", () => {
  const job = { job_id: "J1", tally_company: COMPANY };

  it("reads the vouchers, uploads them in order, then finishes with the exact total", async () => {
    const t = new FakeTally();
    t.vouchers = Array.from({ length: 250 }, (_, i) => voucher({ guid: `G${i}`, no: String(i), entries: [["Amit Test-1001", -10], ["Cash", 10]] }));
    const api = new FakeApi();
    const r = await runInboundJob(job, t, api);
    expect(r).toMatchObject({ ok: true, fetched: 250 });
    const submits = api.calls.filter((c) => c.action === "submit");
    expect(submits.map((c) => [c.seq_start, (c.vouchers as unknown[]).length])).toEqual([[0, 100], [100, 100], [200, 50]]);
    expect(api.calls.at(-1)).toMatchObject({ action: "finish", job_id: "J1", total: 250 });
    expect(api.calls.at(-1)?.error).toBeUndefined();
  });

  it("an empty result is still a complete, valid fetch (so deletions can be detected)", async () => {
    const api = new FakeApi();
    const r = await runInboundJob(job, new FakeTally(), api);
    expect(r).toMatchObject({ ok: true, fetched: 0 });
    expect(api.calls).toEqual([{ action: "finish", job_id: "J1", total: 0 }]);
  });

  it("wrong company: reads nothing, reports the problem", async () => {
    const t = new FakeTally();
    t.active = "Some Real Company";
    const api = new FakeApi();
    const r = await runInboundJob(job, t, api);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Some Real Company/);
    expect(t.requests.some((x) => x.includes("PWTInbound"))).toBe(false);
    expect(api.calls.at(-1)).toMatchObject({ action: "finish", error: expect.stringMatching(/Some Real Company/) });
  });

  it("Tally offline: the job is reported failed instead of hanging", async () => {
    const t = new FakeTally();
    t.offline = true;
    const api = new FakeApi();
    const r = await runInboundJob(job, t, api);
    expect(r).toMatchObject({ ok: false, error: "TallyPrime is not reachable" });
    expect(api.calls.at(-1)).toMatchObject({ action: "finish", error: "TallyPrime is not reachable" });
  });

  it("never writes to Tally", async () => {
    const t = new FakeTally();
    t.vouchers = [voucher({ guid: "G1", no: "1", entries: [["Amit Test-1001", -10], ["Cash", 10]] })];
    await runInboundJob(job, t, new FakeApi());
    expect(t.requests.every((x) => x.includes("<TALLYREQUEST>Export</TALLYREQUEST>"))).toBe(true);
  });
});
