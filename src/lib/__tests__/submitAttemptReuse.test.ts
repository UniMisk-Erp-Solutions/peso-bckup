import { describe, expect, it, vi } from "vitest";
import { decideAfterResolve, isSubmittedStatus, newClientSubmissionId, shouldRunSubmit } from "@/lib/submitAttemptReuse";
import { friendlySubmitFailureMessage } from "@/lib/submitFailureMessages";

/**
 * A faithful in-memory model of the SERVER side (resolve_or_create_expense_v1 + the unique index
 * on (organization_id, user_id, client_submission_id)) plus the legacy submit step. The client
 * under test holds NO row id and uses NO sessionStorage: its only memory is the logical id.
 */
function fakeServer() {
  type Row = { id: string; status: string; title: string; org: string; user: string; csid: string };
  const rows = new Map<string, Row>();
  const index = new Map<string, string>(); // `${org}|${user}|${csid}` -> row id  (the UNIQUE index)
  let seq = 0;
  let audit = 0;
  const resolve = vi.fn(async (org: string, user: string, csid: string, title: string) => {
    const key = `${org}|${user}|${csid}`;
    await Promise.resolve(); // yield: lets a concurrent request interleave between check and insert
    let created = false;
    if (!index.has(key)) {
      // INSERT ... ON CONFLICT DO NOTHING: the loser of a race inserts nothing
      if (!index.has(key)) {
        const id = `exp-${++seq}`;
        rows.set(id, { id, status: "draft", title, org, user, csid });
        index.set(key, id);
        created = true;
        audit += 1;
      }
    }
    const row = rows.get(index.get(key)!)!;
    if (!created && row.status === "draft") row.title = title; // replay refreshes a live draft
    return { expenseId: row.id, status: row.status, created, idempotentReplay: !created, inRecycleBin: false };
  });
  const submit = vi.fn(async (id: string) => {
    rows.get(id)!.status = "submitted";
  });
  return { rows, resolve, submit, auditCount: () => audit };
}

type Browser = { csid: string };

/** One press of Submit, exactly as ExpenseForm does it. */
async function press(
  srv: ReturnType<typeof fakeServer>,
  b: Browser,
  who: { org: string; user: string },
  opts: { failBeforeCommit?: boolean; lostResponse?: boolean; invalid?: boolean; title?: string } = {},
) {
  if (opts.invalid) throw new Error("Required fields are missing: Project Unique ID. Nothing was submitted."); // preflight
  const r = await srv.resolve(who.org, who.user, b.csid, opts.title ?? "t");
  const decision = decideAfterResolve({ status: r.status });
  if (decision === "proceed" && shouldRunSubmit(r.status)) {
    if (opts.failBeforeCommit) throw new Error("boom before commit");
    await srv.submit(r.expenseId);
    if (opts.lostResponse) throw new Error("Failed to fetch"); // committed, but the browser never heard
  }
  if (!isSubmittedStatus(srv.rows.get(r.expenseId)!.status)) throw new Error("still a draft");
  b.csid = newClientSubmissionId(); // success: the next Submit is a new logical expense
  return r;
}

const W = { org: "o1", user: "u1" };

