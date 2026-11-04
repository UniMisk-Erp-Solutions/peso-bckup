import { describe, expect, it } from "vitest";
import { billRequiredMessage, isBillRequired } from "@/lib/attachmentRequirement";
import { decideAfterResolve, isSubmittedStatus, newClientSubmissionId, shouldRunSubmit } from "@/lib/submitAttemptReuse";

/**
 * Server model = the SQL in 20261026 (identity) + 20261028 (bill trigger). The SQL itself is proven
 * in supabase/tests/{draft_incident,bill_invariant}; this suite proves the CLIENT FLOW against that
 * contract: a bill refusal never creates a second row and the retry reuses the same logical id.
 */
function server(threshold = 499) {
  type Row = { id: string; status: string; amount: number };
  const rows = new Map<string, Row>();
  const byLogical = new Map<string, string>();
  const attachments: { expenseId: string; deleted: boolean }[] = [];
  let seq = 0;
  let audit = 0;
  const resolve = (csid: string, amount: number) => {
    if (!byLogical.has(csid)) {
      const id = `exp-${++seq}`;
      rows.set(id, { id, status: "draft", amount });
      byLogical.set(csid, id);
      audit += 1;
    }
    const r = rows.get(byLogical.get(csid)!)!;
    if (r.status === "draft") r.amount = amount;
    return { expenseId: r.id, status: r.status };
  };
  const attach = (expenseId: string) => attachments.push({ expenseId, deleted: false });
  const removeBills = (expenseId: string) => attachments.filter((a) => a.expenseId === expenseId).forEach((a) => (a.deleted = true));
  const submit = (expenseId: string) => {
    const r = rows.get(expenseId)!;
    // the deferred trigger: refuses, and the transaction (the status change) is rolled back
    if (isBillRequired(r.amount, threshold) && !attachments.some((a) => a.expenseId === expenseId && !a.deleted)) {
      throw Object.assign(new Error(billRequiredMessage(threshold)), { code: "23514", hint: "attachment_required" });
    }
    r.status = "submitted";
  };
  return { rows, resolve, attach, removeBills, submit, audit: () => audit, byLogical };
}

function press(srv: ReturnType<typeof server>, csid: string, amount: number, opts: { lostResponse?: boolean } = {}) {
  const r = srv.resolve(csid, amount);
  if (decideAfterResolve({ status: r.status }) === "proceed" && shouldRunSubmit(r.status)) {
    srv.submit(r.expenseId);
    if (opts.lostResponse) throw new Error("Failed to fetch");
  }
  if (!isSubmittedStatus(srv.rows.get(r.expenseId)!.status)) throw new Error("still a draft");
  return r;
}

describe("single expense, threshold 499", () => {
  it("amount 800 without a bill is refused with the dynamic message and leaves ONE canonical draft", () => {
    const srv = server();
    const csid = newClientSubmissionId();
    expect(() => press(srv, csid, 800)).toThrow("Bill photos are required for expenses above ₹499.");
    expect(srv.rows.size).toBe(1);
    expect([...srv.rows.values()][0].status).toBe("draft");
  });

  it("5 refused retries still leave one row; adding the bill then submits the SAME id (draft -> add bill -> submit)", () => {
    const srv = server();
    const csid = newClientSubmissionId();
    for (let i = 0; i < 5; i++) expect(() => press(srv, csid, 800)).toThrow();
    const id = [...srv.rows.keys()][0];
    srv.attach(id);
    const r = press(srv, csid, 800);
    expect(r.expenseId).toBe(id);
    expect(srv.rows.size).toBe(1);
    expect(srv.audit()).toBe(1);
  });

  it("the incident: bill added, then removed by the user, then submitted -> refused (a deleted bill does not count)", () => {
    const srv = server();
    const csid = newClientSubmissionId();
    expect(() => press(srv, csid, 800)).toThrow();
    const id = [...srv.rows.keys()][0];
    srv.attach(id);
    srv.removeBills(id);
    expect(() => press(srv, csid, 800)).toThrow(/Bill photos are required/);
    expect(srv.rows.get(id)!.status).toBe("draft");
  });

  it("another expense's bill does not satisfy the rule", () => {
    const srv = server();
    const a = srv.resolve(newClientSubmissionId(), 800);
    srv.attach(a.expenseId);
    const csidB = newClientSubmissionId();
    expect(() => press(srv, csidB, 800)).toThrow();
  });

  it("amount at or below the threshold needs no bill (499, 499.00, 100)", () => {
    const srv = server();
    for (const amt of [499, 499.0, 100]) expect(press(srv, newClientSubmissionId(), amt).expenseId).toBeTruthy();
    expect(() => press(srv, newClientSubmissionId(), 499.01)).toThrow();
  });

  it("lost response after a bill-valid submit: the retry returns the same expense, nothing is submitted twice", () => {
    const srv = server();
    const csid = newClientSubmissionId();
    const first = srv.resolve(csid, 800);
    srv.attach(first.expenseId);
    expect(() => press(srv, csid, 800, { lostResponse: true })).toThrow(/fetch/);
    const again = press(srv, csid, 800);
    expect(again.expenseId).toBe(first.expenseId);
    expect(srv.rows.size).toBe(1);
    expect(srv.audit()).toBe(1);
  });

  it("browser restart: only the logical id survives, the retry still lands on the same row after the bill is added", () => {
    const srv = server();
    const csid = newClientSubmissionId();
    expect(() => press(srv, csid, 800)).toThrow();
    // new JS context, same recovered logical id; user attaches a bill in the restored form
    srv.attach([...srv.rows.keys()][0]);
    press(srv, csid, 800);
    expect(srv.rows.size).toBe(1);
  });

  it("withdrawal -> resubmit obeys the same rule on the same id", () => {
    const srv = server();
    const csid = newClientSubmissionId();
    const r = srv.resolve(csid, 800);
    srv.attach(r.expenseId);
    press(srv, csid, 800);
    srv.rows.get(r.expenseId)!.status = "draft"; // withdrawn
    srv.removeBills(r.expenseId);
    expect(() => press(srv, csid, 800)).toThrow(/Bill photos are required/);
    srv.attach(r.expenseId);
    expect(press(srv, csid, 800).expenseId).toBe(r.expenseId);
    expect(srv.rows.size).toBe(1);
  });
});
