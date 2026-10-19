import { describe, expect, it } from "vitest";
import type { TallyIO } from "../engine.ts";
import { createVoucherTypeXml, ensurePaymentVoucherType, parseVoucherTypes, voucherTypesRequest } from "../voucherType.ts";

const COMPANY = "Demo Co";
const typesXml = (m: Record<string, string>) =>
  `<ENVELOPE>${Object.entries(m).map(([n, p]) => `<VOUCHERTYPE NAME="${n}" RESERVEDNAME=""><PARENT TYPE="String">${p}</PARENT><NAME TYPE="String">${n}</NAME></VOUCHERTYPE>`).join("")}</ENVELOPE>`;

class FakeTally implements TallyIO {
  active = COMPANY;
  types: Record<string, string> = { Payment: "", Receipt: "", Journal: "" };
  rejectCreate = false;
  writes: string[] = [];
  async post(xml: string): Promise<string> {
    if (xml.includes("<ID>PWTCur</ID>")) return `<ENVELOPE><COMPANY NAME="x"><PWTCURCO TYPE="String">${this.active}</PWTCURCO></COMPANY></ENVELOPE>`;
    if (xml.includes("<ID>PWTVchTypes</ID>")) return typesXml(this.types);
    this.writes.push(xml);
    if (this.rejectCreate) return `<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>nope</LINEERROR></RESPONSE>`;
    this.types[/NAME="([^"]*)" ACTION="Create"/.exec(xml)![1]] = /<PARENT>([^<]*)</.exec(xml)![1];
    return `<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS></RESPONSE>`;
  }
}

describe("payment voucher type is created automatically", () => {
  it("creates a missing type as a Payment voucher type and verifies it", async () => {
    const t = new FakeTally();
    expect(await ensurePaymentVoucherType(t, COMPANY, "PesoWise Payment")).toEqual({ ok: true, state: "created" });
    expect(t.types["PesoWise Payment"]).toBe("Payment");
    expect(t.writes).toHaveLength(1);
  });
  it("does nothing when it already exists (and never changes it)", async () => {
    const t = new FakeTally();
    t.types["PESO Wise Payment"] = "Payment";
    expect(await ensurePaymentVoucherType(t, COMPANY, "PESO Wise Payment")).toEqual({ ok: true, state: "exists" });
    expect(t.writes).toEqual([]);
  });
  it("leaves an existing type alone if it is not a Payment type", async () => {
    const t = new FakeTally();
    t.types["PesoWise Payment"] = "Receipt";
    const r = await ensurePaymentVoucherType(t, COMPANY, "PesoWise Payment");
    expect(r.ok).toBe(false);
    expect(t.writes).toEqual([]);
  });
  it("never writes to a company other than the paired one", async () => {
    const t = new FakeTally();
    t.active = "Real Books Ltd";
    expect((await ensurePaymentVoucherType(t, COMPANY, "PesoWise Payment")).ok).toBe(false);
    expect(t.writes).toEqual([]);
  });
  it("reports Tally rejecting it instead of pretending", async () => {
    const t = new FakeTally();
    t.rejectCreate = true;
    const r = await ensurePaymentVoucherType(t, COMPANY, "PesoWise Payment");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/rejected/);
  });
  it("uses exact, escaped names and an empty name does nothing", async () => {
    expect(createVoucherTypeXml(COMPANY, 'A"B')).toContain('NAME="A&quot;B" ACTION="Create"');
    expect(createVoucherTypeXml(COMPANY, "X")).toContain("<PARENT>Payment</PARENT>");
    expect(voucherTypesRequest(COMPANY)).toContain("<TALLYREQUEST>Export</TALLYREQUEST>");
    expect(parseVoucherTypes(typesXml({ "A &amp; B": "Payment" })).get("A & B")).toBe("Payment");
    expect((await ensurePaymentVoucherType(new FakeTally(), COMPANY, "  ")).ok).toBe(false);
  });
});