describe("server-side identity: one logical submission = one row, with NO browser row memory", () => {
  it("first submit: one row, submitted, one audit row", async () => {
    const srv = fakeServer();
    await press(srv, { csid: "K" }, W);
    expect([...srv.rows.values()].map((r) => r.status)).toEqual(["submitted"]);
    expect(srv.auditCount()).toBe(1);
  });

  it("5 failed retries then success: still ONE row", async () => {
    const srv = fakeServer();
    const b = { csid: "K" };
    for (let i = 0; i < 5; i++) await expect(press(srv, b, W, { failBeforeCommit: true })).rejects.toThrow();
    await press(srv, b, W);
    expect(srv.rows.size).toBe(1);
    expect(srv.auditCount()).toBe(1);
  });

  it("browser restart: sessionStorage gone AND in-memory state gone, only the recovered form's logical id remains", async () => {
    const srv = fakeServer();
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("cleared"); }, setItem: () => { throw new Error("cleared"); }, removeItem: () => {} });
    try {
      await expect(press(srv, { csid: "K" }, W, { failBeforeCommit: true })).rejects.toThrow();
      // brand-new JS context: a new object, same logical id restored from the durable form draft
      await press(srv, { csid: "K" }, W);
      expect(srv.rows.size).toBe(1);
      expect([...srv.rows.values()][0].status).toBe("submitted");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lost HTTP response after commit + all browser state cleared: same row, submitted once, no duplicate audit", async () => {
    const srv = fakeServer();
    await expect(press(srv, { csid: "K" }, W, { lostResponse: true })).rejects.toThrow(/fetch/);
    const again = await press(srv, { csid: "K" }, W); // fresh context, only the logical id
    expect(again.idempotentReplay).toBe(true);
    expect(srv.rows.size).toBe(1);
    expect(srv.submit).toHaveBeenCalledTimes(1);
    expect(srv.auditCount()).toBe(1);
  });

  it("two concurrent presses with the same logical id: ONE row", async () => {
    const srv = fakeServer();
    const [a, b] = await Promise.all([srv.resolve("o1", "u1", "K", "x"), srv.resolve("o1", "u1", "K", "x")]);
    expect(a.expenseId).toBe(b.expenseId);
    expect(srv.rows.size).toBe(1);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it("double click: both presses resolve to the same row, the row is submitted once", async () => {
    const srv = fakeServer();
    const b = { csid: "K" };
    const r1 = await srv.resolve(W.org, W.user, b.csid, "t");
    await srv.submit(r1.expenseId);
    const r2 = await srv.resolve(W.org, W.user, b.csid, "t");
    expect(r2.expenseId).toBe(r1.expenseId);
    expect(decideAfterResolve({ status: r2.status })).toBe("already_past_draft");
    expect(srv.submit).toHaveBeenCalledTimes(1);
  });

  it("required-field rejection happens BEFORE any row; the retry after fixing creates exactly one", async () => {
    const srv = fakeServer();
    const b = { csid: "K" };
    await expect(press(srv, b, W, { invalid: true })).rejects.toThrow(/Required fields/);
    expect(srv.rows.size).toBe(0);
    await press(srv, b, W);
    expect(srv.rows.size).toBe(1);
  });

  it("auth refresh between resolve and submit: the retry with the same logical id lands on the same row", async () => {
    const srv = fakeServer();
    const b = { csid: "K" };
    await expect(press(srv, b, W, { failBeforeCommit: true })).rejects.toThrow(); // 401 on submit
    expect(friendlySubmitFailureMessage(new Error("JWT expired"), { draftPreserved: true })).toMatch(/sign in again.*preserved/i);
    await press(srv, b, W);
    expect(srv.rows.size).toBe(1);
  });

  it("another USER with the same logical id gets a different row; another ORG too", async () => {
    const srv = fakeServer();
    const a = await srv.resolve("o1", "u1", "K", "a");
    const b = await srv.resolve("o1", "u2", "K", "b");
    const c = await srv.resolve("o2", "u1", "K", "c");
    expect(new Set([a.expenseId, b.expenseId, c.expenseId]).size).toBe(3);
    expect(srv.rows.get(a.expenseId)!.title).toBe("a"); // never overwritten by the others
  });

  it("a TRULY new blank form (no recovered id) is a new logical expense: no fuzzy merge with an old row", async () => {
    const srv = fakeServer();
    await expect(press(srv, { csid: newClientSubmissionId() }, W, { failBeforeCommit: true, title: "Taxi" })).rejects.toThrow();
    await press(srv, { csid: newClientSubmissionId() }, W, { title: "Taxi" }); // same content, different logical id
    expect(srv.rows.size).toBe(2);
  });

  it("withdrawal -> edit -> resubmit: the withdrawn row (back to draft) is reused via its own id", async () => {
    const srv = fakeServer();
    const first = await srv.resolve("o1", "u1", "K", "t");
    await srv.submit(first.expenseId);
    srv.rows.get(first.expenseId)!.status = "draft"; // user withdraws it
    const again = await srv.resolve("o1", "u1", "K", "t edited");
    expect(again.expenseId).toBe(first.expenseId);
    expect(srv.rows.get(first.expenseId)!.title).toBe("t edited");
    expect(srv.rows.size).toBe(1);
  });

  it("save draft keeps the logical id: draft then later submit is the same row", async () => {
    const srv = fakeServer();
    const draft = await srv.resolve("o1", "u1", "K", "draft v1"); // Save Draft
    const later = await srv.resolve("o1", "u1", "K", "final");   // later Submit with the same id
    expect(later.expenseId).toBe(draft.expenseId);
    expect(srv.rows.size).toBe(1);
  });
});

describe("decisions on the server answer", () => {
  it("maps statuses to what the form must do", () => {
    expect(decideAfterResolve({ status: "draft" })).toBe("proceed");
    expect(decideAfterResolve({ status: "rejected" })).toBe("proceed");
    expect(decideAfterResolve({ status: "submitted" })).toBe("already_past_draft");
    expect(decideAfterResolve({ status: "level_2_verified" })).toBe("already_past_draft");
    expect(decideAfterResolve({ status: "draft", inRecycleBin: true })).toBe("recycled");
    expect(shouldRunSubmit("draft")).toBe(true);
    expect(shouldRunSubmit("submitted")).toBe(false);
    expect(isSubmittedStatus("draft")).toBe(false);
    expect(isSubmittedStatus("submitted")).toBe(true);
  });
  it("ids are random UUIDs", () => {
    expect(newClientSubmissionId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(newClientSubmissionId()).not.toBe(newClientSubmissionId());
  });
});

describe("failure wording", () => {
  it("says the draft was preserved and never shows raw database text", () => {
    expect(friendlySubmitFailureMessage(new Error("Failed to fetch"), { draftPreserved: true })).toMatch(/preserved/);
    expect(friendlySubmitFailureMessage(new Error("duplicate key value violates unique constraint"), { draftPreserved: true })).toBeNull();
  });
  it("required-field rejection is explained", () => {
    expect(
      friendlySubmitFailureMessage(new Error("Cannot submit: required additional field(s) missing: X"), { draftPreserved: false }),
    ).toMatch(/required fields are missing/i);
  });
});
